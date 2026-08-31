import { tool } from "@langchain/core/tools";
import { Pool, type QueryResult } from "pg";
import { z } from "zod";

import { assertSafeSelect, UnsafeSqlError, withRowLimit } from "./sql-guard";

/**
 * In-process `get_schema` / `run_sql` for the assistant — the freeform
 * escape hatch for questions the fixed tools in tools.ts don't cover.
 *
 * This used to be the mcp/ server loaded as a child process over stdio
 * (mcp-tools.ts). That can't run on serverless — no `tsx` at runtime, no
 * long-lived subprocess — so the same two capabilities are implemented here
 * against a small dedicated pool. The standalone mcp/ server still exists for
 * connecting Claude Desktop / Claude Code to the database locally; both paths
 * share sql-guard.ts so "safe SQL" means the same thing in both.
 */

let pool: Pool | null = null;

function getPool(): Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set — the assistant's SQL tools need it.");
  }
  // Small and separate from the app's main pool: these queries run inside a
  // READ ONLY transaction with a hard statement timeout, and keeping them off
  // the request-path pool means a slow ad-hoc query can't starve it. SSL is
  // taken from the connection string (sslmode=...), same as src/db/index.ts.
  pool = new Pool({ connectionString: url, max: 2 });
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
async function describeSchema(): Promise<string> {
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
async function runReadOnlyQuery(sqlText: string): Promise<QueryResult> {
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

export const getSchemaTool = tool(
  async () => {
    const schemaText = await describeSchema();
    return (
      `${schemaText}\n\n` +
      "Write a single read-only PostgreSQL SELECT statement (a leading WITH is fine) against this " +
      "schema, using only the tables/columns above, then call run_sql with it."
    );
  },
  {
    name: "get_schema",
    description:
      "Returns the live PostgreSQL schema (tables, columns, types, enum values) for the OMS database — " +
      "orders, inventory, returns, shipments, channels, users. Call this first when you need run_sql, " +
      "then translate the question into SQL yourself. Secret-bearing and binary columns (password " +
      "hashes, MFA secrets, channel API credentials, label PDFs) are omitted and cannot be queried.",
    schema: z.object({}),
  },
);

export const runSqlTool = tool(
  async ({ sql }) => {
    let safeSql: string;
    try {
      safeSql = withRowLimit(assertSafeSelect(sql));
    } catch (err) {
      const message = err instanceof UnsafeSqlError ? err.message : String(err);
      return JSON.stringify({ error: `Query rejected: ${message}` });
    }

    try {
      const result = await runReadOnlyQuery(safeSql);
      return JSON.stringify({ sql: safeSql, rowCount: result.rowCount, rows: result.rows });
    } catch (err) {
      return JSON.stringify({ error: `Query failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  },
  {
    name: "run_sql",
    description:
      "Executes a SQL query you've written against the OMS database and returns the rows. Call " +
      "get_schema first if you haven't already. Only a single read-only SELECT (optionally starting " +
      "with WITH) is accepted — anything else is rejected before it reaches the database. Results are " +
      "capped at 200 rows; add your own LIMIT for fewer.",
    schema: z.object({
      sql: z.string().min(3).describe("A single read-only PostgreSQL SELECT statement."),
    }),
  },
);

/** Freeform DB tools, offered alongside the fixed tools in every assistant call. */
export const ASSISTANT_DB_TOOLS = [getSchemaTool, runSqlTool];
