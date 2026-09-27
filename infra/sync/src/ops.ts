import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { hashRows, pkExpr, type Changeset } from "./apply.ts";
import type { PairConfig, Settings } from "./config.ts";
import { errText, lit, log, makePool, q, tx, type Client } from "./db.ts";
import { Halt, Pair } from "./pair.ts";
import { putFile } from "./s3.ts";
import { ensureTriggers, installBase, instanceId, loadMeta, uninstall, type Meta, type Table } from "./schema.ts";

/** Older than any real change, so a pending change on the target always wins over a reconcile. */
const EPOCH = 0n;

function changeset(entries: Map<string, string[]>): Changeset {
  const keys = new Map<string, Map<string, bigint>>();
  for (const [tbl, ks] of entries) if (ks.length) keys.set(tbl, new Map(ks.map((k) => [k, EPOCH])));
  return { keys, truncated: new Set() };
}

// ------------------------------------------------------------------ reconcile

/**
 * Compares one table row by row on both sides and repairs any difference: the
 * safety net for anything the change log missed (a trigger installed late, a
 * row that failed to apply, a migration that landed on one side first).
 *
 * The ThinkPad wins, except that rows only the cloud has are brought home
 * (the fallback wrote them) unless the ThinkPad deleted them itself, and
 * pruned rows stay pruned. `prefer` makes one side win outright, after a
 * TRUNCATE there. Keys with a change still waiting in either log are left
 * alone: the regular sync owns those.
 *
 * Must run inside `pair.exclusive`.
 */
export async function reconcileTable(pair: Pair, tbl: string, prefer: "local" | "cloud" | null = null) {
  const shape = await pair.refreshShape(true);
  const lt = shape.local.tables.get(tbl);
  const ct = shape.cloud.tables.get(tbl);
  if (!lt || !ct || !shape.synced.includes(tbl)) return { table: tbl, skipped: "not on both sides" };

  const lcols = new Set(lt.columns.map((c) => c.name));
  const ccols = new Set(ct.columns.map((c) => c.name));
  const dropLocal = [...lcols].filter((c) => !ccols.has(c));
  const dropCloud = [...ccols].filter((c) => !lcols.has(c));
  const { pull, push } = await pair.positions();

  const [lh, ch] = await Promise.all([
    tx(pair.local, { repeatableRead: true, readOnly: true }, (c) => hashRows(c, lt, dropLocal)),
    tx(pair.cloud, { repeatableRead: true, readOnly: true }, (c) => hashRows(c, ct, dropCloud)),
  ]);
  const pruned = await pair.prunedKeys(pair.local, tbl, [...lh.keys()]);
  const localDeletes = new Set(
    (
      await pair.local.query<{ k: string }>(
        `select distinct pk::text as k from paribelle_sync.changes where tbl = $1 and op = 'D'`,
        [tbl],
      )
    ).rows.map((r) => r.k),
  );
  const localOnly = pair.cfg.localOnly.includes(tbl);

  const toCloud: string[] = [];
  const toLocal: string[] = [];
  for (const [k, h] of lh) {
    const other = ch.get(k);
    if (other === undefined) {
      if (prefer === "cloud") {
        if (!pruned.has(k)) toLocal.push(k); // absent in the cloud: deletes it here
      } else if (!pruned.has(k) && !localOnly) toCloud.push(k);
    } else if (other !== h) {
      if (prefer === "cloud") toLocal.push(k);
      else if (!localOnly) toCloud.push(k);
    }
  }
  for (const k of ch.keys()) {
    if (lh.has(k)) continue;
    // Only the cloud has it: the ThinkPad deleted it (push the delete), or the fallback made it (bring it home).
    if (prefer === "local" || localDeletes.has(k)) toCloud.push(k);
    else toLocal.push(k);
  }

  const conflicts = [];
  if (toLocal.length) conflicts.push(...(await pair.pullKeys(shape, changeset(new Map([[tbl, toLocal]])), push)));
  if (toCloud.length) conflicts.push(...(await pair.pushKeys(shape, changeset(new Map([[tbl, toCloud]])), pull)));
  await pair.recordConflicts(conflicts);
  if (toLocal.length || toCloud.length) {
    log("info", "reconciled", { pair: pair.name, table: tbl, toThinkPad: toLocal.length, toCloud: toCloud.length });
  }
  pair.status.lastReconcileAt = new Date().toISOString();
  return { table: tbl, toThinkPad: toLocal.length, toCloud: toCloud.length, conflicts: conflicts.length };
}

export async function reconcileAll(pair: Pair) {
  const shape = await pair.refreshShape(true);
  const out = [];
  for (const t of shape.order) {
    try {
      out.push(await reconcileTable(pair, t));
    } catch (e) {
      log("error", "reconcile failed", { pair: pair.name, table: t, error: errText(e) });
      out.push({ table: t, error: errText(e) });
    }
  }
  return out;
}

// ------------------------------------------------------------------ prune

/**
 * `exists (...)` for rows elsewhere that would stop `alias`'s row being
 * deleted cleanly: a reference that isn't ON DELETE CASCADE (it would be set
 * to null, or block the delete), directly or through a cascade.
 */
function blockedBy(meta: Meta, table: string, alias: string, depth = 0): string {
  const parts: string[] = [];
  meta.fks.forEach((fk, i) => {
    if (fk.parent !== table) return;
    const a = `b${depth}_${i}`;
    const join = fk.childCols.map((c, j) => `${a}.${q(c)} = ${alias}.${q(fk.parentCols[j])}`).join(" and ");
    if (fk.onDelete !== "c") {
      parts.push(`exists (select 1 from public.${q(fk.child)} ${a} where ${join})`);
    } else if (depth < 4) {
      const inner = blockedBy(meta, fk.child, a, depth + 1);
      if (inner) parts.push(`exists (select 1 from public.${q(fk.child)} ${a} where ${join} and (${inner}))`);
    }
  });
  return parts.join(" or ");
}

/** The keys of every row a cascade would delete along with `keys`, table by table. */
async function cascadeClosure(c: Client | import("pg").Pool, meta: Meta, table: string, keys: string[], out: Map<string, Set<string>>, depth = 0) {
  if (!keys.length || depth > 6) return;
  const set = out.get(table) ?? new Set<string>();
  out.set(table, set);
  const t = meta.tables.get(table)!;
  for (const fk of meta.fks) {
    if (fk.parent !== table || fk.onDelete !== "c") continue;
    const child = meta.tables.get(fk.child);
    if (!child) continue;
    const parentSel = `select ${fk.parentCols.map((c) => `p.${q(c)}`).join(", ")} from public.${q(table)} p
      where ${pkExpr("p", t)} = any($1::text[])`;
    const r = await c.query<{ k: string }>(
      `select ${pkExpr("c", child)} as k from public.${q(fk.child)} c where (${fk.childCols.map((x) => `c.${q(x)}`).join(", ")}) in (${parentSel})`,
      [keys],
    );
    const fresh = r.rows.map((x) => x.k).filter((k) => !(out.get(fk.child)?.has(k)));
    const childSet = out.get(fk.child) ?? new Set<string>();
    out.set(fk.child, childSet);
    for (const k of fresh) childSet.add(k);
    await cascadeClosure(c, meta, fk.child, fresh, out, depth + 1);
  }
}

/**
 * Frees space in the cloud copy by deleting old rows there, by the rules in
 * policy.json, only while the cloud database is over PRUNE_AT_MB. The deletes
 * aren't logged, so they never reach the ThinkPad, and every deleted key is
 * recorded there so the sync and reconcile leave it deleted.
 *
 * Only runs while the ThinkPad is serving (the cloud is idle then), because
 * VACUUM FULL, which actually gives the space back, locks each table briefly.
 * Must run inside `pair.exclusive`.
 */
export async function prune(pair: Pair, opts: { dryRun?: boolean; force?: boolean } = {}) {
  const sizeBefore = await dbSizeMb(pair);
  if (!opts.force && sizeBefore < pair.settings.pruneAtMb) return { sizeMb: sizeBefore, pruned: {}, skipped: "under the limit" };
  if (!opts.dryRun && !opts.force && !pair.isReady()) return { sizeMb: sizeBefore, pruned: {}, skipped: "the ThinkPad isn't serving" };
  const shape = await pair.refreshShape(true);
  const meta = shape.cloud;
  const counts: Record<string, number> = {};
  const touched = new Set<string>();

  for (const rule of pair.cfg.prune) {
    const t = meta.tables.get(rule.table);
    if (!t || !shape.synced.includes(rule.table)) continue;
    if (!rule.all && (!rule.column || rule.keepDays === undefined)) {
      log("warn", "prune rule needs `all` or `column` and `keepDays`", { pair: pair.name, rule });
      continue;
    }
    const cond = rule.all ? "true" : `t.${q(rule.column!)} < now() - make_interval(days => ${Number(rule.keepDays)})`;
    const blocked = blockedBy(meta, rule.table, "t");
    const order = rule.column ? `order by t.${q(rule.column)}` : "";
    let total = 0;
    for (;;) {
      const cand = await pair.cloud.query<{ k: string }>(
        `select ${pkExpr("t", t)} as k from public.${q(rule.table)} t where ${cond}${blocked ? ` and not (${blocked})` : ""} ${order} limit 2000`,
      );
      const keys = cand.rows.map((r) => r.k);
      if (!keys.length) break;
      const closure = new Map<string, Set<string>>([[rule.table, new Set(keys)]]);
      await cascadeClosure(pair.cloud, meta, rule.table, keys, closure);
      if (opts.dryRun) {
        total += keys.length;
        break;
      }
      // Record first: a crash after this leaves rows marked pruned that still exist, which the next run deletes.
      for (const [tbl, ks] of closure) {
        if (!ks.size) continue;
        await pair.local.query(
          `insert into paribelle_sync.pruned (tbl, pk) select $1, k::jsonb from unnest($2::text[]) k on conflict do nothing`,
          [tbl, [...ks]],
        );
        touched.add(tbl);
      }
      await tx(pair.cloud, { applying: true }, async (c) => {
        await c.query(`delete from public.${q(rule.table)} t where ${pkExpr("t", t)} = any($1::text[])`, [keys]);
      });
      total += keys.length;
    }
    if (total) counts[rule.table] = total;
  }

  if (!opts.dryRun) {
    for (const tbl of touched) {
      await pair.cloud.query(`vacuum full public.${q(tbl)}`).catch((e) => log("warn", "vacuum full failed", { table: tbl, error: errText(e) }));
    }
    if (touched.size) await pair.cloud.query(`vacuum full paribelle_sync.changes`).catch(() => {});
  }
  const sizeAfter = opts.dryRun ? sizeBefore : await dbSizeMb(pair);
  pair.status.lastPruneAt = new Date().toISOString();
  pair.status.cloudSizeMb = sizeAfter;
  log(Object.keys(counts).length ? "info" : "warn", opts.dryRun ? "prune (dry run)" : "pruned the cloud copy", {
    pair: pair.name,
    rows: counts,
    sizeBeforeMb: sizeBefore,
    sizeAfterMb: sizeAfter,
  });
  if (!opts.dryRun && sizeAfter >= pair.settings.pruneAtMb) {
    log("warn", "the cloud copy is still over the limit after pruning; tighten the rules in policy.json", {
      pair: pair.name,
      sizeMb: sizeAfter,
      limitMb: pair.settings.pruneAtMb,
    });
  }
  return { sizeMb: sizeAfter, sizeBeforeMb: sizeBefore, pruned: counts };
}

async function dbSizeMb(pair: Pair): Promise<number> {
  const r = await pair.cloud.query<{ mb: number }>(`select (pg_database_size(current_database()) / 1048576)::int as mb`);
  return r.rows[0].mb;
}

// ------------------------------------------------------------------ processes

function run(cmd: string, args: string[], opts: { stdin?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-2000)}`))));
    if (opts.stdin !== undefined) p.stdin.end(opts.stdin);
    else p.stdin.end();
  });
}

/** A URL libpq accepts as-is: `sslmode=require` for anything not on the compose network. */
function libpqUrl(url: string): string {
  const u = new URL(url);
  // node-postgres's "no-verify" (the OMS's own URLs use it) is libpq's "require": encrypted,
  // certificate unchecked. pg_dump refuses the unknown word.
  if (u.searchParams.get("sslmode") === "no-verify") u.searchParams.set("sslmode", "require");
  if (!u.searchParams.has("sslmode")) u.searchParams.set("sslmode", u.hostname.includes(".") && u.hostname !== "127.0.0.1" ? "require" : "disable");
  return u.toString();
}

// ------------------------------------------------------------------ backups

/**
 * Dumps each ThinkPad database, encrypted to the backup key (age), keeps the
 * last BACKUP_KEEP nights in the backups volume and uploads each to R2
 * (`daily/`, and Sunday's to `weekly/` too). The ThinkPad holds the only
 * complete copy of the data, so this is the one that matters.
 */
export async function backup(settings: Settings, pairs: PairConfig[], when = new Date()) {
  const b = settings.backup;
  mkdirSync(b.dir, { recursive: true });
  const day = when.toISOString().slice(0, 10);
  const results = [];
  for (const p of pairs) {
    const name = `paribelle-${p.name}-${day}.dump${b.recipient ? ".age" : ""}`;
    const file = join(b.dir, name);
    const tmp = `${file}.partial`;
    const dump = spawn("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "-d", libpqUrl(p.localUrl)], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    dump.stderr.on("data", (d) => (err += d));
    const dumpDone = new Promise<void>((res, rej) => dump.on("close", (code) => (code === 0 ? res() : rej(new Error(`pg_dump exited ${code}: ${err.slice(-1000)}`)))));
    if (b.recipient) {
      const age = spawn("age", ["-r", b.recipient], { stdio: ["pipe", "pipe", "pipe"] });
      let aerr = "";
      age.stderr.on("data", (d) => (aerr += d));
      const ageDone = new Promise<void>((res, rej) => age.on("close", (code) => (code === 0 ? res() : rej(new Error(`age exited ${code}: ${aerr}`)))));
      dump.stdout.pipe(age.stdin);
      await Promise.all([pipeline(age.stdout, createWriteStream(tmp)), dumpDone, ageDone]);
    } else {
      await Promise.all([pipeline(dump.stdout, createWriteStream(tmp)), dumpDone]);
    }
    rmSync(file, { force: true });
    await import("node:fs/promises").then((fs) => fs.rename(tmp, file));
    const bytes = statSync(file).size;

    let uploaded = false;
    if (b.s3 && b.recipient) {
      await putFile(b.s3, `daily/${name}`, file);
      if (when.getDay() === 0) await putFile(b.s3, `weekly/${name}`, file);
      uploaded = true;
    } else if (b.s3) {
      log("warn", "not uploading an unencrypted backup: set BACKUP_RECIPIENT", { pair: p.name });
    }

    const mine = readdirSync(b.dir).filter((f) => f.startsWith(`paribelle-${p.name}-`) && !f.endsWith(".partial")).sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - b.keep))) rmSync(join(b.dir, old), { force: true });
    log("info", "backup written", { pair: p.name, file: name, mb: Math.round(bytes / 1048576), uploaded });
    results.push({ pair: p.name, file: name, bytes, uploaded });
  }
  writeFileSync(join(b.dir, "last-backup.json"), JSON.stringify({ at: new Date().toISOString(), results }));
  return results;
}

// ------------------------------------------------------------------ bootstrap

async function takeLocks(pair: PairConfig) {
  const local = makePool(pair.localUrl, 2, "paribelle-sync-setup");
  const cloud = makePool(pair.cloudUrl, 2, "paribelle-sync-setup");
  const lc = await local.connect();
  const cc = await cloud.connect();
  const release = async () => {
    lc.release();
    cc.release();
    await Promise.allSettled([local.end(), cloud.end()]);
  };
  for (const [c, where] of [[lc, "ThinkPad"], [cc, "cloud"]] as const) {
    const r = await c.query<{ ok: boolean }>(`select pg_try_advisory_lock(hashtext('paribelle_sync')) as ok`);
    if (!r.rows[0].ok) {
      await release();
      throw new Halt(`the sync is running against the ${where} database; stop it first: docker compose stop sync`);
    }
  }
  return { local, cloud, release };
}

async function publicTables(pool: import("pg").Pool): Promise<string[]> {
  const r = await pool.query<{ t: string }>(`select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p')`);
  return r.rows.map((x) => x.t);
}

async function xmin(pool: import("pg").Pool): Promise<string> {
  const r = await pool.query<{ x: string }>(`select pg_snapshot_xmin(pg_current_snapshot())::text as x`);
  return r.rows[0].x;
}

/**
 * What to restore from a dump of `public`: everything but the schema itself
 * (the target has one already) and the sync's own triggers (the target gets
 * its own).
 */
async function restoreList(file: string, dir: string): Promise<string> {
  const { out } = await run("pg_restore", ["-l", file]);
  const kept = out
    .split("\n")
    .filter((l) => !/ TRIGGER public \S+ paribelle_sync_/.test(l) && !/ SCHEMA - public /.test(l) && !/ COMMENT - SCHEMA public /.test(l));
  const list = join(dir, `${Date.now()}.list`);
  writeFileSync(list, kept.join("\n"));
  return list;
}

/**
 * A dump of `public` leaves out the extensions installed there (pgvector for the
 * OMS's reel_songs), though its tables use their types. Makes them on the target
 * first. One that can't be made is logged; the restore then says what needed it.
 */
async function copyExtensions(from: import("pg").Pool, to: import("pg").Pool, target: string) {
  const r = await from.query<{ e: string }>(
    `select e.extname as e from pg_extension e join pg_namespace n on n.oid = e.extnamespace where n.nspname = 'public'`,
  );
  for (const { e } of r.rows) {
    await to.query(`create extension if not exists ${q(e)} with schema public`).catch((err: unknown) => {
      log("warn", `the ${target} database can't have the ${e} extension`, { error: errText(err) });
    });
  }
}

/** Row counts per table on each side, to show after a copy. */
async function counts(pool: import("pg").Pool, tables: string[]) {
  const out: Record<string, number> = {};
  for (const t of tables) {
    const r = await pool.query<{ n: string }>(`select count(*)::text as n from public.${q(t)}`);
    out[t] = Number(r.rows[0].n);
  }
  return out;
}

/**
 * First start: copies the cloud database (the one the current Vercel/Render
 * deploy uses) into the ThinkPad's empty one, with no downtime.
 *
 * The cloud gets its capture triggers first, then the dump is taken, so every
 * write that lands during or after the copy is in the cloud's change log and
 * the sync replays it once it starts. Replaying a change the dump already has
 * is harmless: the sync always copies a row's current version.
 */
export async function bootstrap(cfg: PairConfig, settings: Settings) {
  const { local, cloud, release } = await takeLocks(cfg);
  try {
    const existing = await publicTables(local);
    if (existing.length) {
      throw new Halt(
        `the ThinkPad's ${cfg.name} database already has tables (${existing.slice(0, 5).join(", ")}…). ` +
          "It is the source of truth once running, so bootstrap never overwrites it. See README › Starting over.",
      );
    }
    log("info", "installing the change log in the cloud", { pair: cfg.name });
    await installBase(cloud, "cloud");
    const cmeta = await loadMeta(cloud);
    const synced = new Set([...cmeta.tables.keys()].filter((t) => !cfg.exclude.includes(t)));
    await ensureTriggers(cloud, cmeta, synced);
    const cloudInstance = (await instanceId(cloud))!;
    const pullFrom = await xmin(cloud);

    const dir = settings.backup.dir;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `bootstrap-${cfg.name}-${Date.now()}.dump`);
    log("info", "copying the cloud database", { pair: cfg.name });
    await run("pg_dump", ["--format=custom", "--schema=public", "--no-owner", "--no-privileges", "--file", file, "-d", libpqUrl(cfg.cloudUrl)]);

    // What a Supabase schema expects to find: its extensions schema and roles.
    await local.query(`
      create schema if not exists extensions;
      create extension if not exists "uuid-ossp" with schema extensions;
      create extension if not exists pgcrypto with schema extensions;
      -- Row-level security policies written for Supabase call these; here nobody logs in through them.
      create schema if not exists auth;
      do $$ begin
        if to_regprocedure('auth.uid()') is null then create function auth.uid() returns uuid language sql stable as 'select null::uuid'; end if;
        if to_regprocedure('auth.role()') is null then create function auth.role() returns text language sql stable as 'select null::text'; end if;
        if to_regprocedure('auth.jwt()') is null then create function auth.jwt() returns jsonb language sql stable as 'select null::jsonb'; end if;
      end $$;
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
      end $$;`);
    const db = (await local.query<{ d: string }>(`select current_database() as d`)).rows[0].d;
    await local.query(`alter database ${q(db)} set search_path = "$user", public, extensions`);
    await copyExtensions(cloud, local, "ThinkPad's");

    const list = await restoreList(file, dir);
    const res = await run("pg_restore", ["--no-owner", "--no-privileges", "--single-transaction", "-L", list, "-d", libpqUrl(cfg.localUrl), file]).catch(
      (e: Error) => ({ out: "", err: e.message, failed: true }),
    );
    if ("failed" in res) throw new Error(`restore failed, nothing was kept: ${res.err}`);
    if (res.err.trim()) log("warn", "restore warnings", { pair: cfg.name, stderr: res.err.slice(-4000) });
    rmSync(list, { force: true });

    await installBase(local, "local");
    const lmeta = await loadMeta(local);
    await ensureTriggers(local, lmeta, new Set([...lmeta.tables.keys()].filter((t) => !cfg.exclude.includes(t))));
    await Pair.setState(local, "pull", pullFrom);
    await Pair.setState(local, "push", await xmin(local));
    await Pair.setState(local, "cloud_instance", cloudInstance);

    const tables = [...synced].filter((t) => lmeta.tables.has(t));
    const [lc, cc] = await Promise.all([counts(local, tables), counts(cloud, tables)]);
    const differ = tables.filter((t) => lc[t] !== cc[t]).map((t) => `${t}: ThinkPad ${lc[t]}, cloud ${cc[t]}`);
    log("info", "bootstrap done; start the sync to replay what changed during the copy", {
      pair: cfg.name,
      tables: tables.length,
      rows: Object.values(lc).reduce((a, b) => a + b, 0),
      differing: differ,
      dump: file,
    });
    return { tables: tables.length, differing: differ };
  } finally {
    await release();
  }
}

/**
 * The other direction: fills a new, empty cloud database from the ThinkPad
 * (a replaced or lost Supabase project). Tables kept on the ThinkPad only
 * are copied empty. Run `sync prune <pair> --force` afterwards if it's over
 * the free plan's size.
 */
export async function reseedCloud(cfg: PairConfig, settings: Settings) {
  const { local, cloud, release } = await takeLocks(cfg);
  try {
    const existing = await publicTables(cloud);
    if (existing.length) {
      throw new Halt(
        `the cloud ${cfg.name} database already has tables (${existing.slice(0, 5).join(", ")}…). ` +
          "Reseeding only fills an empty one: use a new project, or empty it by hand first.",
      );
    }
    await uninstall(cloud);
    await installBase(local, "local");
    const pushFrom = await xmin(local);
    const dir = settings.backup.dir;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `reseed-${cfg.name}-${Date.now()}.dump`);
    const excludeData = cfg.localOnly.flatMap((t) => ["--exclude-table-data", `public.${q(t)}`]);
    log("info", "copying the ThinkPad's database to the cloud", { pair: cfg.name });
    await run("pg_dump", ["--format=custom", "--schema=public", "--no-owner", "--no-privileges", ...excludeData, "--file", file, "-d", libpqUrl(cfg.localUrl)]);
    await copyExtensions(local, cloud, "cloud");
    const list = await restoreList(file, dir);
    await run("pg_restore", ["--no-owner", "--no-privileges", "--single-transaction", "-L", list, "-d", libpqUrl(cfg.cloudUrl), file]);
    rmSync(list, { force: true });

    await installBase(cloud, "cloud");
    const cmeta = await loadMeta(cloud);
    await ensureTriggers(cloud, cmeta, new Set([...cmeta.tables.keys()].filter((t) => !cfg.exclude.includes(t))));
    await local.query(`delete from paribelle_sync.pruned`);
    await local.query(`delete from paribelle_sync.state where key = 'sequences'`);
    await Pair.setState(local, "pull", await xmin(cloud));
    await Pair.setState(local, "push", pushFrom);
    await Pair.setState(local, "cloud_instance", (await instanceId(cloud))!);
    log("info", "cloud reseeded from the ThinkPad; start the sync", { pair: cfg.name, dump: file });
    return { ok: true };
  } finally {
    await release();
  }
}

/** Marks every open conflict resolved (after reading them). */
export async function resolveConflicts(pair: Pair, ids: number[] | "all") {
  const r =
    ids === "all"
      ? await pair.local.query(`update paribelle_sync.conflicts set resolved_at = now() where resolved_at is null`)
      : await pair.local.query(`update paribelle_sync.conflicts set resolved_at = now() where id = any($1::bigint[]) and resolved_at is null`, [ids]);
  pair.status.openConflicts = Math.max(0, pair.status.openConflicts - (r.rowCount ?? 0));
  return { resolved: r.rowCount };
}

export async function listConflicts(pair: Pair, limit = 50) {
  const r = await pair.local.query(
    `select id, at, tbl, pk, kept, reason, left(lost_row::text, 500) as lost_row from paribelle_sync.conflicts
     where resolved_at is null order by id desc limit $1`,
    [limit],
  );
  return r.rows;
}

export type { Table };
