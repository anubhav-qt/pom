/**
 * Close cancellation and RTO check-ins that nobody is ever going to action.
 *
 *   npm run close:stale-checkins                      # dry run, prints what it would do
 *   npm run close:stale-checkins -- --apply
 *   npm run close:stale-checkins -- --older-than 45 --apply
 *
 * Why this exists: the reconcile sweep surfaced RTOs going back months that
 * Amazon had recorded but we never had. Each one arrives as a pending check-in,
 * so the goods-in queue filled up with parcels that were physically dealt with
 * long ago. Left alone, the real work hides among them.
 *
 * Age is measured from the ORDER's last movement (`orders.channel_updated_at`,
 * Amazon's own timestamp), not from when we detected it. Detection time is
 * useless here: every one of these was detected the moment the sweep ran, so
 * they all look like they happened today.
 *
 * What it writes is deliberately non-committal. `item_back` is left NULL rather
 * than false, because nobody knows whether the goods came back and recording
 * "not returned" would be inventing a fact. The UI reads NULL as "Condition
 * unknown". Nothing here touches stock.
 *
 * Everything it closes can be reopened from the Cancelled & RTO screen.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const NOTE_PREFIX = "Closed in bulk";

async function main() {
  const apply = process.argv.includes("--apply");
  const olderThan = Number(arg("older-than") ?? 30);

  if (!Number.isFinite(olderThan) || olderThan < 1) {
    console.error(`--older-than must be a positive number of days, got "${arg("older-than")}".`);
    process.exit(1);
  }

  const { db } = await import("../src/db");
  const { sql } = await import("drizzle-orm");
  const rows = <T = Record<string, unknown>>(r: unknown): T[] =>
    Array.isArray(r) ? (r as T[]) : (((r as { rows?: T[] })?.rows ?? []) as T[]);

  const cutoff = sql.raw(`now() - interval '${olderThan} days'`);

  const scope = rows<{ to_status: string; n: number; oldest: string; newest: string }>(
    await db.execute(sql`
      SELECT e.to_status, count(*)::int n,
             min(o.channel_updated_at)::date::text oldest,
             max(o.channel_updated_at)::date::text newest
      FROM order_status_events e
      JOIN orders o ON o.id = e.order_id
      WHERE e.to_status IN ('cancelled','rto','returned')
        AND e.checked_in_at IS NULL
        AND o.channel_updated_at < ${cutoff}
      GROUP BY 1 ORDER BY 2 DESC`),
  );

  const [remaining] = rows<{ n: number }>(
    await db.execute(sql`
      SELECT count(*)::int n
      FROM order_status_events e
      JOIN orders o ON o.id = e.order_id
      WHERE e.to_status IN ('cancelled','rto','returned')
        AND e.checked_in_at IS NULL
        AND o.channel_updated_at >= ${cutoff}`),
  );

  const total = scope.reduce((sum, r) => sum + r.n, 0);

  console.log(`\nPending check-ins on orders Amazon last moved over ${olderThan} days ago:\n`);
  if (scope.length === 0) {
    console.log("  none\n");
  } else {
    for (const r of scope) {
      console.log(`  ${r.to_status.padEnd(9)} ${String(r.n).padStart(4)}   ${r.oldest} to ${r.newest}`);
    }
    console.log(`  ${"total".padEnd(9)} ${String(total).padStart(4)}\n`);
  }
  console.log(`  ${remaining?.n ?? 0} more stay open (moved within the last ${olderThan} days).\n`);

  if (total === 0) {
    console.log("Nothing to do.\n");
    process.exit(0);
  }

  if (!apply) {
    console.log("Dry run. Re-run with --apply to close them.\n");
    process.exit(0);
  }

  const note = `${NOTE_PREFIX} on ${new Date().toISOString().slice(0, 10)}: surfaced by the reconcile sweep long after the fact, condition never recorded.`;

  const res = await db.execute(sql`
    UPDATE order_status_events e
    SET checked_in_at = now(),
        checked_in_by = NULL,
        item_back = NULL,
        checkin_note = ${note}
    FROM orders o
    WHERE o.id = e.order_id
      AND e.to_status IN ('cancelled','rto','returned')
      AND e.checked_in_at IS NULL
      AND o.channel_updated_at < ${cutoff}`);

  const changed = (res as unknown as { rowCount?: number }).rowCount ?? total;
  console.log(`Closed ${changed}. They show as "Condition unknown" under Completed and can be reopened.\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\nFailed:\n", err);
  process.exit(1);
});
