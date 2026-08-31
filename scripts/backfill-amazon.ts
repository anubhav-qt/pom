/**
 * One-time Amazon history load.
 *
 *   npm run backfill:amazon                       # last 6 months → now
 *   npm run backfill:amazon -- --from 2025-01-01
 *   npm run backfill:amazon -- --from 2025-01-01 --to 2025-07-01 --chunk-days 30
 *
 * Default range is the last 6 months — the shop wasn't trading before that.
 * Pass --from to go further back; a window Amazon won't build is logged and
 * skipped, not fatal.
 *
 * Uses the SP-API Reports API (GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL),
 * which returns a whole date range as one file and is not rate-limited per
 * order — so months of history come back in minutes rather than the hours the
 * live per-order sync would take. Ingest goes through the same pipeline as the
 * cron sync, so re-running over a range you already have is a harmless no-op.
 *
 * Run this once against production before the first deploy, and again by hand
 * whenever you need to re-pull a stretch of history. It is deliberately not a
 * route — a full run outlasts any serverless invocation.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function parseDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    console.error(`Not a date: "${value}". Use YYYY-MM-DD.`);
    process.exit(1);
  }
  return d;
}

async function main() {
  const { db } = await import("../src/db");
  const { channelAccounts } = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  const { backfillAccount } = await import("../src/lib/sync");

  const accounts = await db
    .select()
    .from(channelAccounts)
    .where(eq(channelAccounts.channel, "amazon"));

  // Prefer a real account over demo seed data, which would otherwise win on id.
  const account =
    accounts.find((a) =>
      String((a.credentials as Record<string, string>)?.refreshToken ?? "").startsWith("Atzr|"),
    ) ?? accounts[0];

  if (!account) {
    console.error('No Amazon channel account found. Add one under Settings first.');
    process.exit(1);
  }
  if ((account.credentials as Record<string, string>)?.sandbox === "true") {
    console.error(
      `Account "${account.label}" is in sandbox mode — the Reports API only returns real data in production.`,
    );
    process.exit(1);
  }

  // The shop opened ~6 months ago; there is nothing older to pull.
  const start = parseDate(arg("from"), new Date(Date.now() - 183 * 86_400_000));
  const end = parseDate(arg("to"), new Date());
  const chunkDays = arg("chunk-days") ? Number(arg("chunk-days")) : 45;

  console.log(
    `\nBackfilling "${account.label}" ` +
      `${start.toISOString().slice(0, 10)} → ${end.toISOString().slice(0, 10)} ` +
      `in ${chunkDays}-day windows${arg("from") ? "" : " (default: last 6 months)"}.\n`,
  );

  const res = await backfillAccount(account, {
    start,
    end,
    chunkDays,
    onProgress: ({ window, ordersSeen, ordersWritten, error }) =>
      console.log(
        error
          ? `  ${window}   SKIPPED — ${error}`
          : `  ${window}   ${ordersSeen} seen · ${ordersWritten} written  (running total)`,
      ),
  });

  console.log(
    `\nDone. sync_runs #${res.runId}: ${res.ordersSeen} orders seen, ${res.ordersWritten} written.` +
      (res.failedWindows.length > 0
        ? `\n${res.failedWindows.length} window(s) skipped: ${res.failedWindows.join(", ")}`
        : "") +
      "\n",
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("\nBackfill failed:\n", err);
  process.exit(1);
});
