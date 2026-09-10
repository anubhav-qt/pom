"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { orderFulfilment, orderItems, orders, returns } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { markPackedLocal, recordScan } from "@/lib/fulfilment";
import { adjustStock } from "@/lib/inventory";
import { lookupScan, type ScanLookup, type ScanStation } from "@/lib/scan";
import { recomputeReserved } from "@/lib/sync";

import { checkInCancellation } from "./actions";

/**
 * Server actions behind the Scan Barcode modal.
 *
 * Deliberately thin: the lookup lives in `lib/scan` and the two commit paths
 * reuse the same functions the existing screens already use, so a scan and a
 * click on the table produce byte-identical records. A scan station that
 * quietly wrote different rows from the manual flow would be worse than no scan
 * station at all.
 */

export async function scanLookup(station: ScanStation, code: string): Promise<ScanLookup> {
  await requireUser();
  return lookupScan(station, code);
}

/* ------------------------------------------------------------- outbound -- */

/**
 * Mark a scanned parcel packed and take the stock off the shelf.
 *
 * This is `pack/actions.ts#confirmPacked` with one difference: it is safe to
 * call twice. A scanner that fires a duplicate — and they do, a second read as
 * the parcel moves past the beam — must not decrement stock again, so an order
 * that is already packed returns a soft `already` rather than an error.
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

  // The marketplace still gets a veto on shipping — a cancelled order must not
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
    return { ok: false as const, error: `STOP — this order is ${order.status.toUpperCase()}.` };
  }

  // Whether it is already packed is purely our own record.
  if ((order.state ?? "to_pack") !== "to_pack") {
    await recordScan({
      orderId,
      station: "outbound",
      code: order.externalOrderId,
      applied: false,
      rejectedReason: "already packed",
      scannedBy: user.id,
    });
    return { ok: true as const, already: true as const, externalOrderId: order.externalOrderId };
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
      note: "Scanned at the pack bench",
    });
  }

  await markPackedLocal([orderId], user.id);
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
 * Check a scanned parcel back in.
 *
 * `kind` comes straight from the lookup, so the person scanning never has to
 * know whether they are holding an RTO or a customer return — the two live in
 * different tables and this dispatches to whichever one was waiting.
 *
 * `itemBack` is the same decision the checkbox on the Cancelled & RTO screen
 * asks for, and it means the same thing here: goods physically received and
 * sellable. Returns additionally put the stock back on, which is why it is a
 * choice and not automatic — marketplace returns come back worn often enough
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
