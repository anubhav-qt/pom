"use server";

import { revalidatePath } from "next/cache";

import { requireOwner, requireUser } from "@/lib/auth";
import { actOnParibelleOrder, type ParibelleOrderAction } from "@/lib/paribelle";

/**
 * A paribelle.in order changed from its popup: the store is updated first (and
 * tells the customer), then the OMS takes the store's answer. A COD refusal can
 * give the customer credit, so it's the owner's call.
 */
export async function paribelleOrderAction(
  orderId: number,
  act: ParibelleOrderAction,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = act.action === "cod_refused" ? await requireOwner() : await requireUser();
  try {
    await actOnParibelleOrder(orderId, act, user.id);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath("/orders");
  revalidatePath("/returns");
  revalidatePath("/inventory");
  return { ok: true };
}
