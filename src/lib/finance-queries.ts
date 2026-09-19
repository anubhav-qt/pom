import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db";

/**
 * Reads over `finance_transactions`.
 *
 * Two rules run through every query here:
 *  - `DEFERRED_RELEASED` rows are never summed. Amazon lists deferred money
 *    twice (once held, once paid); the paid copy is the RELEASED row.
 *  - "Basis" is which date puts a line in a range. `paid` uses the day the money
 *    moved. `ordered` uses the day the order was placed, so an order's sale,
 *    fees and later refund all land in the same period; lines that belong to no
 *    order (ads, storage, payouts) always use the day they posted.
 */

import type { Basis } from "@/app/(app)/dashboard/range";

export type { Basis };

export interface FinanceStats {
  /** Product sales on shipped orders (before tax). */
  sales: number;
  refunds: number;
  /** Closing fee, commission, postage and refund clawbacks, net of what Amazon gave back. */
  fees: number;
  ads: number;
  /** Reimbursements and other Amazon adjustments. */
  reimbursed: number;
  /** Everything Amazon paid or took, summed: what actually reaches the bank. */
  net: number;
  paidOut: number;
  /** Held by Amazon right now, whatever the range. */
  onHold: number;
  shippedOrders: number;
  refundedOrders: number;
  cost: number;
  profit: number;
  ordersWithCost: number;
  ordersMissingCost: number;
}

export interface DayNet {
  day: string;
  net: number;
}

export interface Payout {
  at: string;
  amount: number;
}

export interface FinanceOverview {
  stats: FinanceStats;
  daily: DayNet[];
  payouts: Payout[];
  /** Rows in finance_transactions — zero means the first sync has not run. */
  lineCount: number;
}

const n = (v: unknown) => Number(v ?? 0);

/** Lines inside [from, to) on the chosen basis, joined to their order when they have one. */
function linesCte(from: Date, to: Date, basis: Basis) {
  return sql`
    lines AS (
      SELECT t.*, o.id AS order_id, o.ordered_at,
             CASE WHEN ${basis} = 'ordered' AND o.id IS NOT NULL THEN o.ordered_at ELSE t.posted_at END AS bucket_at
      FROM finance_transactions t
      LEFT JOIN orders o
        ON o.external_order_id = t.external_order_id AND o.channel_account_id = t.channel_account_id
      WHERE t.status <> 'DEFERRED_RELEASED'
    ),
    in_range AS (
      SELECT * FROM lines WHERE bucket_at >= ${from.toISOString()} AND bucket_at < ${to.toISOString()}
    )`;
}

const COST_LOOKUP = sql`
  cost_lookup AS (
    SELECT o.id AS order_id, COALESCE(f.cost_price, s.cost) AS cost
    FROM orders o
    LEFT JOIN order_finance f ON f.order_id = o.id
    LEFT JOIN (
      SELECT oi.order_id, SUM(oi.quantity * p.cost_price) AS cost
      FROM order_items oi JOIN products p ON p.id = oi.product_id
      WHERE p.cost_price IS NOT NULL
      GROUP BY oi.order_id
    ) s ON s.order_id = o.id
  )`;

export async function getFinanceOverview(from: Date, to: Date, basis: Basis): Promise<FinanceOverview> {
  const [stat] = (
    await db.execute(sql`
      WITH ${linesCte(from, to, basis)},
      ${COST_LOOKUP},
      per_order AS (
        SELECT order_id, SUM(total) FILTER (WHERE type <> 'Transfer') AS net
        FROM in_range WHERE order_id IS NOT NULL GROUP BY order_id
      ),
      profit AS (
        SELECT
          COUNT(*) FILTER (WHERE c.cost IS NOT NULL) AS with_cost,
          COUNT(*) FILTER (WHERE c.cost IS NULL) AS missing_cost,
          COALESCE(SUM(c.cost), 0) AS cost,
          COALESCE(SUM(po.net - c.cost) FILTER (WHERE c.cost IS NOT NULL), 0) AS profit
        FROM per_order po LEFT JOIN cost_lookup c ON c.order_id = po.order_id
      )
      SELECT
        COALESCE(SUM(principal) FILTER (WHERE type = 'Shipment'), 0) AS sales,
        COALESCE(-SUM(principal) FILTER (WHERE type = 'Refund'), 0) AS refunds,
        COALESCE(-SUM(fees + postage + refund_commission) FILTER (WHERE type <> 'Transfer'), 0) AS fees,
        COALESCE(-SUM(total) FILTER (WHERE type = 'ProductAdsPayment'), 0) AS ads,
        COALESCE(SUM(total) FILTER (WHERE type IN ('Adjustment','FBAInventoryReimbursement')), 0) AS reimbursed,
        COALESCE(SUM(total) FILTER (WHERE type <> 'Transfer'), 0) AS net,
        COALESCE(SUM(total) FILTER (WHERE type = 'Transfer'), 0) AS paid_out,
        COUNT(DISTINCT external_order_id) FILTER (WHERE type = 'Shipment') AS shipped_orders,
        COUNT(DISTINCT external_order_id) FILTER (WHERE type = 'Refund') AS refunded_orders,
        (SELECT with_cost FROM profit) AS with_cost,
        (SELECT missing_cost FROM profit) AS missing_cost,
        (SELECT cost FROM profit) AS cost,
        (SELECT profit FROM profit) AS profit
      FROM in_range
    `)
  ).rows;

  const [held] = (
    await db.execute(sql`
      SELECT COALESCE(SUM(total), 0) AS on_hold FROM finance_transactions
      WHERE status = 'DEFERRED' AND type <> 'Transfer'
    `)
  ).rows;

  const [count] = (await db.execute(sql`SELECT COUNT(*)::int AS n FROM finance_transactions`)).rows;

  const daily = (
    await db.execute(sql`
      WITH ${linesCte(from, to, basis)}
      SELECT date_trunc('day', bucket_at) AS day, SUM(total) AS net
      FROM in_range WHERE type <> 'Transfer'
      GROUP BY 1 ORDER BY 1
    `)
  ).rows;

  const payouts = (
    await db.execute(sql`
      SELECT date_trunc('day', posted_at) AS posted_at, SUM(total) AS total FROM finance_transactions
      WHERE type = 'Transfer' AND status <> 'DEFERRED_RELEASED'
      GROUP BY 1 ORDER BY 1 DESC LIMIT 8
    `)
  ).rows;

  return {
    stats: {
      sales: n(stat.sales),
      refunds: n(stat.refunds),
      fees: n(stat.fees),
      ads: n(stat.ads),
      reimbursed: n(stat.reimbursed),
      net: n(stat.net),
      paidOut: n(stat.paid_out),
      onHold: n(held.on_hold),
      shippedOrders: n(stat.shipped_orders),
      refundedOrders: n(stat.refunded_orders),
      cost: n(stat.cost),
      profit: n(stat.profit),
      ordersWithCost: n(stat.with_cost),
      ordersMissingCost: n(stat.missing_cost),
    },
    daily: daily.map((r) => ({ day: new Date(r.day as string).toISOString(), net: n(r.net) })),
    payouts: payouts
      .map((r) => ({ at: new Date(r.posted_at as string).toISOString(), amount: n(r.total) }))
      .reverse(),
    lineCount: n(count.n),
  };
}

/* -------------------------------------------------------------------------- */
/* Ledger                                                                     */
/* -------------------------------------------------------------------------- */

export type LedgerStatus = "delivered" | "returned" | "rto" | "cancelled" | "shipped" | "in_progress";

export interface LedgerRow {
  orderId: number;
  externalOrderId: string;
  orderedAt: string;
  item: string;
  itemCount: number;
  status: LedgerStatus;
  /** What the customer was charged. */
  sale: number;
  /** Amazon's payment for the order before refunds. */
  paid: number;
  fees: number;
  postage: number;
  refunded: number;
  /** Everything Amazon paid minus everything it took, for this order. */
  net: number;
  /** Part of `net` Amazon is still holding. */
  held: number;
  returnLabel: number;
  cost: number | null;
  /** The saved cost, or null when `cost` is only a suggestion from the product. */
  costSaved: boolean;
  note: string;
  profit: number | null;
}

export async function getLedgerRows(from: Date, to: Date, basis: Basis): Promise<LedgerRow[]> {
  const rows = (
    await db.execute(sql`
      WITH ${linesCte(from, to, basis)},
      ${COST_LOOKUP},
      agg AS (
        SELECT order_id,
          SUM(total) FILTER (WHERE type <> 'Transfer') AS net,
          SUM(total) FILTER (WHERE type = 'Shipment') AS paid,
          SUM(total) FILTER (WHERE type = 'Refund') AS refunded,
          SUM(fees + refund_commission) FILTER (WHERE type <> 'Transfer') AS fees,
          SUM(postage) FILTER (WHERE type <> 'Transfer') AS postage,
          SUM(total) FILTER (WHERE status = 'DEFERRED' AND type <> 'Transfer') AS held
        FROM in_range WHERE order_id IS NOT NULL GROUP BY order_id
      ),
      picked AS (
        SELECT o.id FROM orders o
        WHERE o.channel = 'amazon' AND (
          o.id IN (SELECT order_id FROM agg)
          OR (${basis} = 'ordered' AND o.ordered_at >= ${from.toISOString()} AND o.ordered_at < ${to.toISOString()})
        )
      )
      SELECT o.id, o.external_order_id, o.ordered_at, o.status, o.total_amount,
        (SELECT COALESCE(NULLIF(oi.title, ''), oi.external_sku) FROM order_items oi WHERE oi.order_id = o.id ORDER BY oi.id LIMIT 1) AS item,
        (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = o.id) AS item_count,
        COALESCE(a.net, 0) AS net, COALESCE(a.paid, 0) AS paid, COALESCE(a.refunded, 0) AS refunded,
        COALESCE(a.fees, 0) AS fees, COALESCE(a.postage, 0) AS postage, COALESCE(a.held, 0) AS held,
        COALESCE((SELECT SUM(r.label_cost) FROM returns r WHERE r.order_id = o.id), 0) AS return_label,
        c.cost, (f.cost_price IS NOT NULL) AS cost_saved, COALESCE(f.note, '') AS note
      FROM picked p
      JOIN orders o ON o.id = p.id
      LEFT JOIN agg a ON a.order_id = o.id
      LEFT JOIN cost_lookup c ON c.order_id = o.id
      LEFT JOIN order_finance f ON f.order_id = o.id
      ORDER BY o.ordered_at DESC
      LIMIT 3000
    `)
  ).rows;

  return rows.map((r) => {
    const refunded = n(r.refunded);
    const net = n(r.net);
    const held = n(r.held);
    const status: LedgerStatus =
      r.status === "cancelled"
        ? "cancelled"
        : r.status === "rto"
          ? "rto"
          : refunded < 0
            ? "returned"
            : r.status === "delivered"
              ? "delivered"
              : r.status === "shipped"
                ? "shipped"
                : "in_progress";
    const cost = r.cost == null ? null : n(r.cost);
    return {
      orderId: n(r.id),
      externalOrderId: String(r.external_order_id),
      orderedAt: new Date(r.ordered_at as string).toISOString(),
      item: String(r.item ?? ""),
      itemCount: n(r.item_count),
      status,
      sale: n(r.total_amount),
      paid: n(r.paid),
      fees: n(r.fees),
      postage: n(r.postage),
      refunded,
      net,
      held,
      returnLabel: n(r.return_label),
      cost,
      costSaved: Boolean(r.cost_saved),
      note: String(r.note ?? ""),
      // No profit until Amazon has paid or taken something; a cost against a
      // zero would read as a loss on an order that simply has not settled yet.
      profit: cost == null || net === 0 ? null : net - cost,
    };
  });
}
