import pg from "pg";

import type { PairConfig, Settings } from "../src/config.ts";
import { loadSettings } from "../src/config.ts";
import { bootstrap } from "../src/ops.ts";
import { Pair } from "../src/pair.ts";
import { uninstall } from "../src/schema.ts";

export const LOCAL_URL = process.env.LOCAL_URL ?? "postgres://paribelle:local@localhost:55432/shop";
export const CLOUD_URL = process.env.CLOUD_URL ?? "postgres://postgres:cloud@localhost:55433/cloud";

/** A small shop: serial and uuid keys, cascades, SET NULL, a composite key, bytea, an enum, a self-reference. */
export const SCHEMA = `
create type status as enum ('new', 'packed', 'shipped');
create table accounts (id serial primary key, name text not null unique);
create table products (id serial primary key, sku text not null unique, name text not null, cost numeric(12,2));
create table orders (
  id serial primary key,
  account_id int not null references accounts(id) on delete cascade,
  ext text not null,
  status status not null default 'new',
  ordered_at timestamptz not null default now(),
  raw jsonb,
  unique (account_id, ext)
);
create table order_items (
  id serial primary key,
  order_id int not null references orders(id) on delete cascade,
  product_id int references products(id),
  qty int not null default 1
);
create table returns (id serial primary key, order_id int references orders(id) on delete set null, reason text);
create table labels (id serial primary key, created_at timestamptz not null default now(), pdf bytea not null);
create table categories (id uuid primary key default gen_random_uuid(), parent_id uuid references categories(id) on delete cascade, name text not null);
create table batch_orders (batch int not null, order_id int not null references orders(id) on delete cascade, primary key (batch, order_id));
create table reel_jobs (id serial primary key, output bytea);
create table migrations (id serial primary key, name text not null);
create table notes (id bigint generated always as identity primary key, body text not null, words int generated always as (length(body)) stored);
`;

export const TABLES = ["accounts", "products", "orders", "order_items", "returns", "labels", "categories", "batch_orders", "reel_jobs", "notes"];

export function testSettings(over: Partial<Settings> = {}): Settings {
  const s = loadSettings({});
  return {
    ...s,
    intervalMs: 10,
    pageSize: 50,
    seqHeadroom: 1000,
    bootGraceMs: 500,
    metaRefreshMs: 0,
    pruneAtMb: 0,
    backup: { ...s.backup, dir: "/tmp/paribelle-sync-test" },
    ...over,
  };
}

export function pairConfig(over: Partial<PairConfig> = {}): PairConfig {
  return {
    name: "shop",
    localUrl: LOCAL_URL,
    cloudUrl: CLOUD_URL,
    exclude: ["migrations"],
    localOnly: ["reel_jobs"],
    prune: [
      { table: "labels", column: "created_at", keepDays: 30 },
      { table: "orders", column: "ordered_at", keepDays: 365 },
    ],
    appHealth: [],
    ...over,
  };
}

export async function reset() {
  for (const url of [LOCAL_URL, CLOUD_URL]) {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    await c.query("select pg_advisory_unlock_all()");
    await uninstall(c);
    await c.query(`drop schema if exists public cascade; create schema public;`);
    await c.query(`drop schema if exists extensions cascade; drop schema if exists auth cascade;`).catch(() => {});
    await c.end();
  }
}

export function client(url: string) {
  return new pg.Pool({ connectionString: url, max: 3 });
}

/**
 * A running setup like production after the move: the cloud had the schema and
 * some data (what Vercel/Render use today), bootstrap copied it to the ThinkPad.
 */
export async function setup(opts: { settings?: Partial<Settings>; cfg?: Partial<PairConfig>; seed?: string } = {}) {
  await reset();
  const cloud = client(CLOUD_URL);
  const local = client(LOCAL_URL);
  await cloud.query(SCHEMA);
  await cloud.query(
    opts.seed ??
      `insert into accounts (name) values ('amazon'), ('flipkart');
       insert into products (sku, name, cost) values ('A', 'Kurta', 499.50), ('B', 'Dupatta', 199);
       insert into orders (account_id, ext, raw) values (1, 'o-1', '{"a": 1}'), (1, 'o-2', null), (2, 'f-1', '[1,2]');
       insert into order_items (order_id, product_id, qty) values (1, 1, 2), (2, 2, 1), (3, 1, 1);
       insert into migrations (name) values ('initial');`,
  );
  const settings = testSettings(opts.settings);
  const cfg = pairConfig(opts.cfg);
  await bootstrap(cfg, settings);
  const pair = new Pair(cfg, settings);
  return { pair, local, cloud, settings, cfg };
}

/** Cycles until neither side has anything left to send. */
export async function settle(pair: Pair, max = 50) {
  for (let i = 0; i < max; i++) {
    const more = await pair.exclusive(() => pair.cycle());
    if (pair.status.halted) throw new Error(`halted: ${pair.status.halted}`);
    if (pair.status.lastError) throw new Error(`cycle failed: ${pair.status.lastError}`);
    if (!more) {
      // One more to confirm both logs are empty.
      const again = await pair.exclusive(() => pair.cycle());
      if (!again && (await pending(pair)) === 0) return;
    }
  }
  throw new Error("did not settle");
}

async function pending(pair: Pair): Promise<number> {
  const { pull, push } = await pair.positions();
  const [l, c] = await Promise.all([
    pair.local.query<{ n: number }>(`select count(*)::int as n from paribelle_sync.changes where txid >= $1::xid8`, [push]),
    pair.cloud.query<{ n: number }>(`select count(*)::int as n from paribelle_sync.changes where txid >= $1::xid8`, [pull]),
  ]);
  return l.rows[0].n + c.rows[0].n;
}

/** Every row of a table as canonical json text, keyed by primary key text. */
export async function rows(pool: pg.Pool, table: string): Promise<Map<string, string>> {
  const pk = await pool.query<{ a: string }>(
    `select a.attname as a from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
     where i.indrelid = ('public.' || $1)::regclass and i.indisprimary order by a.attnum`,
    [table],
  );
  const keyExpr = `jsonb_build_object(${pk.rows.map((r) => `'${r.a}', t."${r.a}"`).join(", ")})::text`;
  const c = await pool.connect();
  try {
    await c.query("set timezone = 'UTC'");
    const r = await c.query<{ k: string; r: string }>(`select ${keyExpr} as k, to_jsonb(t)::text as r from public."${table}" t`);
    return new Map(r.rows.map((x) => [x.k, x.r]));
  } finally {
    c.release();
  }
}

/**
 * Both sides hold the same rows, except rows pruned from the cloud (which only
 * the ThinkPad keeps) and ThinkPad-only tables.
 */
export async function assertConverged(pair: Pair, opts: { tables?: string[] } = {}) {
  const tables = opts.tables ?? TABLES.filter((t) => !pair.cfg.localOnly.includes(t) && !pair.cfg.exclude.includes(t));
  const problems: string[] = [];
  for (const t of tables) {
    const [l, c] = await Promise.all([rows(pair.local, t), rows(pair.cloud, t)]);
    const pruned = await pair.prunedKeys(pair.local, t, [...l.keys()]);
    for (const [k, v] of l) {
      if (pruned.has(k)) {
        if (c.has(k)) problems.push(`${t} ${k}: pruned but still in the cloud`);
        continue;
      }
      if (!c.has(k)) problems.push(`${t} ${k}: missing in the cloud`);
      else if (c.get(k) !== v) problems.push(`${t} ${k}: differs\n  local ${v}\n  cloud ${c.get(k)}`);
    }
    for (const k of c.keys()) if (!l.has(k)) problems.push(`${t} ${k}: missing on the ThinkPad`);
  }
  if (problems.length) throw new Error(`not converged:\n${problems.slice(0, 20).join("\n")}`);
}

export async function conflicts(pair: Pair) {
  const r = await pair.local.query<{ tbl: string; pk: unknown; kept: string; reason: string }>(
    `select tbl, pk, kept, reason from paribelle_sync.conflicts order by id`,
  );
  return r.rows;
}

export async function close(...things: ({ end(): Promise<void> } | { close(): Promise<void> })[]) {
  await Promise.allSettled(things.map((t) => ("close" in t ? t.close() : t.end())));
}
