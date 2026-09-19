/**
 * One-time load of Amazon money and returns history.
 *
 *   npm run backfill:finance                      # from 1 Mar 2026 → now
 *   npm run backfill:finance -- --from 2026-01-01
 *
 * Reads the Finances transactions (`finance_transactions`) and the Returns
 * report (`returns`). Both upsert by Amazon's own id, so re-running over a range
 * you already hold is harmless. The in-app sync keeps the recent tail fresh
 * after this; this only exists to load history, which outlasts a serverless
 * invocation.
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
  const { channelAccounts } = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  const { adapterFor } = await import("../src/channels");
  const { pullRange } = await import("../src/lib/finance");
  const { ingestReturns } = await import("../src/lib/sync");

  const from = new Date(arg("from") ?? "2026-03-01");
  const accounts = await db.select().from(channelAccounts).where(eq(channelAccounts.channel, "amazon"));
  const account =
    accounts.find((a) => String((a.credentials as Record<string, string>)?.refreshToken ?? "").startsWith("Atzr|")) ??
    accounts[0];
  if (!account) throw new Error("no Amazon account");
  console.log(`account: ${account.label}  from ${from.toISOString().slice(0, 10)}\n`);

  console.log("Finances transactions…");
  const written = await pullRange(account, from, new Date(), (n) => process.stdout.write(`\r  ${n} lines`));
  console.log(`\n  done, ${written} lines\n`);

  console.log("Returns report (60-day windows)…");
  const adapter = adapterFor(account);
  let since = from;
  let total = 0;
  while (since.getTime() < Date.now() - 3600_000) {
    const res = await adapter.fetchReturns({ since });
    const r = await ingestReturns(account, res.returns);
    total += r.written;
    console.log(`  ${since.toISOString().slice(0, 10)} → ${res.syncedThrough.toISOString().slice(0, 10)}: ${r.written} returns`);
    if (res.syncedThrough.getTime() <= since.getTime()) break;
    since = res.syncedThrough;
    await new Promise((s) => setTimeout(s, 65_000)); // createReport is limited to about one a minute
  }
  console.log(`  done, ${total} returns`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
