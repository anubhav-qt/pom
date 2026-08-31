/**
 * The SQL guard lives in the app so the in-app assistant and this standalone
 * server share one definition of "safe". Kept as a thin re-export here rather
 * than a copy — see src/lib/assistant/sql-guard.ts for the implementation.
 */
export * from "../src/lib/assistant/sql-guard";
