import { createHash } from "node:crypto";
import type pg from "pg";

import { log, q, lit, type Client } from "./db.ts";

/**
 * Everything the sync keeps inside a database lives in the `paribelle_sync`
 * schema, apart from one trigger pair per table. drizzle-kit push and TypeORM
 * only look at `public`, so neither drops it.
 *
 *   changes    every insert, update and delete, as (table, primary key); the
 *              row itself is read again when the change is copied
 *   meta       this database's instance id, so a replaced cloud database is
 *              noticed instead of synced against with stale positions
 *   state      (ThinkPad only) how far each direction has read
 *   conflicts  (ThinkPad only) rows that lost a conflict or failed to apply
 *   pruned     (ThinkPad only) rows deleted from the cloud to free space
 */
const BASE_DDL = `
create schema if not exists paribelle_sync;

create table if not exists paribelle_sync.changes (
  id bigint generated always as identity primary key,
  txid xid8 not null default pg_current_xact_id(),
  tbl text not null,
  pk jsonb,
  op text not null,
  at timestamptz not null default clock_timestamp()
);
create index if not exists changes_txid_idx on paribelle_sync.changes (txid);

create table if not exists paribelle_sync.meta (key text primary key, value text not null);
insert into paribelle_sync.meta values ('instance', gen_random_uuid()::text) on conflict do nothing;

create or replace function paribelle_sync.capture_truncate() returns trigger language plpgsql as $fn$
begin
  if current_setting('paribelle_sync.applying', true) = 'on' then return null; end if;
  insert into paribelle_sync.changes (tbl, pk, op) values (tg_table_name, null, 'T');
  return null;
end
$fn$;
`;

const LOCAL_DDL = `
create table if not exists paribelle_sync.state (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table if not exists paribelle_sync.conflicts (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  tbl text not null,
  pk jsonb not null,
  -- 'local' or 'cloud': the side whose version was kept, or 'none' when a row could not be applied
  kept text not null,
  -- the version that was not applied
  lost_row jsonb,
  reason text not null,
  resolved_at timestamptz
);
create index if not exists conflicts_open_idx on paribelle_sync.conflicts (at) where resolved_at is null;

create table if not exists paribelle_sync.pruned (
  tbl text not null,
  pk jsonb not null,
  at timestamptz not null default now(),
  primary key (tbl, pk)
);
`;

export async function installBase(c: Client | pg.Pool, side: "local" | "cloud") {
  await c.query(BASE_DDL);
  if (side === "local") await c.query(LOCAL_DDL);
}

/**
 * This database's instance id; null only when the sync's schema or table isn't
 * there (a reset or replaced database). Anything else (a timeout, a dropped
 * connection, an aborted transaction) is thrown: it says nothing about the schema.
 */
export async function instanceId(c: Client | pg.Pool): Promise<string | null> {
  try {
    const r = await c.query(`select value from paribelle_sync.meta where key = 'instance'`);
    return r.rows[0]?.value ?? null;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "3F000" || code === "42P01") return null; // invalid_schema_name, undefined_table
    throw e;
  }
}

export interface Column {
  name: string;
  type: string;
  generated: boolean;
  identityAlways: boolean;
  bytea: boolean;
}

export interface ForeignKey {
  name: string;
  child: string;
  childCols: string[];
  parent: string;
  parentCols: string[];
  /** a no action, r restrict, c cascade, n set null, d set default */
  onDelete: string;
}

export interface Table {
  name: string;
  pk: string[];
  pkTypes: string[];
  columns: Column[];
  /** The sequence behind an integer primary key, when there is one. */
  sequence: { name: string; column: string } | null;
}

export interface Meta {
  tables: Map<string, Table>;
  fks: ForeignKey[];
  /** Tables without a primary key, which can't be synced. */
  noPk: string[];
}

/** Reads the shape of `public`: tables with their keys and columns, foreign keys, and serial sequences. */
export async function loadMeta(c: Client | pg.Pool): Promise<Meta> {
  const tables = await c.query<{ tbl: string; pk: string[] | null; pk_types: string[] | null }>(`
    select c.relname as tbl,
      (select array_agg(a.attname::text order by k.ord)
         from unnest(i.indkey) with ordinality k(attnum, ord)
         join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum) as pk,
      (select array_agg(format_type(a.atttypid, a.atttypmod) order by k.ord)
         from unnest(i.indkey) with ordinality k(attnum, ord)
         join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum) as pk_types
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    left join pg_index i on i.indrelid = c.oid and i.indisprimary
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname`);
  const cols = await c.query<{ tbl: string; col: string; type: string; generated: boolean; identity: string; bytea: boolean }>(`
    select c.relname as tbl, a.attname as col, format_type(a.atttypid, a.atttypmod) as type,
      a.attgenerated <> '' as generated, a.attidentity as identity, a.atttypid = 'bytea'::regtype as bytea
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and a.attnum > 0 and not a.attisdropped
    order by c.relname, a.attnum`);
  const fks = await c.query<{ name: string; child: string; child_cols: string[]; parent: string; parent_cols: string[]; ondelete: string }>(`
    select con.conname as name, cl.relname as child, pr.relname as parent,
      array(select a.attname::text from unnest(con.conkey) with ordinality k(n, o)
            join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.o) as child_cols,
      array(select a.attname::text from unnest(con.confkey) with ordinality k(n, o)
            join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n order by k.o) as parent_cols,
      con.confdeltype::text as ondelete
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_class pr on pr.oid = con.confrelid
    join pg_namespace n on n.oid = cl.relnamespace
    join pg_namespace pn on pn.oid = pr.relnamespace
    where con.contype = 'f' and n.nspname = 'public' and pn.nspname = 'public'`);
  const seqs = await c.query<{ tbl: string; col: string; seq: string }>(`
    select c.relname as tbl, a.attname as col, s.relname as seq
    from pg_depend d
    join pg_class s on s.oid = d.objid and s.relkind = 'S'
    join pg_class c on c.oid = d.refobjid
    join pg_attribute a on a.attrelid = c.oid and a.attnum = d.refobjsubid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_namespace sn on sn.oid = s.relnamespace
    where d.deptype in ('a', 'i') and n.nspname = 'public' and sn.nspname = 'public'`);

  const meta: Meta = { tables: new Map(), fks: [], noPk: [] };
  for (const t of tables.rows) {
    if (!t.pk) {
      meta.noPk.push(t.tbl);
      continue;
    }
    meta.tables.set(t.tbl, { name: t.tbl, pk: t.pk, pkTypes: t.pk_types!, columns: [], sequence: null });
  }
  for (const col of cols.rows) {
    meta.tables.get(col.tbl)?.columns.push({
      name: col.col,
      type: col.type,
      generated: col.generated,
      identityAlways: col.identity === "a",
      bytea: col.bytea,
    });
  }
  for (const s of seqs.rows) {
    const t = meta.tables.get(s.tbl);
    // Only a sequence feeding a single-column integer key matters: that's where ids can collide.
    if (t && t.pk.length === 1 && t.pk[0] === s.col && /^(integer|bigint|smallint)$/.test(t.pkTypes[0])) {
      t.sequence = { name: s.seq, column: s.col };
    }
  }
  meta.fks = fks.rows.map((f) => ({
    name: f.name,
    child: f.child,
    childCols: f.child_cols,
    parent: f.parent,
    parentCols: f.parent_cols,
    onDelete: f.ondelete,
  }));
  return meta;
}

/** Parents before children, so inserts never wait on a row that isn't there yet. Cycles go last. */
export function topoOrder(tables: string[], fks: ForeignKey[]): string[] {
  const set = new Set(tables);
  const parents = new Map<string, Set<string>>(tables.map((t) => [t, new Set()]));
  for (const f of fks) {
    if (f.child !== f.parent && set.has(f.child) && set.has(f.parent)) parents.get(f.child)!.add(f.parent);
  }
  const out: string[] = [];
  const done = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const t of [...tables].sort()) {
      if (done.has(t)) continue;
      if ([...parents.get(t)!].every((p) => done.has(p))) {
        out.push(t);
        done.add(t);
        progress = true;
      }
    }
  }
  for (const t of [...tables].sort()) if (!done.has(t)) out.push(t);
  return out;
}

/** A function name that fits Postgres' 63-byte limit for any table name. */
function captureFnName(tbl: string): string {
  const name = `capture_${tbl}`;
  return Buffer.byteLength(name) <= 63 ? name : `capture_${createHash("md5").update(tbl).digest("hex").slice(0, 24)}`;
}

function pkJson(rec: "new" | "old", pk: string[]): string {
  return `jsonb_build_object(${pk.map((c) => `${lit(c)}, ${rec}.${q(c)}`).join(", ")})`;
}

/**
 * The row trigger for one table, written out per table so it reads only the
 * key columns: converting a whole row to JSON would copy every label PDF and
 * video chunk just to log that it changed.
 */
function captureFnSource(tbl: string, pk: string[]): string {
  const changed = pk.map((c) => `old.${q(c)} is distinct from new.${q(c)}`).join(" or ");
  return `
begin
  if current_setting('paribelle_sync.applying', true) = 'on' then return null; end if;
  if tg_op = 'DELETE' then
    insert into paribelle_sync.changes (tbl, pk, op) values (${lit(tbl)}, ${pkJson("old", pk)}, 'D');
  elsif tg_op = 'INSERT' then
    insert into paribelle_sync.changes (tbl, pk, op) values (${lit(tbl)}, ${pkJson("new", pk)}, 'I');
  else
    insert into paribelle_sync.changes (tbl, pk, op) values (${lit(tbl)}, ${pkJson("new", pk)}, 'U');
    if ${changed} then
      insert into paribelle_sync.changes (tbl, pk, op) values (${lit(tbl)}, ${pkJson("old", pk)}, 'D');
    end if;
  end if;
  return null;
end
`;
}

/**
 * Puts the capture triggers on every table that should be synced and takes
 * them off tables that shouldn't. Cheap when nothing changed: it compares the
 * installed function source first. Tables created by a later migration pick
 * their triggers up on the next call.
 */
export async function ensureTriggers(c: Client | pg.Pool, meta: Meta, synced: Set<string>): Promise<string[]> {
  const installed = await c.query<{ tbl: string; tgname: string }>(`
    select c.relname as tbl, t.tgname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and t.tgname in ('paribelle_sync_capture', 'paribelle_sync_truncate')`);
  const fns = await c.query<{ proname: string; prosrc: string }>(`
    select p.proname, p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'paribelle_sync' and p.proname like 'capture%'`);
  const src = new Map(fns.rows.map((f) => [f.proname, f.prosrc]));
  const has = new Set(installed.rows.map((r) => `${r.tbl}|${r.tgname}`));
  const changed: string[] = [];

  for (const t of meta.tables.values()) {
    if (!synced.has(t.name)) continue;
    const fn = captureFnName(t.name);
    const body = captureFnSource(t.name, t.pk);
    if (src.get(fn) !== body) {
      await c.query(`create or replace function paribelle_sync.${q(fn)}() returns trigger language plpgsql as $fn$${body}$fn$`);
      changed.push(t.name);
    }
    if (!has.has(`${t.name}|paribelle_sync_capture`)) {
      await c.query(
        `create trigger paribelle_sync_capture after insert or update or delete on public.${q(t.name)} for each row execute function paribelle_sync.${q(fn)}()`,
      );
      if (!changed.includes(t.name)) changed.push(t.name);
    }
    if (!has.has(`${t.name}|paribelle_sync_truncate`)) {
      await c.query(
        `create trigger paribelle_sync_truncate after truncate on public.${q(t.name)} for each statement execute function paribelle_sync.capture_truncate()`,
      );
    }
  }
  for (const r of installed.rows) {
    if (!synced.has(r.tbl)) {
      await c.query(`drop trigger if exists ${q(r.tgname)} on public.${q(r.tbl)}`);
      log("info", "capture trigger removed", { table: r.tbl });
    }
  }
  return changed;
}

/** Removes every trace of the sync from a database (tests, and moving to a new cloud project). */
export async function uninstall(c: Client | pg.Pool | pg.Client) {
  const installed = await c.query<{ tbl: string; tgname: string }>(`
    select c.relname as tbl, t.tgname from pg_trigger t
    join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and t.tgname like 'paribelle_sync_%'`);
  for (const r of installed.rows) await c.query(`drop trigger if exists ${q(r.tgname)} on public.${q(r.tbl)}`);
  await c.query(`drop schema if exists paribelle_sync cascade`);
}
