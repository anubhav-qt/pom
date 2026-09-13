"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { orderFulfilment, orderItems, orders, returns } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { mapAwbToOrder, markManifestedLocal, recordScan } from "@/lib/fulfilment";
import { adjustStock } from "@/lib/inventory";
import { lookupScan, type ScanLookup, type ScanStation } from "@/lib/scan";
import { recomputeReserved } from "@/lib/sync";

import { checkInCancellation } from "./actions";
import { getCancellationRecords } from "./queries";
import { getOrdersView } from "./view-actions";

/**
 * Server actions behind the Scan Barcode modal.
 *
 * Deliberately thin: the lookup lives in lib/scan and the two commit paths
 * reuse the same functions the existing screens already use, so a scan and a
 * click on the table produce identical records.
 */

export async function scanLookup(station: ScanStation, code: string): Promise<ScanLookup> {
  await requireUser();
  return lookupScan(station, code);
}

/**
 * Packed orders for the "map this scan" picker — the exact same rows, in the
 * exact same order, as the Orders page's Packed tab (all enabled channels, no
 * search). Mapping an order that already has an AWB just replaces it, so
 * there is no "already mapped" filtering here; `mapAwbToOrder` still refuses
 * a code already tied to a *different* order.
 */
export async function scanListPackedOrders() {
  await requireUser();
  const view = await getOrdersView({ tab: "packed" });
  return view.kind === "list" ? view.rows : [];
}

/**
 * Tie a scanned code (an AWB Amazon never handed us through sync) to a packed
 * order the operator picks by hand. On success this behaves exactly like a
 * normal outbound scan of that order, since the code now resolves on its own.
 */
export async function scanMapAwb(orderId: number, code: string): Promise<ScanLookup | { ok: false; error: string }> {
  const user = await requireUser();

  const res = await mapAwbToOrder(orderId, code, user.id);
  await recordScan({
    orderId,
    station: "outbound",
    code,
    matchedOn: "awb",
    applied: res.ok,
    rejectedReason: res.ok ? null : res.error,
    scannedBy: user.id,
  });

  if (!res.ok) return res;

  revalidatePath("/orders");
  return lookupScan("outbound", code);
}

/**
 * Map an AWB to an order and immediately mark it dispatched. A manual AWB
 * entry — from the "no match" picker or mapTo mode — means the parcel is
 * already in hand and going out; there is no separate packing step to wait
 * for, so this always finishes the job in one round trip rather than leaving
 * the operator to hit a second "Confirm dispatch".
 *
 * Reuses `scanMapAwb` and `scanConfirmPacked` as-is (both already record
 * their own scan and are idempotent) instead of duplicating either.
 */
export async function scanMapAndDispatch(
  orderId: number,
  code: string,
): Promise<{ ok: true; externalOrderId: string; already: boolean } | { ok: false; error: string }> {
  const mapped = await scanMapAwb(orderId, code);
  if (!mapped.ok) {
    return { ok: false, error: "error" in mapped ? mapped.error : mapped.message };
  }

  return scanConfirmPacked(orderId);
}

/* ------------------------------------------------------------- outbound -- */

/**
 * Outbound scan marks parcel manifested (dispatched) and takes stock off shelf.
 *
 * Safe to call twice: a duplicate scan returns a soft 'already' rather than an error
 * and avoids decrementing stock again.
 */
export async function scanConfirmPacked(orderId: number) {
  const user = await requireUser();

  const [order] = await db
    .select({
      status: orders.status,
      externalOrderId: orders.externalOrderId,
      state: orderFulfilment.state,
    })
    .from(orders)
    .leftJoin(orderFulfilment, eq(orderFulfilment.orderId, orders.id))
    .where(eq(orders.id, orderId))
    .limit(1);

  if (!order) return { ok: false as const, error: "Order not found." };

  // The marketplace still gets a veto on shipping: a cancelled order must not
  // go out whatever our bench thinks.
  if (["cancelled", "rto", "returned"].includes(order.status)) {
    await recordScan({
      orderId,
      station: "outbound",
      code: order.externalOrderId,
      applied: false,
      rejectedReason: `order is ${order.status}`,
      scannedBy: user.id,
    });
    return { ok: false as const, error: `STOP. This order is ${order.status.toUpperCase()}.` };
  }

  // If already manifested, it is already dispatched.
  if (order.state === "manifested") {
    await recordScan({
      orderId,
      station: "outbound",
      code: order.externalOrderId,
      applied: false,
      rejectedReason: "already dispatched",
      scannedBy: user.id,
    });
    return { ok: true as const, already: true as const, externalOrderId: order.externalOrderId };
  }

  // Adjust stock if it hasn't been packed yet
  if ((order.state ?? "to_pack") === "to_pack") {
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
        note: "Scanned at outbound dispatch",
      });
    }
  }

  await markManifestedLocal([orderId], user.id);
  await recordScan({
    orderId,
    station: "outbound",
    code: order.externalOrderId,
    matchedOn: "order_id",
    applied: true,
    scannedBy: user.id,
  });

  await recomputeReserved();
  revalidatePath("/orders");

  return { ok: true as const, already: false as const, externalOrderId: order.externalOrderId };
}

/* -------------------------------------------------------------- inbound -- */

/**
 * Cancellations, RTOs and customer returns still waiting on a physical
 * check-in — the exact same rows the Cancellations tab's Pending list shows
 * (customer returns live on the separate /returns page with its own action
 * and aren't part of this rollup). Backs the "scan return for this order"
 * picker when a goods-in scan matches nothing.
 */
export async function scanListAwaitingCheckIn() {
  await requireUser();
  return getCancellationRecords({ resolved: false, sinceDays: 30 });
}

/**
 * Log a code scanned mid check-in that matched no order of its own — almost
 * always the return parcel's own AWB or tracking sticker. `order_status_events`
 * (cancellations/RTOs) has no field to hold that, so rather than invent one,
 * this just files it into the scan log against the order; the log is enough
 * for someone to trace it back later.
 */
export async function scanRecordReturnCode(orderId: number, code: string) {
  const user = await requireUser();
  await recordScan({
    orderId,
    station: "inbound",
    code,
    matchedOn: "return_code",
    applied: true,
    scannedBy: user.id,
  });
  return { ok: true as const };
}

/**
 * Check a scanned parcel back in.
 *
 * `kind` comes straight from the lookup, so the person scanning never has to
 * know whether they are holding an RTO or a customer return: the two live in
 * different tables and this dispatches to whichever one was waiting.
 *
 * `itemBack` is the same decision the checkbox on the Cancelled & RTO screen
 * asks for, and it means the same thing here: goods physically received and
 * sellable. Returns additionally put the stock back on, which is why it is a
 * choice and not automatic, because marketplace returns come back worn often enough
 * that auto-restocking is how a used item reaches the next customer.
 */
export async function scanCheckIn(input: {
  kind: "cancellation" | "return";
  recordId: number;
  itemBack: boolean;
  note?: string;
  /** Logged verbatim so the scan record shows what was actually scanned. */
  code?: string;
  orderId?: number;
}) {
  const user = await requireUser();

  if (input.kind === "cancellation") {
    const res = await checkInCancellation(input.recordId, {
      itemBack: input.itemBack,
      note: input.note?.trim() || "Scanned in at goods-in",
    });
    await recordScan({
      orderId: input.orderId ?? null,
      station: "inbound",
      code: input.code ?? String(input.recordId),
      itemBack: input.itemBack,
      note: input.note,
      applied: res.ok,
      rejectedReason: res.ok ? null : res.error,
      scannedBy: user.id,
    });
    if (!res.ok) return res;
    revalidatePath("/orders");
    return { ok: true as const };
  }

  const [row] = await db
    .select()
    .from(returns)
    .where(eq(returns.id, input.recordId))
    .limit(1);

  if (!row) return { ok: false as const, error: "Return not found." };
  if (row.receivedAt) {
    await recordScan({
      orderId: row.orderId,
      station: "inbound",
      code: input.code ?? String(input.recordId),
      applied: false,
      rejectedReason: "already checked in",
      scannedBy: user.id,
    });
    return { ok: false as const, error: "Already checked in." };
  }

  await db
    .update(returns)
    .set({
      receivedAt: new Date(),
      receivedBy: user.id,
      restocked: input.itemBack,
      conditionNote: input.note?.trim() || "Scanned in at goods-in",
    })
    .where(eq(returns.id, input.recordId));

  if (input.itemBack && row.orderId) {
    const items = await db
      .select({ productId: orderItems.productId, quantity: orderItems.quantity })
      .from(orderItems)
      .where(eq(orderItems.orderId, row.orderId));

    for (const item of items) {
      if (item.productId === null) continue;
      await adjustStock({
        productId: item.productId,
        delta: item.quantity,
        reason: "return_received",
        refType: "return",
        refId: input.recordId,
        userId: user.id,
        note: input.note?.trim() || "Restocked from a scanned return",
      });
    }
  }

  await recordScan({
    orderId: row.orderId,
    station: "inbound",
    code: input.code ?? String(input.recordId),
    itemBack: input.itemBack,
    note: input.note,
    applied: true,
    scannedBy: user.id,
  });

  revalidatePath("/returns");
  revalidatePath("/orders");
  revalidatePath("/inventory");

  return { ok: true as const };
}
