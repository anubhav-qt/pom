"use server";

import { and, eq, inArray, or, sql } from "drizzle-orm";

import { db } from "@/db";
import { orderFulfilment, orderItems, orders, products, shipments } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { OPEN_STATUSES, markPackedLocal } from "@/lib/fulfilment";
import { adjustStock } from "@/lib/inventory";
import { recomputeReserved } from "@/lib/sync";

export interface ScanResult {
  found: boolean;
  message?: string;
  order?: {
    id: number;
    channel: string;
    externalOrderId: string;
    status: string;
    buyerName: string | null;
    shipCity: string | null;
    alreadyPacked: boolean;
    items: {
      sku: string;
      title: string | null;
      quantity: number;
      binLocation: string | null;
      mapped: boolean;
    }[];
  };
}

/**
 * Resolve whatever the scanner produced into an order.
 *
 * A packer might scan the AWB on a pre-printed label, the marketplace order id,
 * or the Meesho packet id — so all three are tried rather than forcing them to
 * know which barcode is which.
 */
export async function scanOrder(code: string): Promise<ScanResult> {
  await requireUser();
  const value = code.trim();
  if (!value) return { found: false, message: "Nothing scanned." };

  const [row] = await db
    .select({
      id: orders.id,
      channel: orders.channel,
      externalOrderId: orders.externalOrderId,
      status: orders.status,
      buyerName: orders.buyerName,
      shipCity: orders.shipCity,
      packedAt: shipments.packedAt,
      fulfilmentState: orderFulfilment.state,
    })
    .from(orders)
    .leftJoin(shipments, eq(shipments.orderId, orders.id))
    .leftJoin(orderFulfilment, eq(orderFulfilment.orderId, orders.id))
    .where(
      or(
        eq(orders.externalOrderId, value),
        eq(shipments.awb, value),
        eq(shipments.externalShipmentId, value),
      ),
    )
    .limit(1);

  if (!row) {
    return { found: false, message: `No order matches "${value}".` };
  }

  if (["cancelled", "rto", "returned"].includes(row.status)) {
    // The whole point of scanning before packing: stop a cancelled order from
    // going out of the door.
    return {
      found: false,
      message: `STOP — this order is ${row.status.toUpperCase()}. Do not ship it.`,
    };
  }

  const items = await db
    .select({
      sku: orderItems.externalSku,
      title: orderItems.title,
      quantity: orderItems.quantity,
      productId: orderItems.productId,
      binLocation: products.binLocation,
    })
    .from(orderItems)
    .leftJoin(products, eq(products.id, orderItems.productId))
    .where(eq(orderItems.orderId, row.id));

  return {
    found: true,
    order: {
      id: row.id,
      channel: row.channel,
      externalOrderId: row.externalOrderId,
      status: row.status,
      buyerName: row.buyerName,
      shipCity: row.shipCity,
      alreadyPacked: (row.fulfilmentState ?? "to_pack") !== "to_pack",
      items: items.map((i) => ({
        sku: i.sku,
        title: i.title,
        quantity: i.quantity,
        binLocation: i.binLocation,
        mapped: i.productId !== null,
      })),
    },
  };
}

/**
 * Confirm a parcel is packed and take the stock off the shelf.
 *
 * Stock is decremented here rather than at order time because this is the
 * moment the unit physically leaves — and it is the only moment we are certain
 * it did.
 */
export async function confirmPacked(orderId: number) {
  const user = await requireUser();

  const [order] = await db
    .select({ status: orders.status })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) return { ok: false as const, error: "Order not found." };

  // Our own state decides whether this is a duplicate, not the marketplace's —
  // Amazon has no opinion on whether a parcel has been boxed.
  const [fulfilment] = await db
    .select({ state: orderFulfilment.state })
    .from(orderFulfilment)
    .where(eq(orderFulfilment.orderId, orderId))
    .limit(1);
  if (fulfilment && fulfilment.state !== "to_pack") {
    return { ok: false as const, error: "Already packed." };
  }

  const items = await db
    .select({ productId: orderItems.productId, quantity: orderItems.quantity })
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId));

  for (const item of items) {
    if (item.productId === null) continue; // Unmapped SKUs are not stock-controlled.
    await adjustStock({
      productId: item.productId,
      delta: -item.quantity,
      reason: "order_packed",
      refType: "order",
      refId: orderId,
      userId: user.id,
    });
  }

  await markPackedLocal([orderId], user.id);
  await recomputeReserved();

  return { ok: true as const };
}

/** Counts for the packing screen header, so progress is visible without leaving it. */
export async function packStats() {
  await requireUser();
  const [row] = await db
    .select({
      remaining: sql<number>`COUNT(*) FILTER (WHERE COALESCE(${orderFulfilment.state}, 'to_pack') = 'to_pack')`,
      packedToday: sql<number>`COUNT(*) FILTER (WHERE ${orderFulfilment.state} = 'packed')`,
    })
    .from(orders)
    .leftJoin(orderFulfilment, eq(orderFulfilment.orderId, orders.id))
    .where(and(inArray(orders.status, [...OPEN_STATUSES]), sql`COALESCE(${orderFulfilment.state}, 'to_pack') <> 'manifested'`));

  return {
    remaining: Number(row?.remaining ?? 0),
    packedToday: Number(row?.packedToday ?? 0),
  };
}
