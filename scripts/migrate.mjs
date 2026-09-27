/**
 * Applies the OMS's new schema changes (drizzle/NNNN_*.sql) to one database, once each.
 *
 *   node scripts/migrate.mjs             the database in DATABASE_URL
 *   node scripts/migrate.mjs --dry-run   list what would run, change nothing
 *   node scripts/migrate.mjs --vercel    the same, but only in a Vercel production build
 *
 * Nobody runs this by hand. Each side migrates its own copy, the way the API does:
 *   - the ThinkPad: the `oms-migrate` service (infra/compose.yml), before a new OMS starts;
 *   - the cloud copy: Vercel's production build (vercel.json), before the fallback's new
 *     code goes live. A failure stops that deploy and the old one keeps serving.
 *
 * What ran is kept per database in `oms_meta.migrations`: outside `public`, so the sync
 * never copies one side's record to the other, and `db:push` never sees it.
 *
 * Plain JavaScript on purpose: it runs in the slim runtime image, which has no tsx.
 *
 * Writing a new file: additive only (new tables, nullable or defaulted columns), since for
 * a few minutes one side has it and the other doesn't; split statements with drizzle's
 * `--> statement-breakpoint`. A statement that finds its table, column, index or constraint
 * already there is skipped, so a file that was applied by hand runs cleanly.
 */
import { readdirSync, readFileSync } from "node:fs";

import pg from "pg";

/**
 * Everything up to here was applied by hand (db:push, then infra/oms-schema.sh) before this
 * runner existed. Where the record is new, these count as done.
 */
const BASELINE = "0005_reels.sql";

/** Postgres's "already exists" errors: the statement's work is already done. */
const ALREADY = new Set([
  "42P07", // duplicate_table (and index, sequence, view)
  "42701", // duplicate_column
  "42710", // duplicate_object (constraint, type, trigger)
  "42P06", // duplicate_schema
  "42723", // duplicate_function
]);

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

if (args.has("--vercel") && process.env.VERCEL_ENV !== "production") {
  console.log(`migrate: skipped (Vercel ${process.env.VERCEL_ENV ?? "local"} build; only production migrates)`);
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("migrate: DATABASE_URL is not set");
  process.exit(1);
}

const dir = new URL("../drizzle/", import.meta.url);
const files = readdirSync(dir)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();

/** A file's statements, without the chunks that are only comments. */
function statements(file) {
  return readFileSync(new URL(file, dir), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.replace(/--[^\n]*/g, "").trim().length > 0);
}

const client = new pg.Client({ connectionString: url });
await client.connect();

/**
 * One transaction holding the runner's lock, so two deploys close together take turns. A
 * transaction lock, not a session one: behind a pooler (Supabase's, on Vercel) a session
 * lock can stay stuck to a pooled connection. A dry run rolls everything back.
 */
async function locked(work) {
  await client.query("begin");
  try {
    await client.query("select pg_advisory_xact_lock(hashtext('oms_meta.migrations'))");
    const result = await work();
    await client.query(dryRun ? "rollback" : "commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    throw e;
  }
}

try {
  const done = await locked(async () => {
    await client.query(`
      create schema if not exists oms_meta;
      create table if not exists oms_meta.migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);
    const names = new Set((await client.query("select name from oms_meta.migrations")).rows.map((r) => r.name));
    if (names.size > 0) return names;

    const { rows } = await client.query("select to_regclass('public.orders') is not null as filled");
    if (!rows[0].filled) {
      // drizzle/ isn't a full history (the early schema came from db:push), so an empty
      // database is built by the sync's bootstrap, or db:push, never from these files.
      throw new Error("the database is empty: bootstrap it first (infra/README.md)");
    }
    const base = files.filter((f) => f <= BASELINE);
    await client.query("insert into oms_meta.migrations (name) select unnest($1::text[]) on conflict do nothing", [base]);
    console.log(`migrate: first run here; ${base.length} earlier files count as applied`);
    return new Set(base);
  });

  const pending = files.filter((f) => !done.has(f));
  if (!pending.length) console.log("migrate: up to date");

  for (const file of pending) {
    const list = statements(file);
    if (dryRun) {
      console.log(`migrate: would apply ${file} (${list.length} statements)`);
      continue;
    }
    const skipped = await locked(async () => {
      // Another deploy may have applied it while this one waited for the lock.
      const seen = await client.query("select 1 from oms_meta.migrations where name = $1", [file]);
      if (seen.rowCount) return -1;
      let already = 0;
      for (const sql of list) {
        await client.query("savepoint s");
        try {
          await client.query(sql);
          await client.query("release savepoint s");
        } catch (e) {
          if (!ALREADY.has(e.code)) throw e;
          await client.query("rollback to savepoint s");
          already++;
        }
      }
      await client.query("insert into oms_meta.migrations (name) values ($1)", [file]);
      return already;
    }).catch((e) => {
      throw new Error(`${file}: ${e.message}`);
    });
    if (skipped < 0) console.log(`migrate: ${file} was applied meanwhile`);
    else console.log(`migrate: applied ${file}${skipped ? ` (${skipped} of ${list.length} already there)` : ""}`);
  }
} catch (e) {
  console.error(`migrate: failed, nothing from the failing file was kept. ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
