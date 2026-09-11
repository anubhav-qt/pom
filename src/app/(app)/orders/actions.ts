"use server";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import {
  batchOrders,
  batches,
  catalogImages,
  orderItems,
  orders,
  orderStatusEvents,
  products,
  returns,
  shipments,
} from "@/db/schema";
import { requireUser } from "@/lib/auth";
import {
  dismissShipped24hLocal,
  markManifestedLocal,
  markPackedLocal,
  revertLocal,
} from "@/lib/fulfilment";
import { recomputeReserved } from "@/lib/sync";

export interface OrderDetail {
  id: number;
  channel: string;
  externalOrderId: string;
  status: string;
  orderedAt: string;
  dispatchBy: string | null;
  buyerName: string | null;
  shipCity: string | null;
  shipState: string | null;
  shipPincode: string | null;
  totalAmount: string | null;
  isCod: boolean;
  createdAt: string;
  updatedAt: string;
  items: {
    sku: string;
    title: string | null;
    quantity: number;
    unitPrice: string | null;
    cancelled: boolean;
    mapped: boolean;
    binLocation: string | null;
    asin: string | null;
    imageUrl: string | null;
  }[];
  shipment: {
    courier: string | null;
    awb: string | null;
    externalShipmentId: string | null;
    packedAt: string | null;
    dispatchedAt: string | null;
    hasLabel: boolean;
  } | null;
  returnRecord: {
    kind: string;
    reason: string | null;
    status: string | null;
    receivedAt: string | null;
    restocked: boolean;
  } | null;
  raw: unknown;
}

/** Everything known about one order, for the detail popup. */
export async function getOrderDetail(orderId: number): Promise<OrderDetail | null> {
  await requireUser();

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return null;

  const items = await db
    .select({
      sku: orderItems.externalSku,
      title: orderItems.title,
      quantity: orderItems.quantity,
      unitPrice: orderItems.unitPrice,
      cancelled: orderItems.cancelled,
      productId: orderItems.productId,
      binLocation: products.binLocation,
      asin: orderItems.externalAsin,
      pImage: products.imageUrl,
      ciImage: catalogImages.imageUrl,
    })
    .from(orderItems)
    .leftJoin(products, eq(products.id, orderItems.productId))
    .leftJoin(
      catalogImages,
      and(
        eq(catalogImages.channelAccountId, order.channelAccountId),
        eq(catalogImages.asin, orderItems.externalAsin),
      ),
    )
    .where(eq(orderItems.orderId, orderId));

  const [shipment] = await db
    .select({
      courier: shipments.courier,
      awb: shipments.awb,
      externalShipmentId: shipments.externalShipmentId,
      packedAt: shipments.packedAt,
      dispatchedAt: shipments.dispatchedAt,
      hasLabel: shipments.labelFetchedAt,
    })
    .from(shipments)
    .where(eq(shipments.orderId, orderId))
    .limit(1);

  const [returnRow] = await db
    .select({
      kind: returns.kind,
      reason: returns.reason,
      status: returns.status,
      receivedAt: returns.receivedAt,
      restocked: returns.restocked,
    })
    .from(returns)
    .where(eq(returns.orderId, orderId))
    .limit(1);

  return {
    id: order.id,
    channel: order.channel,
    externalOrderId: order.externalOrderId,
    status: order.status,
    orderedAt: order.orderedAt.toISOString(),
    dispatchBy: order.dispatchBy?.toISOString() ?? null,
    buyerName: order.buyerName,
    shipCity: order.shipCity,
    shipState: order.shipState,
    shipPincode: order.shipPincode,
    totalAmount: order.totalAmount,
    isCod: order.isCod,
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    items: items.map((i) => ({
      sku: i.sku,
      title: i.title,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      cancelled: i.cancelled,
      mapped: i.productId !== null,
      binLocation: i.binLocation,
      asin: i.asin,
      imageUrl: i.pImage ?? i.ciImage ?? null,
    })),
    shipment: shipment
      ? {
          courier: shipment.courier,
          awb: shipment.awb,
          externalShipmentId: shipment.externalShipmentId,
          packedAt: shipment.packedAt?.toISOString() ?? null,
          dispatchedAt: shipment.dispatchedAt?.toISOString() ?? null,
          hasLabel: shipment.hasLabel !== null,
        }
      : null,
    returnRecord: returnRow
      ? { ...returnRow, receivedAt: returnRow.receivedAt?.toISOString() ?? null }
      : null,
    raw: order.raw,
  };
}

export interface CollectionOrderRow {
  orderId: number;
  externalOrderId: string;
  buyerName: string | null;
  shipCity: string | null;
  shipState: string | null;
  quantity: number;
  isCod: boolean;
  status: string;
  dispatchBy: string | null;
  orderedAt: string;
}

/**
 * Every open order that contributes to one product's "to pick" line — the
 * detail behind a card in the collection view. Keyed by the channel SKU, since
 * that is what the card rolls up on.
 */
export async function getCollectionOrders(externalSku: string): Promise<CollectionOrderRow[]> {
  await requireUser();

  const rows = await db
    .select({
      orderId: orders.id,
      externalOrderId: orders.externalOrderId,
      buyerName: orders.buyerName,
      shipCity: orders.shipCity,
      shipState: orders.shipState,
      quantity: orderItems.quantity,
      isCod: orders.isCod,
      status: orders.status,
      dispatchBy: orders.dispatchBy,
      orderedAt: orders.orderedAt,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(
      and(
        eq(orderItems.externalSku, externalSku),
        eq(orderItems.cancelled, false),
        inArray(orders.status, ["new", "ready_to_pack", "packed"]),
      ),
    )
    .orderBy(orders.dispatchBy);

  return rows.map((r) => ({
    orderId: r.orderId,
    externalOrderId: r.externalOrderId,
    buyerName: r.buyerName,
    shipCity: r.shipCity,
    shipState: r.shipState,
    quantity: r.quantity,
    isCod: r.isCod,
    status: r.status,
    dispatchBy: r.dispatchBy?.toISOString() ?? null,
    orderedAt: r.orderedAt.toISOString(),
  }));
}

/**
 * Mark orders packed. Recorded with who and when, because "who packed this"
 * is the first question asked when a customer says the box was empty.
 */
export async function markPacked(orderIds: number[]) {
  const user = await requireUser();
  if (orderIds.length === 0) return { ok: true, count: 0 };

  // Writes our own floor state, never `orders.status` — that column belongs to
  // the marketplace and the next sync would overwrite whatever we put there.
  const { moved } = await markPackedLocal(orderIds, user.id);

  await recomputeReserved();
  revalidatePath("/orders");
  revalidatePath("/pack");
  return { ok: true, count: moved.length };
}

/**
 * Create a courier manifest from packed orders and move them on. The batch is
 * kept so the manifest can be reprinted — couriers lose them regularly.
 */
export async function createManifest(orderIds: number[]) {
  const user = await requireUser();
  if (orderIds.length === 0) return { ok: false as const, error: "Select some packed orders first." };

  const { moved } = await markManifestedLocal(orderIds, user.id);

  if (moved.length === 0) {
    return { ok: false as const, error: "None of the selected orders are packed yet." };
  }

  const [batch] = await db
    .insert(batches)
    .values({ kind: "manifest", createdBy: user.id })
    .returning({ id: batches.id });

  await db
    .insert(batchOrders)
    .values(moved.map((orderId) => ({ batchId: batch.id, orderId })));

  // Manifested stock has physically left, so it is no longer committed.
  await recomputeReserved();

  revalidatePath("/orders");
  return { ok: true as const, batchId: batch.id, count: moved.length };
}

/** Move orders back a step when something was scanned or clicked by mistake. */
export async function revertToNew(orderIds: number[]) {
  await requireUser();
  if (orderIds.length === 0) return { ok: true, count: 0 };

  // Only our own state is reset. The marketplace's status is not ours to undo —
  // if Amazon says an order shipped, clicking "revert" here cannot unsay it.
  const { moved } = await revertLocal(orderIds);

  await recomputeReserved();
  revalidatePath("/orders");
  return { ok: true, count: moved.length };
}

/**
 * Clear orders off the Shipped (24h) queue by hand — a local "seen it,
 * confirmed it" acknowledgement, not a status change. The order stays exactly
 * as-is everywhere else; this only stops it cluttering the 24h review list.
 */
export async function dismissShipped24h(orderIds: number[]) {
  const user = await requireUser();
  if (orderIds.length === 0) return { ok: true, count: 0 };

  const { moved } = await dismissShipped24hLocal(orderIds, user.id);

  revalidatePath("/orders");
  return { ok: true, count: moved.length };
}

/* -------------------------------------------------------------------------- */
/* Cancellation / RTO check-in                                               */
/* -------------------------------------------------------------------------- */

const TERMINAL_STATUSES = ["cancelled", "rto", "returned"] as const;

/**
 * Tick a pending cancellation / RTO record off the list. Records who confirmed
 * it and whether the goods physically came back. Until this happens the record
 * sits under "Pending" on the Cancelled & RTO screen; afterwards it moves to
 * "Completed".
 */
export async function checkInCancellation(
  eventId: number,
  opts: { itemBack: boolean; note?: string },
) {
  const user = await requireUser();

  const [row] = await db
    .update(orderStatusEvents)
    .set({
      checkedInAt: new Date(),
      checkedInBy: user.id,
      itemBack: opts.itemBack,
      checkinNote: opts.note?.trim() || null,
    })
    .where(
      and(
        eq(orderStatusEvents.id, eventId),
        inArray(orderStatusEvents.toStatus, [...TERMINAL_STATUSES]),
        isNull(orderStatusEvents.checkedInAt),
      ),
    )
    .returning({ id: orderStatusEvents.id });

  if (!row) {
    return { ok: false as const, error: "Already checked in, or not a cancellation record." };
  }

  revalidatePath("/orders");
  return { ok: true as const };
}

/** Undo a check-in — send the record back to Pending. */
export async function reopenCancellation(eventId: number) {
  await requireUser();

  await db
    .update(orderStatusEvents)
    .set({ checkedInAt: null, checkedInBy: null, itemBack: null, checkinNote: null })
    .where(
      and(
        eq(orderStatusEvents.id, eventId),
        inArray(orderStatusEvents.toStatus, [...TERMINAL_STATUSES]),
      ),
    );

  revalidatePath("/orders");
  return { ok: true as const };
}
