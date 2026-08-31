import { config } from "dotenv";
import { Pool, type QueryResult } from "pg";
import path from "node:path";

// This server runs standalone (outside Next.js) and is spawned by MCP clients
// with an arbitrary (often unrelated) cwd, so .env.local/.env are never picked
// up automatically — resolve them relative to this file, not process.cwd().
// `quiet` matters as much as the path: dotenv's own banner writes to stdout,
// which is the MCP JSON-RPC channel — any extra text there breaks the client's
// JSON parsing.
const projectRoot = path.resolve(__dirname, "..");
config({ path: path.join(projectRoot, ".env.local"), quiet: true });
config({ path: path.join(projectRoot, ".env"), quiet: true });

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set — copy .env.example to .env.local and fill it in.");
  }
  pool = new Pool({ connectionString: url, max: 3 });
  return pool;
}

/** table.column pairs to hide entirely from the schema the model sees. */
const RESTRICTED_COLUMNS = new Set([
  "users.password_hash",
  "users.mfa_secret",
  "channel_accounts.credentials",
  "shipments.label_pdf",
]);

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
  /** Actual type name for USER-DEFINED columns (e.g. enums) — `data_type` alone just says "USER-DEFINED". */
  udt_name: string;
  is_nullable: "YES" | "NO";
}

interface EnumRow {
  enum_name: string;
  enum_value: string;
}

/**
 * Introspects the live database and renders a compact, LLM-friendly schema
 * description — table by table, column types, and enum value lists — with
 * secret-bearing and binary columns stripped out so they never enter a
 * prompt or a generated query.
 */
export async function describeSchema(): Promise<string> {
  const db = getPool();

  const { rows: columns } = await db.query<ColumnRow>(
    `select table_name, column_name, data_type, udt_name, is_nullable
     from information_schema.columns
     where table_schema = 'public'
     order by table_name, ordinal_position`,
  );

  const { rows: enums } = await db.query<EnumRow>(
    `select t.typname as enum_name, e.enumlabel as enum_value
     from pg_type t
     join pg_enum e on t.oid = e.enumtypid
     join pg_catalog.pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public'
     order by t.typname, e.enumsortorder`,
  );

  const enumsByName = new Map<string, string[]>();
  for (const row of enums) {
    const list = enumsByName.get(row.enum_name) ?? [];
    list.push(row.enum_value);
    enumsByName.set(row.enum_name, list);
  }

  const byTable = new Map<string, ColumnRow[]>();
  for (const col of columns) {
    if (RESTRICTED_COLUMNS.has(`${col.table_name}.${col.column_name}`)) continue;
    const list = byTable.get(col.table_name) ?? [];
    list.push(col);
    byTable.set(col.table_name, list);
  }

  const lines: string[] = [];
  for (const [table, cols] of byTable) {
    lines.push(`Table: ${table}`);
    for (const col of cols) {
      const enumValues = enumsByName.get(col.udt_name);
      const type = enumValues ? `enum(${enumValues.join(" | ")})` : col.data_type;
      const nullable = col.is_nullable === "YES" ? "" : " NOT NULL";
      lines.push(`  ${col.column_name}: ${type}${nullable}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Runs a single already-validated SELECT inside a read-only transaction with
 * a short statement timeout, so even a query that slipped past the text
 * guard in sql-guard.ts cannot write to the database or run away.
 */
export async function runReadOnlyQuery(sqlText: string): Promise<QueryResult> {
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = 5000");
    const result = await client.query(sqlText);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
