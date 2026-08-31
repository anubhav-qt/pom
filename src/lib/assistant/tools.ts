import { tool } from "@langchain/core/tools";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";

import { ENABLED_CHANNELS } from "@/config/features";
import { db } from "@/db";
import { orderItems, orders, orderStatusEnum } from "@/db/schema";

import {
  getDailySeries,
  getPeriodStats,
  getStatusBuckets,
  getTopSkus,
} from "@/app/(app)/dashboard/queries";

import { sanitizeAssistantHtml } from "./sanitize-html";

/**
 * The fixed, reviewed tools the assistant reaches for first — a small set of
 * parameterized queries covering what an owner actually asks, where every
 * number a card shows was computed by our own code, never guessed by the
 * model. agent.ts additionally offers the paribelle-oms-db MCP server's
 * get_schema/run_sql for questions these don't cover (read-only, guarded —
 * see mcp/sql-guard.ts) and, in custom-page display mode, renderHtmlTool
 * below for the model to design its own presentation instead of one of the
 * fixed cards.
 */

const RANGE = z
  .enum(["today", "7d", "30d", "90d", "all"])
  .describe("The time window to look at. Defaults to 30d if the user doesn't say.");

function rangeStart(range: z.infer<typeof RANGE>): Date {
  if (range === "all") return new Date("2000-01-01");
  if (range === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return new Date(Date.now() - days * 86_400_000);
}

const INR = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });

export const getSummaryStatsTool = tool(
  async ({ range }) => {
    const stats = await getPeriodStats(rangeStart(range));
    const nonCancelled = stats.totalOrders - stats.cancelledCount;
    return {
      type: "stats" as const,
      range,
      revenue: stats.revenue,
      revenueFormatted: INR.format(stats.revenue),
      orders: stats.totalOrders,
      avgOrderValue: nonCancelled > 0 ? Math.round(stats.revenue / nonCancelled) : 0,
      cancellationRate:
        stats.totalOrders > 0 ? Math.round((stats.cancelledCount / stats.totalOrders) * 100) : 0,
      codRate: stats.totalOrders > 0 ? Math.round((stats.codCount / stats.totalOrders) * 100) : 0,
      currentlyLate: stats.currentlyLate,
    };
  },
  {
    name: "get_summary_stats",
    description:
      "Revenue, order count, average order value, cancellation rate, COD rate and how many orders are currently past their dispatch deadline. Use this for any 'how are we doing' / 'how much did we make' / 'how many orders' question.",
    schema: z.object({ range: RANGE }),
  },
);

export const getStatusBreakdownTool = tool(
  async ({ range }) => {
    const buckets = await getStatusBuckets(rangeStart(range));
    return {
      type: "status_breakdown" as const,
      range,
      buckets,
      total: buckets.reduce((a, b) => a + b.count, 0),
    };
  },
  {
    name: "get_status_breakdown",
    description:
      "How orders in a time window are split across fulfilled, still in progress, returned/RTO, and cancelled. Use this for 'how many have shipped', 'what's stuck', 'how many returns' type questions.",
    schema: z.object({ range: RANGE }),
  },
);

export const getTopSkusTool = tool(
  async ({ range, limit }) => {
    const items = await getTopSkus(rangeStart(range), limit ?? 8);
    return {
      type: "sku_list" as const,
      range,
      items: items.map((i) => ({ ...i, revenueFormatted: INR.format(i.revenue) })),
    };
  },
  {
    name: "get_top_skus",
    description: "Best-selling products by revenue in a time window. Use for 'what's selling', 'top products' type questions.",
    schema: z.object({ range: RANGE, limit: z.number().int().min(1).max(20).optional() }),
  },
);

export const getRevenueTrendTool = tool(
  async ({ range }) => {
    const series = await getDailySeries(rangeStart(range));
    const totalRevenue = series.reduce((a, p) => a + p.revenue, 0);
    const totalOrders = series.reduce((a, p) => a + p.orders, 0);
    // The model gets the numbers to reason with (e.g. "which day was best");
    // no chart card exists for a raw day-by-day list — the dashboard already
    // owns that visual and a text answer covers what's actually being asked.
    return {
      type: "trend_summary" as const,
      range,
      days: series.length,
      totalRevenue,
      totalOrders,
      bestDay: series.length
        ? series.reduce((a, b) => (b.revenue > a.revenue ? b : a))
        : null,
    };
  },
  {
    name: "get_revenue_trend",
    description:
      "Day-by-day revenue and order counts for a time window, plus the single best day. Use for questions about trend, growth, or 'which day did best'.",
    schema: z.object({ range: RANGE }),
  },
);

const orderListLimit = z.number().int().min(1).max(15).optional();

function serializeOrders(
  rows: {
    id: number;
    channel: string;
    externalOrderId: string;
    status: string;
    totalAmount: string | null;
    orderedAt: Date;
    shipCity: string | null;
    shipState: string | null;
  }[],
) {
  return rows.map((o) => ({
    id: o.id,
    channel: o.channel,
    externalOrderId: o.externalOrderId,
    status: o.status,
    totalAmount: o.totalAmount,
    totalAmountFormatted: o.totalAmount ? INR.format(Number(o.totalAmount)) : null,
    orderedAt: o.orderedAt.toISOString(),
    location: [o.shipCity, o.shipState].filter(Boolean).join(", ") || null,
  }));
}

export const searchOrdersTool = tool(
  async ({ query, status, limit }) => {
    const like = `%${query.trim()}%`;
    const filters = [
      inArray(orders.channel, [...ENABLED_CHANNELS]),
      or(
        sql`${orders.externalOrderId} ILIKE ${like}`,
        sql`${orders.shipPincode} ILIKE ${like}`,
        sql`${orders.buyerName} ILIKE ${like}`,
        sql`EXISTS (SELECT 1 FROM ${orderItems} oi WHERE oi.order_id = ${orders.id} AND oi.external_sku ILIKE ${like})`,
      )!,
    ];
    if (status) filters.push(eq(orders.status, status));

    const rows = await db
      .select({
        id: orders.id,
        channel: orders.channel,
        externalOrderId: orders.externalOrderId,
        status: orders.status,
        totalAmount: orders.totalAmount,
        orderedAt: orders.orderedAt,
        shipCity: orders.shipCity,
        shipState: orders.shipState,
      })
      .from(orders)
      .where(and(...filters))
      .orderBy(desc(orders.orderedAt))
      .limit(limit ?? 10);

    return { type: "order_list" as const, query, items: serializeOrders(rows) };
  },
  {
    name: "search_orders",
    description:
      "Find specific orders by order ID, pincode, buyer name, or a product SKU. Use this whenever the question names a specific order, place, or item rather than asking for an aggregate.",
    schema: z.object({
      query: z.string().min(2).describe("Order ID, pincode, buyer name, or SKU fragment to search for"),
      status: z.enum(orderStatusEnum.enumValues).optional(),
      limit: orderListLimit,
    }),
  },
);

export const getLateOrdersTool = tool(
  async ({ limit }) => {
    const rows = await db
      .select({
        id: orders.id,
        channel: orders.channel,
        externalOrderId: orders.externalOrderId,
        status: orders.status,
        totalAmount: orders.totalAmount,
        orderedAt: orders.orderedAt,
        shipCity: orders.shipCity,
        shipState: orders.shipState,
      })
      .from(orders)
      .where(
        and(
          inArray(orders.channel, [...ENABLED_CHANNELS]),
          inArray(orders.status, ["new", "ready_to_pack", "packed"]),
          lt(orders.dispatchBy, new Date()),
        ),
      )
      .orderBy(orders.dispatchBy)
      .limit(limit ?? 10);

    return { type: "order_list" as const, query: "past dispatch deadline", items: serializeOrders(rows) };
  },
  {
    name: "get_late_orders",
    description:
      "Orders that are still not shipped and are already past their dispatch deadline, oldest deadline first. Use for 'what's late', 'what needs attention' type questions.",
    schema: z.object({ limit: orderListLimit }),
  },
);

export const ASSISTANT_TOOLS = [
  getSummaryStatsTool,
  getStatusBreakdownTool,
  getTopSkusTool,
  getRevenueTrendTool,
  searchOrdersTool,
  getLateOrdersTool,
];

export const ASSISTANT_TOOL_MAP = Object.fromEntries(ASSISTANT_TOOLS.map((t) => [t.name, t]));

/**
 * Only offered to the model in "custom page" display mode (see agent.ts) — in
 * the default card mode the fixed React components above are what render, and
 * this tool isn't bound at all. The model designs its own HTML instead of
 * fitting the answer into one of the fixed card shapes; sanitize-html.ts
 * strips anything that could execute or phone home before it's ever returned.
 */
export const renderHtmlTool = tool(
  async ({ html }) => ({ type: "html" as const, html: sanitizeAssistantHtml(html) }),
  {
    name: "render_html",
    description:
      "Renders a custom HTML snippet as the visual answer to this question, instead of a predetermined " +
      "card. Design the layout to fit what was actually asked — a table, a stat grid, a ranked list, " +
      "whatever communicates the specific data best — using only the values you already got back from " +
      "other tool calls this turn. Inline CSS only (no <style> block, no external stylesheets); no " +
      "<script>, <iframe>, <form>, or any external resource (images, fonts) — all of those are stripped " +
      "before the page is shown, so don't rely on them. Write a fragment (no <html>/<head>/<body>), and " +
      "call this once you have the data, as your final step.",
    schema: z.object({
      html: z
        .string()
        .min(1)
        .describe("A self-contained HTML fragment using inline style attributes, e.g. <div style=\"...\">…</div>."),
    }),
  },
);
