"use server";

import { db } from "@/db";
import { orderFinance, products } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import {
  freezeOrderCosts,
  getLedgerRows,
  getProductLedger,
  productFamilyKey,
  type LedgerRow,
  type ProductLedgerRow,
} from "@/lib/finance-queries";
import { inArray } from "drizzle-orm";

import { DEFAULT_BASIS, isBasis, type Basis } from "./range";

export interface LedgerData {
  /** One row per product, every size and colour together: where cost prices are entered. */
  products: ProductLedgerRow[];
  /** One row per order, with cost and profit worked out from the product cost prices. */
  orders: LedgerRow[];
}

/**
 * The ledger for a date range. `from` and `to` are calendar days (YYYY-MM-DD)
 * and `to` is inclusive; the range is read in India time so a day on the sheet
 * is a day on the wall.
 */
export async function getLedger(input: {
  from: string;
  to: string;
  basis?: string;
}): Promise<({ ok: true } & LedgerData) | { ok: false; error: string }> {
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
  const to = new Date(toDay.getTime() + 86_400_000);
  const [productRows, orders] = await Promise.all([
    getProductLedger(from, to, basis),
    getLedgerRows(from, to, basis),
  ]);
  return { ok: true, products: productRows, orders };
}

/**
 * Set what one unit of a product costs, for every size and colour of it. Every
 * order of those SKUs, past and future, is costed from it, so changing the
 * figure later re-costs them all. An empty cost clears it.
 */
export async function setProductCost(input: { key: string; cost: number | null }) {
  await requireUser();

  if (input.cost !== null && (!Number.isFinite(input.cost) || input.cost < 0 || input.cost > 10_000_000)) {
    return { ok: false as const, error: "Cost must be a positive amount." };
  }

  const all = await db.select({ id: products.id, name: products.name }).from(products);
  const ids = all.filter((p) => productFamilyKey(p.name) === input.key).map((p) => p.id);
  if (ids.length === 0) return { ok: false as const, error: "That product no longer exists." };

  // Orders already costed keep the price they were costed at; only orders that
  // had no cost yet pick up the new one.
  await freezeOrderCosts();
  await db
    .update(products)
    .set({ costPrice: input.cost === null ? null : input.cost.toFixed(2) })
    .where(inArray(products.id, ids));
  await freezeOrderCosts();

  return { ok: true as const, updated: ids.length };
}

/** Save the note on an order. */
export async function saveOrderNote(input: { orderId: number; note: string }) {
  const user = await requireUser();
  const values = {
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
