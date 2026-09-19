import { and, eq, sql } from "drizzle-orm";

import { AmazonAdapter } from "@/channels/amazon";
import type { FinanceLine } from "@/channels/amazon-finance";
import { adapterFor } from "@/channels";
import { db } from "@/db";
import { financeTransactions, type ChannelAccount } from "@/db/schema";

/**
 * Money sync. Pulls Amazon's Finances transactions into `finance_transactions`.
 *
 * Incremental: every run re-reads a trailing week and upserts by transaction
 * id, so lines Amazon posts late, or that change from DEFERRED to released,
 * are picked up without a cursor that could skip them. The first run reads
 * `FIRST_RUN_DAYS`; a longer history is pulled with `backfillFinance`.
 */

const DAY = 86_400_000;
const OVERLAP_DAYS = 7;
const FIRST_RUN_DAYS = 30;
const MAX_SPAN_DAYS = 170; // Amazon returns nothing for a span over 180.

const money = (n: number) => n.toFixed(2);

export async function upsertLines(account: ChannelAccount, lines: FinanceLine[]) {
  if (lines.length === 0) return 0;
  // One row per id within a statement — Postgres refuses to touch a row twice.
  const unique = [...new Map(lines.map((l) => [l.transactionId, l])).values()];

  for (let i = 0; i < unique.length; i += 400) {
    const batch = unique.slice(i, i + 400);
    await db
      .insert(financeTransactions)
      .values(
        batch.map((l) => ({
          transactionId: l.transactionId,
          channelAccountId: account.id,
          type: l.type,
          status: l.status,
          description: l.description,
          postedAt: l.postedAt,
          externalOrderId: l.externalOrderId,
          groupId: l.groupId,
          deferredId: l.deferredId,
          total: money(l.total),
          principal: money(l.principal),
          tax: money(l.tax),
          promo: money(l.promo),
          tcsTds: money(l.tcsTds),
          fees: money(l.fees),
          postage: money(l.postage),
          refundCommission: money(l.refundCommission),
        })),
      )
      .onConflictDoUpdate({
        target: financeTransactions.transactionId,
        set: {
          status: sql`excluded.status`,
          groupId: sql`excluded.group_id`,
          deferredId: sql`excluded.deferred_id`,
          total: sql`excluded.total`,
          principal: sql`excluded.principal`,
          tax: sql`excluded.tax`,
          promo: sql`excluded.promo`,
          tcsTds: sql`excluded.tcs_tds`,
          fees: sql`excluded.fees`,
          postage: sql`excluded.postage`,
          refundCommission: sql`excluded.refund_commission`,
        },
      });
  }
  await settleDeferred();
  return unique.length;
}

/**
 * A RELEASED row points at the DEFERRED row it replaces. Mark that original
 * DEFERRED_RELEASED so it is never summed alongside its replacement — without
 * this a payment that was held and then paid is counted twice.
 */
export async function settleDeferred() {
  await db.execute(sql`
    UPDATE finance_transactions d
    SET status = 'DEFERRED_RELEASED'
    WHERE d.status = 'DEFERRED'
      AND d.transaction_id IN (
        SELECT deferred_id FROM finance_transactions WHERE deferred_id IS NOT NULL
      )
  `);
}

/** Read `[from, to)` in spans Amazon accepts, upserting as it goes. */
export async function pullRange(
  account: ChannelAccount,
  from: Date,
  to: Date,
  onPage?: (n: number) => void,
) {
  const adapter = adapterFor(account);
  if (!(adapter instanceof AmazonAdapter)) return 0;

  let written = 0;
  for (let start = from.getTime(); start < to.getTime(); start += MAX_SPAN_DAYS * DAY) {
    const end = Math.min(start + MAX_SPAN_DAYS * DAY, to.getTime());
    for await (const page of adapter.fetchTransactions(new Date(start), new Date(end))) {
      written += await upsertLines(account, page);
      onPage?.(written);
    }
  }
  return written;
}

export async function syncFinance(account: ChannelAccount) {
  if (account.channel !== "amazon") return { written: 0 };

  const [last] = await db
    .select({ at: sql<Date | null>`MAX(${financeTransactions.postedAt})` })
    .from(financeTransactions)
    .where(eq(financeTransactions.channelAccountId, account.id));

  const now = new Date();
  const lastAt = last?.at ? new Date(last.at) : null;
  const from = lastAt
    ? new Date(lastAt.getTime() - OVERLAP_DAYS * DAY)
    : new Date(now.getTime() - FIRST_RUN_DAYS * DAY);

  const written = await pullRange(account, from, now);
  return { written };
}

export async function financeRowCount(accountId: number) {
  const [r] = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(financeTransactions)
    .where(and(eq(financeTransactions.channelAccountId, accountId)));
  return r?.n ?? 0;
}
