/**
 * Apply one drizzle SQL migration file, statement by statement.
 *
 *   npx tsx scripts/apply-migration.ts drizzle/0002_vengeful_vermin.sql
 *
 * This schema is maintained with `db:push` and has no `__drizzle_migrations`
 * journal, so `drizzle-kit migrate` has nothing to work from and `push` would
 * diff the whole schema. Applying a reviewed file directly is the narrow,
 * predictable option: it runs exactly the statements in front of you and
 * nothing else.
 *
 * Statements are split on drizzle's own `--> statement-breakpoint` marker.
 */
import { config } from "dotenv";
import * as fs from "node:fs";

config({ path: ".env.local" });
config({ path: ".env" });

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: tsx scripts/apply-migration.ts <path-to-.sql>");
    process.exit(1);
  }

  const { db } = await import("../src/db");
  const { sql } = await import("drizzle-orm");

  const statements = fs
    .readFileSync(file, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^(--[^\n]*\n?)+$/.test(s));

  console.log(`\nApplying ${file} — ${statements.length} statements.\n`);

  for (const [i, statement] of statements.entries()) {
    const first = statement.split("\n").find((l) => l.trim() && !l.trim().startsWith("--")) ?? "";
    console.log(`  ${i + 1}/${statements.length}  ${first.trim().slice(0, 80)}`);
    await db.execute(sql.raw(statement));
  }

  console.log("\nDone.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error("\nMigration failed:\n", err);
  process.exit(1);
});
