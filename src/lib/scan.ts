import "server-only";

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  orderFulfilment,
  orderItems,
  orders,
  orderStatusEvents,
  products,
  returns,
  shipments,
  type Channel,
  type OrderStatus,
} from "@/db/schema";

/**
 * Barcode lookup, shared by both scan stations.
 *
 * Nobody at a packing bench knows, or should have to know, which of the three
 * barcodes on a label is "the" order id. Amazon's Easy Ship label carries the
 * order id and the AWB; a return sticker carries the AWB and sometimes a return
 * id of its own. So every scan is tried against all of them, and the caller
 * finds out what it matched rather than being asked up front.
 *
 * Codes are matched case-insensitively with surrounding whitespace stripped:
 * hand-typed entry is a first-class input here, not a fallback, and people type
 * lower case.
 */

/** Terminal statuses that mean a parcel may be coming back to us. */
const TERMINAL_STATUSES = ["cancelled", "rto", "returned"] as const;

export type ScanStation = "outbound" | "inbound";

export interface ScanItem {
  sku: string;
  title: string | null;
  quantity: number;
  imageUrl: string | null;
  binLocation: string | null;
  /** False when the SKU has no product behind it, so it is not stock-controlled. */
  mapped: boolean;
}

/** Everything both stations show about whatever was scanned. */
export interface ScanOrderSummary {
  orderId: number;
  channel: Channel;
  externalOrderId: string;
  status: OrderStatus;
  buyerName: string | null;
  shipCity: string | null;
  shipState: string | null;
  totalAmount: string | null;
  isCod: boolean;
  items: ScanItem[];
}

export type ScanLookup =
  | { ok: false; code: string; reason: "empty" | "not_found" | "blocked"; message: string }
  | {
      ok: true;
      code: string;
      /** Which barcode on the label this turned out to be. */
      matchedOn: "order_id" | "awb" | "shipment_id" | "return_id";
      order: ScanOrderSummary;
      /** Outbound only: what packing this parcel would do. */
      outbound?: {
        /** Already `packed` or beyond, so scanning again would double-count. */
        alreadyPacked: boolean;
        packedAt: Date | null;
      };
      /** Inbound only: the pending record this scan would check in. */
      inbound?: {
        kind: "cancellation" | "return";
        /** `order_status_events.id` for a cancellation, `returns.id` for a return. */
        recordId: number;
        /** Cancelled / RTO / customer return, for the wording on screen. */
        label: string;
        /** Already checked in, so scanning again would double-restock. */
        alreadyReceived: boolean;
        receivedAt: Date | null;
      };
    };

/* -------------------------------------------------------------------------- */

async function itemsFor(orderId: number): Promise<ScanItem[]> {
  const rows = await db
    .select({
      sku: orderItems.externalSku,
      title: orderItems.title,
      quantity: orderItems.quantity,
      productId: orderItems.productId,
      imageUrl: products.imageUrl,
      binLocation: products.binLocation,
    })
    .from(orderItems)
    .leftJoin(products, eq(products.id, orderItems.productId))
    .where(eq(orderItems.orderId, orderId));

  return rows.map((r) => ({
    sku: r.sku,
    title: r.title,
    quantity: r.quantity,
    imageUrl: r.imageUrl,
    binLocation: r.binLocation,
    mapped: r.productId !== null,
  }));
}

/**
 * Find the order a scanned code belongs to, whichever barcode it came from.
 * Returns the order plus how it was matched, so the caller can say so.
 */
async function findOrder(value: string) {
  const [row] = await db
    .select({
      id: orders.id,
      channel: orders.channel,
      externalOrderId: orders.externalOrderId,
      status: orders.status,
      buyerName: orders.buyerName,
      shipCity: orders.shipCity,
      shipState: orders.shipState,
      totalAmount: orders.totalAmount,
      isCod: orders.isCod,
      packedAt: orderFulfilment.packedAt,
      fulfilmentState: orderFulfilment.state,
      awb: shipments.awb,
      shipmentId: shipments.externalShipmentId,
    })
    .from(orders)
    .leftJoin(shipments, eq(shipments.orderId, orders.id))
    .leftJoin(orderFulfilment, eq(orderFulfilment.orderId, orders.id))
    .where(
      or(
        sql`lower(${orders.externalOrderId}) = ${value}`,
        sql`lower(${shipments.awb}) = ${value}`,
        sql`lower(${shipments.externalShipmentId}) = ${value}`,
      ),
    )
    .limit(1);

  if (!row) return null;

  const matchedOn: "order_id" | "awb" | "shipment_id" =
    row.externalOrderId.toLowerCase() === value
      ? "order_id"
      : row.awb?.toLowerCase() === value
        ? "awb"
        : "shipment_id";

  return { row, matchedOn };
}

function summary(row: {
  id: number;
  channel: Channel;
  externalOrderId: string;
  status: OrderStatus;
  buyerName: string | null;
  shipCity: string | null;
  shipState: string | null;
  totalAmount: string | null;
  isCod: boolean;
}, items: ScanItem[]): ScanOrderSummary {
  return {
    orderId: row.id,
    channel: row.channel,
    externalOrderId: row.externalOrderId,
    status: row.status,
    buyerName: row.buyerName,
    shipCity: row.shipCity,
    shipState: row.shipState,
    totalAmount: row.totalAmount,
    isCod: row.isCod,
    items,
  };
}

/* -------------------------------------------------------------- inbound -- */

/**
 * Inbound: a parcel has come back off the delivery van.
 *
 * Two different records can be waiting for it, and the person holding the
 * parcel has no way to tell which: an RTO that never reached the buyer is an
 * `order_status_events` row, a customer return is a `returns` row. Both are
 * looked up and whichever is pending wins, so one scanner covers both.
 *
 * Returns are checked first: if an order has both, the return is the more
 * recent physical movement.
 */
export async function lookupInbound(code: string): Promise<ScanLookup> {
  const value = code.trim().toLowerCase();
  if (!value) return { ok: false, code, reason: "empty", message: "Nothing scanned." };

  // A return sticker may carry its own id or AWB, neither of which is on the
  // order, so returns get their own lookup before the order lookup.
  const [ret] = await db
    .select({
      id: returns.id,
      orderId: returns.orderId,
      kind: returns.kind,
      receivedAt: returns.receivedAt,
    })
    .from(returns)
    .where(
      or(
        sql`lower(${returns.externalReturnId}) = ${value}`,
        sql`lower(${returns.awb}) = ${value}`,
      ),
    )
    .orderBy(desc(returns.createdAt))
    .limit(1);

  const found = await findOrder(value);

  // Prefer a return found directly; otherwise look for one against the order.
  let returnRow = ret;
  if (!returnRow && found) {
    const [byOrder] = await db
      .select({
        id: returns.id,
        orderId: returns.orderId,
        kind: returns.kind,
        receivedAt: returns.receivedAt,
      })
      .from(returns)
      .where(eq(returns.orderId, found.row.id))
      .orderBy(desc(returns.createdAt))
      .limit(1);
    returnRow = byOrder;
  }

  if (returnRow?.orderId) {
    const [orderRow] = await db
      .select({
        id: orders.id,
        channel: orders.channel,
        externalOrderId: orders.externalOrderId,
        status: orders.status,
        buyerName: orders.buyerName,
        shipCity: orders.shipCity,
        shipState: orders.shipState,
        totalAmount: orders.totalAmount,
        isCod: orders.isCod,
      })
      .from(orders)
      .where(eq(orders.id, returnRow.orderId))
      .limit(1);

    if (orderRow) {
      return {
        ok: true,
        code,
        matchedOn: found ? found.matchedOn : "return_id",
        order: summary(orderRow, await itemsFor(orderRow.id)),
        inbound: {
          kind: "return",
          recordId: returnRow.id,
          label: returnRow.kind === "exchange" ? "Exchange" : "Customer return",
          alreadyReceived: returnRow.receivedAt !== null,
          receivedAt: returnRow.receivedAt,
        },
      };
    }
  }

  if (!found) {
    return {
      ok: false,
      code,
      reason: "not_found",
      message: `Nothing coming back matches "${code.trim()}".`,
    };
  }
  const { row, matchedOn } = found;

  // No return record, so look for a cancellation/RTO check-in instead. Prefer one
  // that is still pending; fall back to the most recent so a second scan can
  // say "already checked in" rather than "not found", which would send someone
  // hunting for a record that is sitting right there.
  const [event] = await db
    .select({
      id: orderStatusEvents.id,
      toStatus: orderStatusEvents.toStatus,
      checkedInAt: orderStatusEvents.checkedInAt,
    })
    .from(orderStatusEvents)
    .where(
      and(
        eq(orderStatusEvents.orderId, row.id),
        inArray(orderStatusEvents.toStatus, [...TERMINAL_STATUSES]),
      ),
    )
    .orderBy(sql`${orderStatusEvents.checkedInAt} NULLS FIRST`, desc(orderStatusEvents.detectedAt))
    .limit(1);

  if (!event) {
    return {
      ok: false,
      code,
      reason: "not_found",
      message:
        `${row.externalOrderId} is ${row.status.replace("_", " ")}, so nothing is expected back for it. ` +
        `If it has genuinely come back, wait for the next sync to pick the cancellation up.`,
    };
  }

  return {
    ok: true,
    code,
    matchedOn,
    order: summary(row, await itemsFor(row.id)),
    inbound: {
      kind: "cancellation",
      recordId: event.id,
      label: event.toStatus === "rto" ? "RTO" : "Cancelled",
      alreadyReceived: event.checkedInAt !== null,
      receivedAt: event.checkedInAt,
    },
  };
}

export async function lookupScan(code: string): Promise<ScanLookup> {
  return lookupInbound(code);
}

/** Pending inbound work, for the scan modal's header. */
export async function inboundPendingCount() {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orderStatusEvents)
    .where(
      and(
        inArray(orderStatusEvents.toStatus, [...TERMINAL_STATUSES]),
        isNull(orderStatusEvents.checkedInAt),
      ),
    );
  return Number(row?.n ?? 0);
}
