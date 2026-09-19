"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { orderItems, returns } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { adjustStock } from "@/lib/inventory";

/**
 * Check a returned parcel back in.
 *
 * Restocking is a deliberate decision, not automatic: a lot of marketplace
 * returns come back damaged or worn, and putting those back into sellable
 * stock is how you end up shipping a used item to the next customer.
 */
export async function receiveReturn(input: {
  returnId: number;
  restock: boolean;
  conditionNote?: string;
}) {
  const user = await requireUser();

  const [row] = await db
    .select()
    .from(returns)
    .where(eq(returns.id, input.returnId))
    .limit(1);

  if (!row) return { ok: false as const, error: "Return not found." };
  if (row.receivedAt) return { ok: false as const, error: "Already checked in." };

  await db
    .update(returns)
    .set({
      receivedAt: new Date(),
      receivedBy: user.id,
      restocked: input.restock,
      outcome: input.restock ? "reshelved" : "damaged",
      conditionNote: input.conditionNote?.trim() || null,
    })
    .where(eq(returns.id, input.returnId));

  if (input.restock && row.orderId) {
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
        refId: input.returnId,
        userId: user.id,
        note: input.conditionNote?.trim() || "Restocked from return",
      });
    }
  }

  revalidatePath("/returns");
  revalidatePath("/inventory");
  return { ok: true as const };
}

/**
 * Close a return that will not be checked in: the parcel never came back
 * (`written_off`) or we have taken it up with Amazon (`claim_raised`). Neither
 * touches stock, and both can be undone with `reopenReturn`.
 */
export async function closeReturnWithoutParcel(input: {
  returnId: number;
  outcome: "written_off" | "claim_raised";
  note?: string;
}) {
  await requireUser();
  const [row] = await db.select().from(returns).where(eq(returns.id, input.returnId)).limit(1);
  if (!row) return { ok: false as const, error: "Return not found." };
  if (row.receivedAt) return { ok: false as const, error: "Already checked in." };

  await db
    .update(returns)
    .set({ outcome: input.outcome, conditionNote: input.note?.trim() || row.conditionNote })
    .where(eq(returns.id, input.returnId));

  revalidatePath("/returns");
  return { ok: true as const };
}

/** Undo a write-off or a claim. A check-in is not undone here: it moved stock. */
export async function reopenReturn(returnId: number) {
  await requireUser();
  const [row] = await db.select().from(returns).where(eq(returns.id, returnId)).limit(1);
  if (!row) return { ok: false as const, error: "Return not found." };
  if (row.receivedAt) return { ok: false as const, error: "A checked-in return cannot be reopened." };

  await db.update(returns).set({ outcome: null }).where(eq(returns.id, returnId));
  revalidatePath("/returns");
  return { ok: true as const };
}
