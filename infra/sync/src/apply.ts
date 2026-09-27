import { errText, isTransient, lit, log, q, type Client } from "./db.ts";
import type { Column, Meta, Table } from "./schema.ts";

/** A change's time as microseconds, exact enough to order two writes in the same millisecond. */
const micros = (expr: string) => `(extract(epoch from ${expr}) * 1000000)::bigint::text`;
const MICROS = micros("at");

export type Side = "local" | "cloud";

/** One row of `paribelle_sync.changes`. `pk` is the key as canonical jsonb text. */
export interface Entry {
  txid: string;
  tbl: string;
  pk: string | null;
  op: string;
  /** When it changed, in microseconds since 1970 (a Date would round to milliseconds). */
  at: bigint;
}

type Raw = Omit<Entry, "at"> & { at: string };
const toEntry = (r: Raw): Entry => ({ ...r, at: BigInt(r.at) });

export interface ReadResult {
  entries: Entry[];
  /** Where the next read starts. */
  next: string;
  /** Everything below this transaction id had finished when the log was read. */
  xmin: string;
  /** More was waiting than one page holds. */
  full: boolean;
}

/**
 * Reads changes committed since `from`, without gaps. Must run inside a
 * REPEATABLE READ transaction. Every transaction with an id below the
 * snapshot's xmin has finished, so reading `[from, xmin)` can never skip one
 * that commits later: the next read starts at xmin. A transaction still
 * running holds xmin down, which only delays the sync, never loses a change.
 */
export async function readChanges(c: Client, from: string, limit: number): Promise<ReadResult> {
  const { rows: [{ xmin }] } = await c.query<{ xmin: string }>(
    "select pg_snapshot_xmin(pg_current_snapshot())::text as xmin",
  );
  const { rows: raw } = await c.query<Raw>(
    `select txid::text as txid, tbl, pk::text as pk, op, ${MICROS} as at from paribelle_sync.changes
     where txid >= $1::xid8 and txid < $2::xid8 order by txid, id limit $3`,
    [from, xmin, limit + 1],
  );
  const rows = raw.map(toEntry);
  if (rows.length <= limit) return { entries: rows, next: xmin, xmin, full: false };

  // A full page: stop before the last transaction, which may continue past the page,
  // unless that one transaction is the whole page, in which case read all of it.
  const lastTx = rows[limit - 1].txid;
  if (rows[0].txid === lastTx) {
    const all = await c.query<Raw>(
      `select txid::text as txid, tbl, pk::text as pk, op, ${MICROS} as at from paribelle_sync.changes
       where txid = $1::xid8 order by id`,
      [lastTx],
    );
    return { entries: all.rows.map(toEntry), next: (BigInt(lastTx) + 1n).toString(), xmin, full: true };
  }
  return { entries: rows.filter((r) => r.txid !== lastTx), next: lastTx, xmin, full: true };
}

/** The changes of one read, one entry per row: the latest time each key changed. */
export interface Changeset {
  keys: Map<string, Map<string, bigint>>;
  truncated: Set<string>;
}

export function group(entries: Entry[]): Changeset {
  const keys = new Map<string, Map<string, bigint>>();
  const truncated = new Set<string>();
  for (const e of entries) {
    if (e.op === "T" || e.pk === null) {
      truncated.add(e.tbl);
      continue;
    }
    let m = keys.get(e.tbl);
    if (!m) keys.set(e.tbl, (m = new Map()));
    const prev = m.get(e.pk);
    if (!prev || prev < e.at) m.set(e.pk, e.at);
  }
  return { keys, truncated };
}

export function size(cs: Changeset): number {
  let n = 0;
  for (const m of cs.keys.values()) n += m.size;
  return n;
}

/** The expression that turns a row alias into its canonical key text, as the capture trigger writes it. */
export function pkExpr(alias: string, t: Table): string {
  return `jsonb_build_object(${t.pk.map((c) => `${lit(c)}, ${alias}.${q(c)}`).join(", ")})::text`;
}

/** `(alias.a, alias.b) in (keys from a jsonb array in $n)` */
function keyMatch(alias: string, t: Table, param: string): string {
  const cols = t.pk.map((c) => `${alias}.${q(c)}`).join(", ");
  const vals = t.pk.map((c, i) => `(e->>${lit(c)})::${t.pkTypes[i]}`).join(", ");
  return `(${cols}) in (select ${vals} from jsonb_array_elements(${param}::jsonb) e)`;
}

const jsonArray = (items: string[]) => `[${items.join(",")}]`;

function chunk<T>(items: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Rows with label PDFs or video chunks in them are fetched a few at a time. */
function chunkSize(t: Table) {
  return t.columns.some((c) => c.bytea) ? 10 : 500;
}

/**
 * The current version of each key, as jsonb text, or absent from the map when
 * the row no longer exists (a delete).
 */
export async function fetchRows(c: Client, t: Table, keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const part of chunk(keys, chunkSize(t))) {
    const r = await c.query<{ k: string; r: string }>(
      `select ${pkExpr("t", t)} as k, to_jsonb(t)::text as r from public.${q(t.name)} t where ${keyMatch("t", t, "$1")}`,
      [jsonArray(part)],
    );
    for (const row of r.rows) out.set(row.k, row.r);
  }
  return out;
}

/** Every key of a table with a hash of its row (common columns only), for reconciling. */
export async function hashRows(c: Client, t: Table, drop: string[]): Promise<Map<string, string>> {
  const minus = drop.length ? ` - array[${drop.map(lit).join(", ")}]::text[]` : "";
  const r = await c.query<{ k: string; h: string }>(
    `select ${pkExpr("t", t)} as k, md5((to_jsonb(t)${minus})::text) as h from public.${q(t.name)} t`,
  );
  return new Map(r.rows.map((x) => [x.k, x.h]));
}

export interface Conflict {
  tbl: string;
  pk: string;
  kept: Side | "none";
  lostRow: string | null;
  reason: string;
}

export interface ApplyInput {
  /** The side being written to. */
  side: Side;
  target: Client;
  /** The target's own changes from here on have not been read yet: a newer one there wins. */
  pendingFrom: string;
  /** Which tables, parents first. */
  order: string[];
  /** Target table metadata, restricted to the columns both sides have. */
  tables: Map<string, Table>;
  fks: Meta["fks"];
  /** Per table: key → when it changed at the source. */
  changedAt: Map<string, Map<string, bigint>>;
  /** Per table: key → row json at the source; a key missing here was deleted there. */
  rows: Map<string, Map<string, string>>;
  /** Keys that must not be written (rows pruned from the cloud stay pruned). */
  skip?: (tbl: string, keys: string[]) => Promise<Set<string>>;
  /** Puts back parents the target lacks (the cloud, after pruning). */
  ensureParents?: (tbl: string, rows: string[]) => Promise<void>;
  /** When true, a newer pending change on the target always wins (reconcile). */
  yieldToPending?: boolean;
}

export interface ApplyResult {
  upserted: Map<string, number>;
  deleted: number;
  conflicts: Conflict[];
}

/** The target's unread changes for these keys, with when each last changed. */
async function pending(c: Client, from: string, tbl: string, keys: string[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  for (const part of chunk(keys, 5000)) {
    const r = await c.query<{ k: string; at: string }>(
      `select pk::text as k, ${micros("max(at)")} as at from paribelle_sync.changes
       where txid >= $1::xid8 and tbl = $2 and pk::text = any($3::text[]) group by pk::text`,
      [from, tbl, part],
    );
    for (const row of r.rows) out.set(row.k, BigInt(row.at));
  }
  return out;
}

function upsertSql(t: Table): string {
  const cols = t.columns.filter((c) => !c.generated);
  const names = cols.map((c) => q(c.name)).join(", ");
  const overriding = cols.some((c) => c.identityAlways) ? " overriding system value" : "";
  const rest = cols.filter((c) => !t.pk.includes(c.name));
  const action = rest.length
    ? `do update set ${rest.map((c) => `${q(c.name)} = excluded.${q(c.name)}`).join(", ")}`
    : "do nothing";
  return `insert into public.${q(t.name)} as t (${names})${overriding}
    select ${names} from jsonb_populate_recordset(null::public.${q(t.name)}, $1::jsonb)
    on conflict (${t.pk.map(q).join(", ")}) ${action}`;
}

function deleteSql(t: Table): string {
  return `delete from public.${q(t.name)} t where ${keyMatch("t", t, "$1")}`;
}

/**
 * Runs `sql` for all keys at once, and on failure one key at a time so one bad
 * row can't block the rest. A failure that isn't about the row (deadlock,
 * timeout, lost connection) is thrown, so the cycle retries it all later.
 */
async function writeRows(
  c: Client,
  sql: string,
  items: { key: string; json: string }[],
  fail: (key: string, json: string, e: unknown) => void,
): Promise<number> {
  if (!items.length) return 0;
  await c.query("savepoint batch");
  try {
    await c.query(sql, [jsonArray(items.map((i) => i.json))]);
    await c.query("release savepoint batch");
    return items.length;
  } catch (e) {
    if (isTransient(e)) throw e;
    await c.query("rollback to savepoint batch");
  }
  // Row by row. A missing parent may be a row later in this same list, so those get a few more passes.
  let todo = items;
  let written = 0;
  for (let pass = 0; pass < 4 && todo.length; pass++) {
    const retry: typeof items = [];
    for (const item of todo) {
      await c.query("savepoint one");
      try {
        await c.query(sql, [jsonArray([item.json])]);
        await c.query("release savepoint one");
        written++;
      } catch (e) {
        if (isTransient(e)) throw e;
        await c.query("rollback to savepoint one");
        if ((e as { code?: string }).code === "23503" && pass < 3) retry.push(item);
        else fail(item.key, item.json, e);
      }
    }
    if (retry.length === todo.length) {
      for (const item of retry) fail(item.key, item.json, new Error("foreign key: the row it points to is missing"));
      break;
    }
    todo = retry;
  }
  return written;
}

/**
 * Writes one batch of changes into the target, inside the caller's transaction
 * (which has `paribelle_sync.applying` on, so none of it is logged again).
 *
 * Deletes go first, children before parents; then inserts and updates,
 * parents before children. Before touching a key, its row is locked and the
 * target's own unread changes are checked: if the target changed the same row
 * later than the source did, the target's version stays (it goes the other
 * way on the next cycle) and the source's is recorded as a conflict.
 */
export async function applyChanges(a: ApplyInput): Promise<ApplyResult> {
  const result: ApplyResult = { upserted: new Map(), deleted: 0, conflicts: [] };
  const other: Side = a.side === "local" ? "cloud" : "local";

  // Decide per key: write it, or let the target's newer change stand.
  const plan = new Map<string, { del: string[]; up: { key: string; json: string }[] }>();
  for (const tbl of a.order) {
    const changed = a.changedAt.get(tbl);
    const t = a.tables.get(tbl);
    if (!changed?.size || !t) continue;
    const keys = [...changed.keys()];
    const rows = a.rows.get(tbl) ?? new Map<string, string>();

    for (const part of chunk(keys, 5000)) {
      await a.target.query(`select 1 from public.${q(tbl)} t where ${keyMatch("t", t, "$1")} for update`, [jsonArray(part)]);
    }
    const theirs = await pending(a.target, a.pendingFrom, tbl, keys);
    const skip = a.skip ? await a.skip(tbl, keys) : new Set<string>();
    const p = { del: [] as string[], up: [] as { key: string; json: string }[] };
    const overwritten: string[] = [];

    for (const key of keys) {
      const row = rows.get(key);
      const targetAt = theirs.get(key);
      if (targetAt && (a.yieldToPending || targetAt > changed.get(key)!)) {
        if (!a.yieldToPending) {
          result.conflicts.push({ tbl, pk: key, kept: a.side, lostRow: row ?? null, reason: `changed on both sides; ${a.side} was later` });
        }
        continue;
      }
      if (targetAt) overwritten.push(key);
      if (row === undefined) p.del.push(key);
      else if (!skip.has(key)) p.up.push({ key, json: row });
    }
    // The target's own newer-but-losing version is kept in the conflict, so nothing is gone for good.
    if (overwritten.length) {
      const before = await fetchRows(a.target, t, overwritten);
      for (const key of overwritten) {
        result.conflicts.push({ tbl, pk: key, kept: other, lostRow: before.get(key) ?? null, reason: `changed on both sides; ${other} was later` });
      }
    }
    plan.set(tbl, p);
  }

  const fail = (tbl: string) => (key: string, json: string | null, e: unknown) => {
    result.conflicts.push({ tbl, pk: key, kept: "none", lostRow: json, reason: `${errText(e)} (${(e as { code?: string }).code ?? "error"})` });
    log("warn", "row not applied", { side: a.side, table: tbl, key, error: errText(e) });
  };

  for (const tbl of [...a.order].reverse()) {
    const p = plan.get(tbl);
    const t = a.tables.get(tbl);
    if (!p?.del.length || !t) continue;
    const f = fail(tbl);
    result.deleted += await writeRows(a.target, deleteSql(t), p.del.map((k) => ({ key: k, json: k })), (k, _j, e) => f(k, null, e));
  }

  for (const tbl of a.order) {
    const p = plan.get(tbl);
    const t = a.tables.get(tbl);
    if (!p?.up.length || !t) continue;
    if (a.ensureParents) await a.ensureParents(tbl, p.up.map((u) => u.json));
    const n = await writeRows(a.target, upsertSql(t), p.up, fail(tbl));
    if (n) result.upserted.set(tbl, n);
  }
  return result;
}

/**
 * Keys of `parent` that the rows point to but the target doesn't have. Only for
 * foreign keys onto the parent's primary key; others are left to fail and be
 * recorded.
 */
export async function missingParents(
  c: Client,
  fk: Meta["fks"][number],
  parent: Table,
  rows: string[],
): Promise<string[]> {
  if (fk.parentCols.join() !== parent.pk.join()) return [];
  const casts = fk.childCols.map((col, i) => `(r->>${lit(col)})::${parent.pkTypes[i]}`);
  const build = `jsonb_build_object(${parent.pk.map((pc, i) => `${lit(pc)}, ${casts[i]}`).join(", ")})::text`;
  const notNull = fk.childCols.map((col) => `r->>${lit(col)} is not null`).join(" and ");
  const exists = `select 1 from public.${q(parent.name)} p where (${parent.pk.map((pc) => `p.${q(pc)}`).join(", ")}) = (${casts.join(", ")})`;
  const out: string[] = [];
  for (const part of chunk(rows, 500)) {
    const r = await c.query<{ k: string }>(
      `select distinct ${build} as k from jsonb_array_elements($1::jsonb) r where ${notNull} and not exists (${exists})`,
      [jsonArray(part)],
    );
    out.push(...r.rows.map((x) => x.k));
  }
  return out;
}

/** Target metadata cut down to the columns the source has too. */
export function commonTables(target: Meta, source: Meta, names: string[]): Map<string, Table> {
  const out = new Map<string, Table>();
  for (const n of names) {
    const t = target.tables.get(n);
    const s = source.tables.get(n);
    if (!t || !s) continue;
    const have = new Set(s.columns.map((c) => c.name));
    const columns: Column[] = t.columns.filter((c) => have.has(c.name));
    out.set(n, { ...t, columns });
  }
  return out;
}
