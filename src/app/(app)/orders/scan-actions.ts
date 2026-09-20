"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { orderItems, returns } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { recordScan } from "@/lib/fulfilment";
import { adjustStock } from "@/lib/inventory";
import { lookupScan, type ScanLookup } from "@/lib/scan";

import { checkInCancellation } from "./actions";
import { getCancellationRecords } from "./queries";

/**
 * Server actions behind the Scan Barcode modal.
 *
 * Deliberately thin: the lookup lives in lib/scan and the commit paths reuse
 * the same functions the existing screens already use, so a scan and a click
 * on the table produce identical records.
 */

export async function scanLookup(code: string): Promise<ScanLookup> {
  await requireUser();
  return lookupScan(code);
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
