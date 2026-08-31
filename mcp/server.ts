#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { describeSchema, runReadOnlyQuery } from "./db";
import { assertSafeSelect, withRowLimit, UnsafeSqlError } from "./sql-guard";

/**
 * Natural-language access to the Paribelle OMS database.
 *
 * There's no embedded LLM call here — the MCP client calling this server
 * (Claude Desktop, Claude Code, etc.) is already an LLM. `get_schema` gives
 * it what it needs to translate a question into SQL itself; `run_sql`
 * validates that SQL (sql-guard.ts) and executes it inside a read-only
 * transaction (db.ts), so a model-written query can only ever read, never
 * write, regardless of what it was asked to produce.
 */
const server = new McpServer({ name: "paribelle-oms-db", version: "1.0.0" });

server.registerTool(
  "get_schema",
  {
    title: "Get the database schema",
    description:
      "Returns the live PostgreSQL schema (tables, columns, types, enum values) for the OMS database — " +
      "orders, inventory, returns, shipments, channels, users. Call this first, then translate the " +
      "user's question into SQL yourself and pass it to run_sql. Secret-bearing and binary columns " +
      "(password hashes, MFA secrets, channel API credentials, label PDFs) are omitted and cannot be " +
      "queried.",
    inputSchema: {},
  },
  async () => {
    const schemaText = await describeSchema();
    return {
      content: [
        {
          type: "text",
          text:
            `${schemaText}\n\n` +
            "Write a single read-only PostgreSQL SELECT statement (a leading WITH is fine) against this " +
            "schema, using only the tables/columns above, then call run_sql with it.",
        },
      ],
    };
  },
);

server.registerTool(
  "run_sql",
  {
    title: "Run a read-only SQL query",
    description:
      "Executes a SQL query you've written against the OMS database and returns the rows. Call " +
      "get_schema first if you haven't already, to know what tables/columns exist. Only a single " +
      "read-only SELECT (optionally starting with WITH) is accepted — anything else is rejected before " +
      "it reaches the database. Results are capped at 200 rows; add your own LIMIT for fewer.",
    inputSchema: {
      sql: z.string().min(3).describe("A single read-only PostgreSQL SELECT statement."),
    },
  },
  async ({ sql }) => {
    let safeSql: string;
    try {
      safeSql = withRowLimit(assertSafeSelect(sql));
    } catch (err) {
      const message = err instanceof UnsafeSqlError ? err.message : String(err);
      return {
        content: [{ type: "text", text: `Query rejected: ${message}` }],
        isError: true,
      };
    }

    try {
      const result = await runReadOnlyQuery(safeSql);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ sql: safeSql, rowCount: result.rowCount, rows: result.rows }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Query failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error starting paribelle-oms-db MCP server:", err);
  process.exit(1);
});
