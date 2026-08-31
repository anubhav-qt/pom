import "server-only";

import { sql } from "drizzle-orm";

import { ENABLED_CHANNELS } from "@/config/features";
import { db } from "@/db";

const channelsSql = sql.join(
  [...ENABLED_CHANNELS].map((c) => sql`${c}`),
  sql`, `,
);

export interface DailyPoint {
  day: string;
  orders: number;
  revenue: number;
}

/**
 * Orders and revenue aren't drawn on the same axis (that's a dual-axis chart,
 * the single most common charting mistake) — this returns both series from one
 * query so they always agree, and the UI renders them as two separate charts.
 * Revenue excludes cancelled/RTO/returned orders — money never actually kept
 * has no business in a revenue line.
 */
export async function getDailySeries(from: Date): Promise<DailyPoint[]> {
  const rows = await db.execute(sql`
    SELECT
      date_trunc('day', ordered_at) AS day,
      COUNT(*) AS orders,
      COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('cancelled','rto','returned')), 0) AS revenue
    FROM orders
    WHERE channel IN (${channelsSql}) AND ordered_at >= ${from.toISOString()}
    GROUP BY day
    ORDER BY day
  `);

  return rows.rows.map((r) => ({
    day: new Date(r.day as string).toISOString(),
    orders: Number(r.orders),
    revenue: Number(r.revenue),
  }));
}

export interface PeriodStats {
  totalOrders: number;
  revenue: number;
  cancelledCount: number;
  codCount: number;
  currentlyLate: number;
}

export async function getPeriodStats(from: Date): Promise<PeriodStats> {
  const [row] = (
    await db.execute(sql`
      SELECT
        COUNT(*) AS total_orders,
        COALESCE(SUM(total_amount) FILTER (WHERE status NOT IN ('cancelled','rto','returned')), 0) AS revenue,
        COUNT(*) FILTER (WHERE status IN ('cancelled','rto','returned')) AS cancelled_count,
        COUNT(*) FILTER (WHERE is_cod) AS cod_count
      FROM orders
      WHERE channel IN (${channelsSql}) AND ordered_at >= ${from.toISOString()}
    `)
  ).rows;

  // "Currently late" is a live operational read, not scoped to the selected
  // date range — an order from last week that is still sitting unpacked is
  // exactly as late today regardless of which range is being viewed.
  const [lateRow] = (
    await db.execute(sql`
      SELECT COUNT(*) AS n FROM orders
      WHERE channel IN (${channelsSql})
        AND status IN ('new','ready_to_pack','packed')
        AND dispatch_by < now()
    `)
  ).rows;

  return {
    totalOrders: Number(row.total_orders),
    revenue: Number(row.revenue),
    cancelledCount: Number(row.cancelled_count),
    codCount: Number(row.cod_count),
    currentlyLate: Number(lateRow.n),
  };
}

export interface StatusBucket {
  key: "fulfilled" | "in_progress" | "returned" | "cancelled";
  label: string;
  count: number;
}

/**
 * Nine raw order statuses collapse to four buckets a business owner actually
 * scans for — a bar per status leaves late-stage RTO looking identical in
 * weight to a same-day cancellation, and buries the number that matters
 * (how much shipped clean) among slivers.
 */
export async function getStatusBuckets(from: Date): Promise<StatusBucket[]> {
  const [row] = (
    await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('shipped','delivered')) AS fulfilled,
        COUNT(*) FILTER (WHERE status IN ('new','ready_to_pack','packed','manifested')) AS in_progress,
        COUNT(*) FILTER (WHERE status IN ('rto','returned')) AS returned,
        COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled
      FROM orders
      WHERE channel IN (${channelsSql}) AND ordered_at >= ${from.toISOString()}
    `)
  ).rows;

  return [
    { key: "fulfilled", label: "Fulfilled", count: Number(row.fulfilled) },
    { key: "in_progress", label: "In progress", count: Number(row.in_progress) },
    { key: "returned", label: "Returned / RTO", count: Number(row.returned) },
    { key: "cancelled", label: "Cancelled", count: Number(row.cancelled) },
  ];
}

export interface TopSku {
  sku: string;
  title: string | null;
  quantity: number;
  revenue: number;
}

export async function getTopSkus(from: Date, limit = 8): Promise<TopSku[]> {
  const rows = await db.execute(sql`
    SELECT
      oi.external_sku AS sku,
      MAX(oi.title) AS title,
      SUM(oi.quantity) AS quantity,
      SUM(oi.quantity * COALESCE(oi.unit_price, 0)) AS revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.channel IN (${channelsSql})
      AND o.ordered_at >= ${from.toISOString()}
      AND oi.cancelled = false
      AND o.status != 'cancelled'
    GROUP BY oi.external_sku
    ORDER BY revenue DESC
    LIMIT ${limit}
  `);

  return rows.rows.map((r) => ({
    sku: r.sku as string,
    title: r.title as string | null,
    quantity: Number(r.quantity),
    revenue: Number(r.revenue),
  }));
}
