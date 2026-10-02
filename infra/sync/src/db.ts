import pg from "pg";

/** One line of JSON per event, so `docker compose logs sync` stays greppable. */
export function log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The message of anything thrown, without the stack. */
export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A connection string with its password replaced, for logs and the status page. */
export function redact(url: string): string {
  return url.replace(/\/\/([^:/@]+):[^@]*@/, "//$1:***@");
}

function isLocalHost(host: string) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || !host.includes(".");
}

/**
 * A pool for one database. TLS is on for anything that isn't a compose service
 * or localhost, without verifying the chain: Supabase's poolers present a
 * certificate from their own CA, and `sslmode` in the URL is taken out because
 * node-postgres now reads `require` as "verify-full".
 */
export function makePool(url: string, max: number, name: string): pg.Pool {
  const u = new URL(url);
  const sslmode = u.searchParams.get("sslmode");
  u.searchParams.delete("sslmode");
  const ssl = sslmode === "disable" || (isLocalHost(u.hostname) && sslmode !== "require") ? false : { rejectUnauthorized: false };
  const pool = new pg.Pool({
    connectionString: u.toString(),
    ssl,
    max,
    application_name: name,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 10_000,
    // Longer than any single statement the sync runs; a hung pooler must not hang the loop.
    query_timeout: 120_000,
    keepAlive: true,
  });
  // An idle client losing its socket (Wi-Fi drop, pooler restart) must not crash the process.
  pool.on("error", (e) => log("warn", "idle connection dropped", { pool: name, error: errText(e) }));
  return pool;
}

export type Client = pg.PoolClient;

export interface TxOptions {
  /** A single snapshot for every statement: needed to read the change log without gaps. */
  repeatableRead?: boolean;
  readOnly?: boolean;
  /** Writes made in this transaction are not logged, so they don't echo back. */
  applying?: boolean;
}

/** Runs `fn` in a transaction on its own client, committing on success. */
export async function tx<T>(pool: pg.Pool, opts: TxOptions, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    const mode = [opts.repeatableRead ? "isolation level repeatable read" : "", opts.readOnly ? "read only" : ""]
      .filter(Boolean)
      .join(" ");
    await c.query(`begin ${mode}`);
    await c.query("set local timezone = 'UTC'");
    if (opts.applying) await c.query("set local paribelle_sync.applying = 'on'");
    const out = await fn(c);
    await c.query("commit");
    c.release();
    return out;
  } catch (e) {
    await discard(c, e);
    throw e;
  }
}

/**
 * Gives up on a client whose transaction failed: rolls back if it can still be
 * talked to, then closes it instead of returning it to the pool. After a
 * `query_timeout` the statement may still be running in the database, so a
 * rollback would queue behind it; and a client handed back mid-transaction
 * fails every query of whoever borrows it next (on 2026-10-02 that was the
 * cloud check, and the sync halted, sure the cloud had lost its schema).
 */
export async function discard(c: pg.PoolClient, e: unknown) {
  if (!isClientTimeout(e)) await c.query("rollback").catch(() => {});
  c.release(true);
}

/** node-postgres giving up on a statement (`query_timeout`); the database may still be running it. */
export function isClientTimeout(e: unknown): boolean {
  return errText(e) === "Query read timeout";
}

/** Double-quotes an identifier. */
export function q(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

/** A single-quoted SQL literal. */
export function lit(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Password failures and pooler refusals: retrying fast gets the whole Supabase project blocked. */
export function isAuthError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  const msg = errText(e);
  return (
    code === "28P01" ||
    code === "28000" ||
    /password authentication failed|too many (connections|authentication)|circuit breaker|banned|ECIRCUITBREAKER/i.test(msg)
  );
}

/**
 * Errors that say nothing about the row being written (a deadlock, a timeout,
 * a dropped connection): the whole transaction is retried rather than the row
 * being set aside as unappliable.
 */
export function isTransient(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  if (!code) return true;
  return /^(40001|40P01|55P03|57014|57P0[1-3]|53\d{3}|08\w{3})$/.test(code);
}
