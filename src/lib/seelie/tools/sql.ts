import "server-only";

import { Type } from "@paribelle/pi-ai";
import { Pool, types, type PoolClient } from "pg";

import { defineTool, ToolError } from "./types";

/**
 * Read-only SQL over the OMS database, for questions no other tool answers.
 *
 * Every query runs in a READ ONLY transaction as `seelie_reader`, a role that can
 * SELECT every table except the secret ones: the users' passwords and MFA keys,
 * the marketplace logins, and Seelie's own chats and settings. A role is what keeps
 * `SELECT *` from leaking a column a word list would miss; the word list below
 * only shuts the ways a query could switch the role back.
 */

const ROLE = "seelie_reader";
const MAX_ROWS = 2000;
const DEFAULT_ROWS = 200;
const CELL_CHARS = 1500;
const TIMEOUT_MS = 20_000;

/** Tables the reader never sees, and the columns it may see of the ones it half sees. */
const HIDDEN_TABLES = ["seelie_chats", "seelie_runs", "seelie_messages", "seelie_tool_calls", "seelie_settings"];
const PARTIAL: Record<string, string[]> = {
  users: ["id", "name", "role", "active", "created_at"],
  channel_accounts: ["id", "channel", "label", "active", "orders_synced_through", "returns_synced_through", "created_at"],
};

/** Ways out of the role or the transaction, and functions that touch the server. */
const FORBIDDEN =
  /\b(set_config|set|reset|query_to_xml|cursor_to_xml|table_to_xml\w*|schema_to_xml\w*|database_to_xml\w*|dblink\w*|copy|pg_read\w*|pg_ls_\w*|pg_stat_file|lo_\w+|pg_sleep\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_promote|pg_advisory\w*|txid_current|commit|rollback|begin|savepoint|prepare|execute|deallocate|listen|notify|vacuum|analyze|lock|do|call|grant|revoke|create|alter|drop|insert|update|delete|merge|truncate|refresh|import|load|discard|checkpoint|cluster|reindex|declare|fetch|move|close)\b/i;

let pool: Pool | null = null;
let readerReady: Promise<void> | null = null;

function getPool() {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new ToolError("DATABASE_URL isn't set.");
    pool = new Pool({ connectionString: url, max: 2 });
  }
  return pool;
}

/**
 * Create the reader role if it's missing and grant it what it may read. Run once
 * per process, so tables added since are covered without a migration.
 */
async function ensureReader(client: PoolClient) {
  await client.query("BEGIN");
  try {
    const { rows } = await client.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [ROLE]);
    if (rows.length === 0) await client.query(`CREATE ROLE ${ROLE} NOLOGIN`);
    // So an owner that isn't a superuser can still switch to it.
    await client.query(`GRANT ${ROLE} TO CURRENT_USER`).catch(() => {});
    await client.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROLE}`);
    const { rows: present } = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)",
      [[...HIDDEN_TABLES, ...Object.keys(PARTIAL)]],
    );
    const has = new Set(present.map((r) => r.tablename));
    for (const table of HIDDEN_TABLES) if (has.has(table)) await client.query(`REVOKE ALL ON ${table} FROM ${ROLE}`);
    for (const [table, columns] of Object.entries(PARTIAL)) {
      if (!has.has(table)) continue;
      await client.query(`REVOKE ALL ON ${table} FROM ${ROLE}`);
      await client.query(`GRANT SELECT (${columns.join(", ")}) ON ${table} TO ${ROLE}`);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

/** The query with comments and quoted text blanked, so the checks see only SQL. */
function bareSql(query: string) {
  return query
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, (m) => m.toLowerCase());
}

function check(query: string): { sql: string; explain: boolean } {
  const sql = query.trim().replace(/;\s*$/, "");
  if (!sql) throw new ToolError("The query is empty.");
  const bare = bareSql(sql);
  if (bare.includes(";")) throw new ToolError("One statement at a time.");
  const first = bare.trim().split(/\s+/)[0]?.toLowerCase();
  if (!["select", "with", "explain", "values", "table"].includes(first ?? "")) {
    throw new ToolError("Only SELECT, WITH, VALUES, TABLE and EXPLAIN queries run here.");
  }
  // EXPLAIN's own word list (ANALYZE etc.) is allowed after it; check the rest.
  const body = first === "explain" ? bare.replace(/^\s*explain\s*(\([^)]*\)|(\s*(analyze|verbose|costs|buffers|format\s+\w+))*)/i, " ") : bare;
  const hit = body.match(FORBIDDEN);
  if (hit) throw new ToolError(`"${hit[0]}" isn't allowed in a read-only query.`);
  return { sql, explain: first === "explain" };
}

/** Dates and times come back as Postgres writes them (in India time, set per query), not as JS Dates in UTC. */
const TEXT_TYPES = new Set([1082, 1083, 1114, 1184, 1266]);
const asText = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    TEXT_TYPES.has(oid) ? (v: string) => v : types.getTypeParser(oid, format)) as typeof types.getTypeParser,
};

/** Postgres's refusal for a half-hidden table, with what can be read of it. */
function explainDenied(message: string) {
  const table = /permission denied for (?:table|relation) (\w+)/.exec(message)?.[1];
  if (!table) return message;
  if (HIDDEN_TABLES.includes(table)) return `${table} is hidden from you.`;
  const columns = PARTIAL[table];
  return columns ? `${message}. Only these columns of ${table} can be read (so no SELECT *): ${columns.join(", ")}.` : message;
}

function cell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return `<${value.length} bytes>`;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value.length > CELL_CHARS ? `${value.slice(0, CELL_CHARS)}… (${value.length} chars)` : value;
  if (typeof value === "object") {
    const json = JSON.stringify(value);
    return json.length > CELL_CHARS ? `${json.slice(0, CELL_CHARS)}… (${json.length} chars)` : value;
  }
  return value;
}

export const sqlQuery = defineTool({
  name: "sql_query",
  label: "SQL",
  description: [
    "Run one read-only SQL query (PostgreSQL 16) on the OMS database, for anything the other tools don't cover:",
    "counts, trends, joins across orders/items/returns/money, checking data. One statement; SELECT, WITH, VALUES,",
    "TABLE or EXPLAIN only. The session runs in India time: timestamps come back in IST (+05:30), and now(), ::date and",
    "date_trunc work on IST days. Money columns are numeric rupees. Hidden from you: passwords and logins (users shows only id, name, role, active; channel_accounts",
    "has no credentials) and Seelie's own tables. Call `sql_schema` first if you don't know the columns.",
  ].join(" "),
  parameters: Type.Object({
    query: Type.String({ description: "The SQL. No trailing statements." }),
    maxRows: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_ROWS, description: `Rows to return (default ${DEFAULT_ROWS}). Aggregate instead of pulling thousands.` }),
    ),
  }),
  kind: "read",
  summary: (a) => a.query.replace(/\s+/g, " ").slice(0, 160),
  async execute(args) {
    const { sql, explain } = check(args.query);
    const limit = args.maxRows ?? DEFAULT_ROWS;
    const client = await getPool().connect();
    try {
      readerReady ??= ensureReader(client).catch((err) => {
        readerReady = null;
        throw new ToolError(`SQL isn't available here: ${err instanceof Error ? err.message : String(err)}`);
      });
      await readerReady;

      await client.query("BEGIN READ ONLY");
      await client.query(`SET LOCAL ROLE ${ROLE}`);
      await client.query(`SET LOCAL statement_timeout = ${TIMEOUT_MS}`);
      await client.query("SET LOCAL TIME ZONE 'Asia/Kolkata'");
      const started = Date.now();
      const res = await client.query({
        text: explain ? sql : `SELECT * FROM (\n${sql}\n) AS seelie_q LIMIT ${limit + 1}`,
        rowMode: "array",
        types: asText,
      });
      const rows = (res.rows as unknown[][]).slice(0, limit).map((r) => r.map(cell));
      return {
        data: {
          columns: res.fields.map((f) => f.name),
          rows,
          rowCount: rows.length,
          more: !explain && res.rows.length > limit,
          ms: Date.now() - started,
        },
      };
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(explainDenied(err instanceof Error ? err.message : String(err)));
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  },
});

export const sqlSchema = defineTool({
  name: "sql_schema",
  label: "Database tables",
  description:
    "List the OMS database's tables with their columns and types (and enum values), or just the tables named. Use before writing sql_query.",
  parameters: Type.Object({
    tables: Type.Optional(Type.Array(Type.String(), { description: "Only these tables. Omit for all." })),
  }),
  kind: "read",
  summary: (a) => (a.tables?.length ? a.tables.join(", ") : "All tables"),
  async execute(args) {
    const client = await getPool().connect();
    try {
      const { rows } = await client.query<{ table_name: string; column_name: string; data_type: string; udt_name: string; is_nullable: string }>(
        `SELECT c.table_name, c.column_name, c.data_type, c.udt_name, c.is_nullable
         FROM information_schema.columns c
         JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
         WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
           AND ($1::text[] IS NULL OR c.table_name = ANY($1))
         ORDER BY c.table_name, c.ordinal_position`,
        [args.tables?.length ? args.tables : null],
      );
      const { rows: enums } = await client.query<{ name: string; values: string[] }>(
        `SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid GROUP BY t.typname`,
      );
      const enumOf = new Map(enums.map((e) => [e.name, e.values]));
      const tables: Record<string, string[]> = {};
      for (const r of rows) {
        if (HIDDEN_TABLES.includes(r.table_name)) continue;
        const allowed = PARTIAL[r.table_name];
        if (allowed && !allowed.includes(r.column_name)) continue;
        const type = r.data_type === "USER-DEFINED" ? `enum(${(enumOf.get(r.udt_name) ?? []).join("|")})` : r.data_type === "ARRAY" ? `${r.udt_name.replace(/^_/, "")}[]` : r.data_type;
        (tables[r.table_name] ??= []).push(`${r.column_name} ${type}${r.is_nullable === "YES" ? "" : " not null"}`);
      }
      return {
        text: Object.entries(tables)
          .map(([t, cols]) => `${t}: ${cols.join(", ")}`)
          .join("\n"),
      };
    } finally {
      client.release();
    }
  },
});
