import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db";

/** A customer return that has sat this long without the parcel arriving is worth chasing Amazon about. */
export const OVERDUE_DAYS = 14;

export type ReturnStage = "transit" | "arrived" | "overdue" | "done";

export interface ReturnDeskRow {
  id: number;
  externalOrderId: string | null;
  orderId: number | null;
  item: string;
  imageUrl: string | null;
  reason: string;
  requestedAt: string | null;
  refundAmount: number;
  /** Everything Amazon paid minus everything it took for this order, from the money ledger. */
  orderNet: number | null;
  labelCost: number;
  /** Who Amazon bills the return label to. */
  labelPaidBy: string | null;
  resolution: string | null;
  carrier: string | null;
  awb: string | null;
  arrivedAt: string | null;
  receivedAt: string | null;
  restocked: boolean;
  outcome: string | null;
  note: string | null;
  stage: ReturnStage;
  /** Days since the customer raised it. */
  ageDays: number;
}

export interface ReturnsKpis {
  toDo: number;
  arrived: number;
  overdue: number;
  overdueRefund: number;
  refunded30: number;
  labels30: number;
  reimbursed30: number;
  returns30: number;
}

export interface ReasonCount {
  reason: string;
  count: number;
}

const n = (v: unknown) => Number(v ?? 0);

function parseReportDate(s: unknown): Date | null {
  const t = String(s ?? "").trim();
  if (!t) return null;
  const d = new Date(`${t} UTC`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function getReturnsDesk(): Promise<{
  rows: ReturnDeskRow[];
  kpis: ReturnsKpis;
  reasons: ReasonCount[];
}> {
  const raw = (
    await db.execute(sql`
      SELECT r.id, r.order_id, o.external_order_id, r.reason, r.requested_at, r.refund_amount, r.label_cost,
             r.resolution, r.awb, r.received_at, r.restocked, r.outcome, r.condition_note,
             r.raw->>'Return delivery date' AS delivered_raw,
             r.raw->>'Label to be paid by' AS label_paid_by,
             r.raw->>'Return carrier' AS carrier,
             (SELECT -SUM(t.total) FROM finance_transactions t
               WHERE t.external_order_id = o.external_order_id AND t.type = 'Refund' AND t.status <> 'DEFERRED_RELEASED') AS ledger_refund,
             (SELECT SUM(t.total) FROM finance_transactions t
               WHERE t.external_order_id = o.external_order_id AND t.type <> 'Transfer' AND t.status <> 'DEFERRED_RELEASED') AS order_net,
             COALESCE(NULLIF(r.raw->>'Item Name', ''), (
               SELECT COALESCE(NULLIF(oi.title, ''), oi.external_sku) FROM order_items oi WHERE oi.order_id = r.order_id ORDER BY oi.id LIMIT 1
             ), '') AS item,
             (SELECT COALESCE(p.image_url, ci.image_url) FROM order_items oi
               LEFT JOIN products p ON p.id = oi.product_id
               LEFT JOIN catalog_images ci ON ci.asin = oi.external_asin AND ci.channel_account_id = o.channel_account_id
               WHERE oi.order_id = r.order_id AND COALESCE(p.image_url, ci.image_url) IS NOT NULL
               ORDER BY oi.id LIMIT 1) AS image_url
      FROM returns r
      LEFT JOIN orders o ON o.id = r.order_id
      WHERE r.channel = 'amazon' AND r.kind = 'return'
      ORDER BY r.requested_at DESC NULLS LAST, r.id DESC
      LIMIT 3000
    `)
  ).rows;

  const now = Date.now();
  const rows: ReturnDeskRow[] = raw.map((r) => {
    const requestedAt = r.requested_at ? new Date(r.requested_at as string) : null;
    const arrivedAt = parseReportDate(r.delivered_raw);
    const ageDays = requestedAt ? Math.floor((now - requestedAt.getTime()) / 86_400_000) : 0;
    const done = r.received_at !== null || r.outcome !== null;
    // Amazon says whether the parcel reached us, so that decides it at any age.
    // A parcel that never arrived stays visible as "not received" until
    // somebody closes it.
    const stage: ReturnStage = done
      ? "done"
      : arrivedAt
        ? "arrived"
        : ageDays >= OVERDUE_DAYS
          ? "overdue"
          : "transit";
    return {
      id: n(r.id),
      orderId: r.order_id == null ? null : n(r.order_id),
      externalOrderId: (r.external_order_id as string | null) ?? null,
      item: String(r.item ?? ""),
      imageUrl: (r.image_url as string | null) ?? null,
      reason: String(r.reason ?? "Unknown"),
      requestedAt: requestedAt?.toISOString() ?? null,
      // The report leaves the refund blank on some rows the ledger has paid.
      refundAmount: n(r.refund_amount) || n(r.ledger_refund),
      orderNet: r.order_net == null ? null : n(r.order_net),
      labelCost: n(r.label_cost),
      labelPaidBy: (r.label_paid_by as string | null) || null,
      resolution: (r.resolution as string | null) ?? null,
      carrier: (r.carrier as string | null) || null,
      awb: (r.awb as string | null) ?? null,
      arrivedAt: arrivedAt?.toISOString() ?? null,
      receivedAt: r.received_at ? new Date(r.received_at as string).toISOString() : null,
      restocked: Boolean(r.restocked),
      outcome: (r.outcome as string | null) ?? null,
      note: (r.condition_note as string | null) ?? null,
      stage,
      ageDays,
    };
  });

  const since30 = now - 30 * 86_400_000;
  const in30 = rows.filter((r) => r.requestedAt && new Date(r.requestedAt).getTime() >= since30);
  // Owed only means something once Amazon has refunded the customer.
  const overdue = rows.filter((r) => r.stage === "overdue" && r.refundAmount > 0);

  const [reimb] = (
    await db.execute(sql`
      SELECT COALESCE(SUM(total), 0) AS v FROM finance_transactions
      WHERE type IN ('Adjustment','FBAInventoryReimbursement') AND status <> 'DEFERRED_RELEASED'
        AND posted_at >= now() - interval '30 days'
    `)
  ).rows;

  const reasonRows = (
    await db.execute(sql`
      SELECT COALESCE(NULLIF(reason, ''), 'Unknown') AS reason, COUNT(*)::int AS count
      FROM returns
      WHERE channel = 'amazon' AND kind = 'return' AND requested_at >= now() - interval '60 days'
      GROUP BY 1 ORDER BY 2 DESC LIMIT 8
    `)
  ).rows;

  return {
    rows,
    kpis: {
      toDo: rows.filter((r) => r.stage !== "done").length,
      arrived: rows.filter((r) => r.stage === "arrived").length,
      overdue: overdue.length,
      overdueRefund: overdue.reduce((a, r) => a + r.refundAmount, 0),
      refunded30: in30.reduce((a, r) => a + r.refundAmount, 0),
      labels30: in30.filter((r) => r.labelPaidBy === "Seller").reduce((a, r) => a + r.labelCost, 0),
      reimbursed30: n(reimb.v),
      returns30: in30.length,
    },
    reasons: reasonRows.map((r) => ({ reason: String(r.reason), count: n(r.count) })),
  };
}
