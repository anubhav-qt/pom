# paribelle-oms-db MCP server

Gives an MCP client (Claude Desktop, Claude Code, etc.) natural-language read access to the OMS
database. There's no embedded LLM here — the calling client already has one; this server just
gives it a safe way to see the schema and run the SQL it writes.

## Tools

- **`get_schema`** — returns the live schema (tables, columns, types, enum values). Call this
  first so the model knows what it can query.
- **`run_sql`** — executes a SQL query the model wrote and returns the rows (capped at 200).

## Safety

- Every query passed to `run_sql` is checked in [`sql-guard.ts`](sql-guard.ts): must be a single
  `SELECT` (or `WITH ... SELECT`), no DDL/DML keywords anywhere (including inside a CTE), no
  dangerous system functions, and a `LIMIT` is added if missing.
- Execution additionally runs inside a `BEGIN TRANSACTION READ ONLY` with a 5s statement timeout
  ([`db.ts`](db.ts)) — belt-and-suspenders in case a query slips past the text guard.
- `password_hash`, `mfa_secret`, `channel_accounts.credentials`, and `shipments.label_pdf` are
  stripped out of the schema `get_schema` returns, and are also blocked by name if `run_sql`
  somehow gets asked for them anyway.

## Running

Only `DATABASE_URL` is required (in `.env.local`, same as the rest of the app) — no API key.

```bash
npm run mcp:db
```

This starts the server on stdio and blocks — it's meant to be launched by an MCP client, not run
standalone. To try it manually, use the MCP inspector:

```bash
npx @modelcontextprotocol/inspector npm run mcp:db
```

## Connecting a client

**Claude Code** — from this project directory:

```bash
claude mcp add paribelle-oms-db -- npm run mcp:db
```

**Claude Desktop** — add to its config file (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "paribelle-oms-db": {
      "command": "npm",
      "args": ["run", "mcp:db"],
      "cwd": "F:\\oms"
    }
  }
}
```

Restart the client after editing the config. Once connected, ask it something like "how many
orders are past their dispatch deadline?" — it'll call `get_schema`, write the SQL, and call
`run_sql`.
