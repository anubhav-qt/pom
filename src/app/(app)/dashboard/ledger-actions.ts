"use server";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { orderFinance } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { getLedgerRows, type LedgerRow } from "@/lib/finance-queries";

import { DEFAULT_BASIS, isBasis, type Basis } from "./range";

/**
 * The order ledger for a date range. `from` and `to` are calendar days
 * (YYYY-MM-DD) and `to` is inclusive; the range is read in India time so a
 * day on the sheet is a day on the wall.
 */
export async function getLedger(input: {
  from: string;
  to: string;
  basis?: string;
}): Promise<{ ok: true; rows: LedgerRow[] } | { ok: false; error: string }> {
  await requireUser();

  const from = new Date(`${input.from}T00:00:00+05:30`);
  const toDay = new Date(`${input.to}T00:00:00+05:30`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(toDay.getTime())) {
    return { ok: false, error: "Pick a valid start and end date." };
  }
  if (toDay.getTime() < from.getTime()) return { ok: false, error: "The end date is before the start date." };
  if (toDay.getTime() - from.getTime() > 400 * 86_400_000) {
    return { ok: false, error: "Pick a range of a year or less." };
  }

  const basis: Basis = isBasis(input.basis) ? input.basis : DEFAULT_BASIS;
  const rows = await getLedgerRows(from, new Date(toDay.getTime() + 86_400_000), basis);
  return { ok: true, rows };
}

/** Save what an order cost us and a note. An empty cost clears it. */
export async function saveOrderFinance(input: { orderId: number; cost: number | null; note: string }) {
  const user = await requireUser();

  if (input.cost !== null && (!Number.isFinite(input.cost) || input.cost < 0 || input.cost > 10_000_000)) {
    return { ok: false as const, error: "Cost must be a positive amount." };
  }
  const values = {
    costPrice: input.cost === null ? null : input.cost.toFixed(2),
    note: input.note.trim().slice(0, 500) || null,
    updatedBy: user.id,
    updatedAt: new Date(),
  };

  await db
    .insert(orderFinance)
    .values({ orderId: input.orderId, ...values })
    .onConflictDoUpdate({ target: orderFinance.orderId, set: values });

  return { ok: true as const };
}

/** Forget the saved cost for an order so it falls back to the product's cost price. */
export async function clearOrderCost(orderId: number) {
  await requireUser();
  await db.update(orderFinance).set({ costPrice: null }).where(eq(orderFinance.orderId, orderId));
  return { ok: true as const };
}
