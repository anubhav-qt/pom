/**
 * Repair sweep — re-read order-level state for every order we hold and correct
 * whatever has drifted.
 *
 *   npm run reconcile:amazon                     # everything since the oldest order
 *   npm run reconcile:amazon -- --from 2026-08-01
 *
 * Two things this fixes that neither the fast lane nor the backfill can:
 * statuses that changed on Amazon while nothing was syncing (and are now behind
 * the cursor), and `delivered`, which the All Orders report cannot express
 * because it carries no Easy Ship status column.
 *
 * Cheap by design: it runs `statusOnly`, so orders we already hold never re-pay
 * for their line items. Worth running after any backfill, and occasionally as
 * a backstop.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const { db } = await import("../src/db");
  const { channelAccounts, orders } = await import("../src/db/schema");
  const { eq, sql } = await import("drizzle-orm");
  const { reconcileAccount } = await import("../src/lib/sync");

  const accounts = await db
    .select()
    .from(channelAccounts)
    .where(eq(channelAccounts.channel, "amazon"));

  const account =
    accounts.find((a) =>
      String((a.credentials as Record<string, string>)?.refreshToken ?? "").startsWith("Atzr|"),
    ) ?? accounts[0];

  if (!account) {
    console.error("No Amazon channel account found. Add one under Settings first.");
    process.exit(1);
  }

  // Default to the oldest order we hold — there is nothing before it to repair.
  const [{ oldest }] = await db
    .select({ oldest: sql<string | null>`min(${orders.orderedAt})` })
    .from(orders)
    .where(eq(orders.channelAccountId, account.id));

  const from = arg("from")
    ? new Date(arg("from")!)
    : oldest
      ? new Date(new Date(oldest).getTime() - 86_400_000)
      : new Date(Date.now() - 183 * 86_400_000);

  if (Number.isNaN(from.getTime())) {
    console.error(`Not a date: "${arg("from")}". Use YYYY-MM-DD.`);
    process.exit(1);
  }

  console.log(`\nReconciling "${account.label}" from ${from.toISOString().slice(0, 10)}.\n`);

  let lastTick = 0;
  const res = await reconcileAccount(account, {
    since: from,
    onProgress: ({ seen, total }) => {
      if (seen - lastTick < 100 && seen !== total) return;
      lastTick = seen;
      console.log(`  ${seen}/${total}`);
    },
  });

  if (res.skipped) {
    console.log(`Skipped: ${res.reason}\n`);
    process.exit(0);
  }

  console.log(
    `\nDone. sync_runs #${res.runId}: ${res.seen} orders read, ${res.written} written.` +
      (res.hasMore ? "\nHit the cap — narrow the range with --from and sweep again." : "") +
      "\n",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("\nReconcile failed:\n", err);
  process.exit(1);
});
