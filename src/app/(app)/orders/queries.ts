import { and, desc, eq, gte, inArray, isNull, isNotNull, sql, type SQL } from "drizzle-orm";

import { db } from "@/db";
import { ENABLED_CHANNELS } from "@/config/features";
import {
  catalogImages,
  orderFulfilment,
  orderItems,
  orders,
  orderStatusEvents,
  products,
  users,
  type Channel,
} from "@/db/schema";

/**
 * Channel statuses that still need the warehouse to act. Re-exported from
 * `lib/fulfilment`, which is where the queue predicate lives now that the
 * to-pack / to-ship split comes from our own state rather than this column.
 */
import { OPEN_STATUSES } from "@/lib/fulfilment";
export { OPEN_STATUSES };

/** The terminal statuses the Cancelled & RTO screen is built from. */
export const CANCELLED_STATUSES = ["cancelled", "rto", "returned"] as const;

/* -------------------------------------------------------------------------- */
/* Collection view — what to pull off the shelf                              */
/* -------------------------------------------------------------------------- */

export interface PickRow {
  key: string;
  sku: string;
  externalSku: string;
  asin: string | null;
  title: string | null;
  productId: number | null;
  mapped: boolean;
  binLocation: string | null;
  imageUrl: string | null;
  unitsNeeded: number;
  orderCount: number;
  lateCount: number;
  earliestDispatchBy: string | null;
  orderIds: string[];
}

/**
 * Every open order line, rolled up by product: one row per SKU with the total
 * units to pull, how many orders want it, its bin, and its image. This is the
 * "gather everything for today's dispatch" view — far easier to work a shelf
 * from than an order-by-order list.
 */
export async function getToShipPickList(channel?: Channel): Promise<PickRow[]> {
  const filters: SQL[] = [
    inArray(orders.status, [...OPEN_STATUSES]),
    inArray(orders.channel, [...ENABLED_CHANNELS]),
    eq(orderItems.cancelled, false),
    // Nothing we have already handed to the courier: the channel status stays
    // open until Amazon notices the pickup, so this is the only thing keeping
    // dispatched parcels off the shelf run.
    sql`COALESCE(${orderFulfilment.state}, 'to_pack') <> 'manifested'`,
  ];
  if (channel) filters.push(eq(orders.channel, channel));

  const rows = await db
    .select({
      productId: orderItems.productId,
      externalSku: orderItems.externalSku,
      asin: sql<string | null>`max(${orderItems.externalAsin})`,
      pSku: products.sku,
      pName: products.name,
      binLocation: products.binLocation,
      pImage: products.imageUrl,
      ciImage: sql<string | null>`max(${catalogImages.imageUrl})`,
      itemTitle: sql<string | null>`max(${orderItems.title})`,
      unitsNeeded: sql<number>`sum(${orderItems.quantity})::int`,
      orderCount: sql<number>`count(distinct ${orders.id})::int`,
      lateCount: sql<number>`(count(distinct ${orders.id}) filter (where ${orders.dispatchBy} < now()))::int`,
      earliest: sql<string | null>`min(${orders.dispatchBy})`,
      orderIds: sql<string[]>`array_agg(distinct ${orders.externalOrderId})`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .leftJoin(orderFulfilment, eq(orderFulfilment.orderId, orders.id))
    .leftJoin(products, eq(products.id, orderItems.productId))
    .leftJoin(
      catalogImages,
      and(
        eq(catalogImages.channelAccountId, orders.channelAccountId),
        eq(catalogImages.asin, orderItems.externalAsin),
      ),
    )
    .where(and(...filters))
    .groupBy(
      orderItems.productId,
      orderItems.externalSku,
      products.id,
      products.sku,
      products.name,
      products.binLocation,
      products.imageUrl,
    )
    .orderBy(desc(sql`sum(${orderItems.quantity})`));

  return rows.map((r) => ({
    key: r.productId !== null ? `p:${r.productId}` : `s:${r.externalSku}`,
    sku: r.pSku ?? r.externalSku,
    externalSku: r.externalSku,
    asin: r.asin,
    title: r.pName ?? r.itemTitle,
    productId: r.productId,
    mapped: r.productId !== null,
    binLocation: r.binLocation,
    imageUrl: r.pImage ?? r.ciImage,
    unitsNeeded: Number(r.unitsNeeded ?? 0),
    orderCount: Number(r.orderCount ?? 0),
    lateCount: Number(r.lateCount ?? 0),
    earliestDispatchBy: r.earliest ? new Date(r.earliest).toISOString() : null,
    orderIds: (r.orderIds ?? []).filter(Boolean),
  }));
}

/* -------------------------------------------------------------------------- */
/* Cancelled & RTO records                                                    */
/* -------------------------------------------------------------------------- */

export interface CancellationRecord {
  eventId: number;
  orderId: number;
  externalOrderId: string;
  channel: string;
  fromStatus: string | null;
  toStatus: string;
  detectedAt: string;
  syncRunId: number | null;
  checkedInAt: string | null;
  checkedInByName: string | null;
  itemBack: boolean | null;
  checkinNote: string | null;
  auto: boolean;
  /**
   * `auto`      — nothing to do; the order never shipped.
   * `ready`     — Amazon has confirmed the parcel is back (RTO). Show the tick.
   * `awaiting`  — shipped then cancelled, but Amazon has not confirmed a
   *               return yet. No tick — only a manual write-off.
   * `done`      — already checked in (shows on the Completed tab).
   */
  stage: "auto" | "ready" | "awaiting" | "done";
  orderedAt: string;
  totalAmount: string | null;
  items: { sku: string; title: string | null; quantity: number; imageUrl: string | null }[];
}

export async function getCancellationRecords(opts: {
  resolved: boolean;
  sinceDays?: number;
}): Promise<CancellationRecord[]> {
  const filters: SQL[] = [
    inArray(orderStatusEvents.toStatus, [...CANCELLED_STATUSES]),
    inArray(orderStatusEvents.channel, [...ENABLED_CHANNELS]),
    opts.resolved
      ? isNotNull(orderStatusEvents.checkedInAt)
      : isNull(orderStatusEvents.checkedInAt),
  ];
  if (opts.sinceDays) {
    filters.push(
      gte(orderStatusEvents.detectedAt, new Date(Date.now() - opts.sinceDays * 86_400_000)),
    );
  }

  const rows = await db
    .select({
      eventId: orderStatusEvents.id,
      orderId: orderStatusEvents.orderId,
      externalOrderId: orderStatusEvents.externalOrderId,
      channel: orderStatusEvents.channel,
      fromStatus: orderStatusEvents.fromStatus,
      toStatus: orderStatusEvents.toStatus,
      detectedAt: orderStatusEvents.detectedAt,
      syncRunId: orderStatusEvents.syncRunId,
      checkedInAt: orderStatusEvents.checkedInAt,
      checkedInBy: orderStatusEvents.checkedInBy,
      checkedInByName: users.name,
      itemBack: orderStatusEvents.itemBack,
      checkinNote: orderStatusEvents.checkinNote,
      orderedAt: orders.orderedAt,
      totalAmount: orders.totalAmount,
    })
    .from(orderStatusEvents)
    .innerJoin(orders, eq(orders.id, orderStatusEvents.orderId))
    .leftJoin(users, eq(users.id, orderStatusEvents.checkedInBy))
    .where(and(...filters))
    .orderBy(desc(orderStatusEvents.detectedAt))
    .limit(200);

  if (rows.length === 0) return [];

  const itemRows = await db
    .select({
      orderId: orderItems.orderId,
      sku: orderItems.externalSku,
      title: orderItems.title,
      quantity: orderItems.quantity,
      pImage: products.imageUrl,
      asin: orderItems.externalAsin,
      channelAccountId: orders.channelAccountId,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .leftJoin(orderFulfilment, eq(orderFulfilment.orderId, orders.id))
    .leftJoin(products, eq(products.id, orderItems.productId))
    .where(inArray(orderItems.orderId, rows.map((r) => r.orderId)));

  // One extra pass to resolve images from the catalogue cache for lines whose
  // product isn't mapped (or has no image of its own).
  const asinKeys = itemRows
    .filter((i) => !i.pImage && i.asin)
    .map((i) => ({ channelAccountId: i.channelAccountId, asin: i.asin! }));
  const ciMap = new Map<string, string>();
  if (asinKeys.length > 0) {
    const ci = await db
      .select({
        channelAccountId: catalogImages.channelAccountId,
        asin: catalogImages.asin,
        imageUrl: catalogImages.imageUrl,
      })
      .from(catalogImages)
      .where(
        inArray(
          catalogImages.asin,
          asinKeys.map((k) => k.asin),
        ),
      );
    for (const c of ci) {
      if (c.imageUrl) ciMap.set(`${c.channelAccountId}:${c.asin}`, c.imageUrl);
    }
  }

  const itemsByOrder = new Map<number, CancellationRecord["items"]>();
  for (const i of itemRows) {
    const list = itemsByOrder.get(i.orderId) ?? [];
    list.push({
      sku: i.sku,
      title: i.title,
      quantity: i.quantity,
      imageUrl: i.pImage ?? (i.asin ? (ciMap.get(`${i.channelAccountId}:${i.asin}`) ?? null) : null),
    });
    itemsByOrder.set(i.orderId, list);
  }

  return rows.map((r) => {
    const auto = r.checkedInAt !== null && r.checkedInBy === null;
    const stage: CancellationRecord["stage"] = auto
      ? "auto"
      : r.checkedInAt !== null
        ? "done"
        : r.toStatus === "rto"
          ? "ready"
          : "awaiting";
    return {
      eventId: r.eventId,
      orderId: r.orderId,
      externalOrderId: r.externalOrderId,
      channel: r.channel,
      fromStatus: r.fromStatus,
      toStatus: r.toStatus,
      detectedAt: r.detectedAt.toISOString(),
      syncRunId: r.syncRunId,
      checkedInAt: r.checkedInAt?.toISOString() ?? null,
      checkedInByName: r.checkedInByName ?? null,
      itemBack: r.itemBack,
      checkinNote: r.checkinNote,
      auto,
      stage,
      orderedAt: r.orderedAt.toISOString(),
      totalAmount: r.totalAmount,
      items: itemsByOrder.get(r.orderId) ?? [],
    };
  });
}

export async function getCancellationCounts(sinceDays = 30) {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const [row] = await db
    .select({
      pending: sql<number>`(count(*) filter (where ${orderStatusEvents.checkedInAt} is null))::int`,
      completed: sql<number>`(count(*) filter (where ${orderStatusEvents.checkedInAt} is not null))::int`,
    })
    .from(orderStatusEvents)
    .where(
      and(
        inArray(orderStatusEvents.toStatus, [...CANCELLED_STATUSES]),
        inArray(orderStatusEvents.channel, [...ENABLED_CHANNELS]),
        gte(orderStatusEvents.detectedAt, since),
      ),
    );
  return { pending: Number(row?.pending ?? 0), completed: Number(row?.completed ?? 0) };
}
