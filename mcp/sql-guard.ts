/**
 * Defense-in-depth for LLM-generated SQL before it ever reaches the database.
 * This is not the only guard — runReadOnlyQuery() (db.ts) also runs every
 * query inside a `BEGIN TRANSACTION READ ONLY` with a statement timeout, so a
 * write that slips past these checks is still rejected by Postgres itself.
 */

const FORBIDDEN_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "truncate",
  "grant",
  "revoke",
  "create",
  "copy",
  "call",
  "execute",
  "merge",
  "vacuum",
  "reindex",
  "cluster",
  "listen",
  "notify",
  "unlisten",
  "prepare",
  "lock",
  "refresh", // REFRESH MATERIALIZED VIEW
] as const;

/** System functions with side effects or that can be used to exfiltrate/DoS. */
const FORBIDDEN_FUNCTIONS = [
  "pg_sleep",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "dblink",
  "lo_import",
  "lo_export",
  "set_config",
] as const;

/** Columns that hold secrets or large binaries — never let the model see or select these. */
const RESTRICTED_COLUMN_PATTERNS = [/password_hash/i, /mfa_secret/i, /\bcredentials\b/i, /label_pdf/i];

export class UnsafeSqlError extends Error {}

/**
 * Throws if `sqlText` is anything other than a single read-only SELECT (a
 * leading CTE via WITH is allowed). Returns the trimmed, semicolon-free
 * statement on success.
 */
export function assertSafeSelect(sqlText: string): string {
  const trimmed = sqlText.trim().replace(/;+\s*$/, "");
  if (!trimmed) throw new UnsafeSqlError("Empty SQL statement.");
  if (trimmed.includes(";")) {
    throw new UnsafeSqlError("Only a single SQL statement is allowed.");
  }
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new UnsafeSqlError("Only SELECT statements (optionally starting with WITH) are allowed.");
  }

  const lowered = trimmed.toLowerCase();

  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${kw}\\b`).test(lowered)) {
      throw new UnsafeSqlError(`Statement contains a disallowed keyword: ${kw}`);
    }
  }
  for (const fn of FORBIDDEN_FUNCTIONS) {
    if (lowered.includes(fn)) {
      throw new UnsafeSqlError(`Statement calls a disallowed function: ${fn}`);
    }
  }
  for (const pattern of RESTRICTED_COLUMN_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new UnsafeSqlError("Statement references a restricted column.");
    }
  }

  return trimmed;
}

/** Appends a LIMIT if the query doesn't already have one, so a broad question can't return the whole table. */
export function withRowLimit(sqlText: string, maxRows = 200): string {
  if (/\blimit\s+\d+\s*$/i.test(sqlText.trim())) return sqlText;
  return `${sqlText}\nLIMIT ${maxRows}`;
}
