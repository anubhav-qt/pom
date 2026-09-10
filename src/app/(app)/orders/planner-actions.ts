"use server";

import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { catalogImages, orderItems, orders, products, restockPlanItems } from "@/db/schema";
import { ENABLED_CHANNELS } from "@/config/features";
import { requireUser } from "@/lib/auth";
import { parseVariantTitle, sortSizes } from "@/lib/variant-title";

import { OPEN_STATUSES } from "@/lib/fulfilment";

/* -------------------------------------------------------------------------- */
/* Shapes returned to the client                                             */
/* -------------------------------------------------------------------------- */

export interface PlanCell {
  id: number;
  size: string;
  color: string;
  needed: number;
  have: number;
  buyOverride: number | null;
  excluded: boolean;
  buy: number;
}

export interface PlanProduct {
  baseKey: string;
  label: string;
  imageUrl: string | null;
  asin: string | null;
  skuCount: number;
  sizes: string[];
  colors: string[];
  cells: PlanCell[];
  needed: number;
  have: number;
  buy: number;
  /** Variants that need no more attention: excluded, or buy already 0. */
  settled: number;
  variantCount: number;
}

export interface RestockPlan {
  products: PlanProduct[];
  generatedAt: string | null;
  totals: { products: number; needed: number; have: number; buy: number };
}

function buyOf(c: { needed: number; have: number; buyOverride: number | null; excluded: boolean }) {
  if (c.excluded) return 0;
  if (c.buyOverride != null) return Math.max(0, c.buyOverride);
  return Math.max(0, c.needed - c.have);
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

export async function getRestockPlan(): Promise<RestockPlan> {
  await requireUser();

  let items = await db.select().from(restockPlanItems);
  if (items.length === 0) {
    await rebuild();
    items = await db.select().from(restockPlanItems);
  }

  const byKey = new Map<string, typeof items>();
  for (const it of items) {
    const list = byKey.get(it.baseKey);
    if (list) list.push(it);
    else byKey.set(it.baseKey, [it]);
  }

  const products: PlanProduct[] = [];
  for (const group of byKey.values()) {
    const cells: PlanCell[] = group
      .map((g) => ({
        id: g.id,
        size: g.size,
        color: g.color,
        needed: g.needed,
        have: g.have,
        buyOverride: g.buyOverride,
        excluded: g.excluded,
        buy: buyOf(g),
      }))
      .sort((a, b) => a.color.localeCompare(b.color) || a.size.localeCompare(b.size));

    const sizes = sortSizes(group.map((g) => g.size));
    const colors = [...new Set(group.map((g) => g.color))].sort((a, b) => a.localeCompare(b));
    const needed = cells.reduce((s, c) => s + c.needed, 0);
    const have = cells.reduce((s, c) => s + (c.excluded ? 0 : Math.min(c.have, c.needed)), 0);
    const buy = cells.reduce((s, c) => s + c.buy, 0);
    const settled = cells.filter((c) => c.excluded || c.buy === 0).length;

    products.push({
      baseKey: group[0].baseKey,
      label: group[0].baseLabel,
      imageUrl: group[0].imageUrl,
      asin: group[0].asin,
      skuCount: group[0].skuCount,
      sizes,
      colors,
      cells,
      needed,
      have,
      buy,
      settled,
      variantCount: cells.length,
    });
  }

  products.sort((a, b) => b.buy - a.buy || a.label.localeCompare(b.label));

  return {
    products,
    generatedAt: items[0]?.generatedAt?.toISOString() ?? null,
    totals: {
      products: products.length,
      needed: products.reduce((s, p) => s + p.needed, 0),
      have: products.reduce((s, p) => s + p.have, 0),
      buy: products.reduce((s, p) => s + p.buy, 0),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Rebuild from current open orders                                          */
/* -------------------------------------------------------------------------- */

async function rebuild() {
  const rows = await db
    .select({
      title: orderItems.title,
      qty: orderItems.quantity,
      asin: orderItems.externalAsin,
      externalSku: orderItems.externalSku,
      pImage: products.imageUrl,
      ciImage: catalogImages.imageUrl,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .leftJoin(products, eq(products.id, orderItems.productId))
    .leftJoin(
      catalogImages,
      and(
        eq(catalogImages.channelAccountId, orders.channelAccountId),
        eq(catalogImages.asin, orderItems.externalAsin),
      ),
    )
    .where(
      and(
        inArray(orders.status, [...OPEN_STATUSES]),
        inArray(orders.channel, [...ENABLED_CHANNELS]),
        eq(orderItems.cancelled, false),
      ),
    );

  type Agg = {
    baseKey: string;
    label: string;
    image: string | null;
    asin: string | null;
    skus: Set<string>;
    /** size -> colour -> units needed */
    variants: Map<string, Map<string, number>>;
  };
  const map = new Map<string, Agg>();

  for (const r of rows) {
    const parsed = parseVariantTitle(r.title);
    const key = parsed.baseKey || (r.externalSku ?? "unknown");
    let agg = map.get(key);
    if (!agg) {
      agg = { baseKey: key, label: parsed.label, image: null, asin: null, skus: new Set(), variants: new Map() };
      map.set(key, agg);
    }
    if (!agg.image) agg.image = r.pImage ?? r.ciImage ?? null;
    if (!agg.asin && r.asin) agg.asin = r.asin;
    if (r.externalSku) agg.skus.add(r.externalSku);

    const size = parsed.size ?? "";
    const color = parsed.color ?? "";
    let byColor = agg.variants.get(size);
    if (!byColor) {
      byColor = new Map();
      agg.variants.set(size, byColor);
    }
    byColor.set(color, (byColor.get(color) ?? 0) + (r.qty ?? 0));
  }

  const now = new Date();
  const inserts: (typeof restockPlanItems.$inferInsert)[] = [];
  for (const agg of map.values()) {
    for (const [size, byColor] of agg.variants) {
      for (const [color, needed] of byColor) {
        inserts.push({
          baseKey: agg.baseKey,
          baseLabel: agg.label,
          imageUrl: agg.image,
          asin: agg.asin,
          skuCount: agg.skus.size,
          size,
          color,
          needed,
          have: 0,
          buyOverride: null,
          excluded: false,
          generatedAt: now,
          updatedAt: now,
        });
      }
    }
  }

  await db.delete(restockPlanItems);
  if (inserts.length) await db.insert(restockPlanItems).values(inserts);
  return inserts.length;
}

export async function resetRestockPlan(): Promise<RestockPlan> {
  await requireUser();
  await rebuild();
  return getRestockPlan();
}

/* -------------------------------------------------------------------------- */
/* Edits — deliberately fire-and-forget from the client                      */
/* -------------------------------------------------------------------------- */

export async function updateRestockItems(
  ids: number[],
  patch: { have?: number; buyOverride?: number | null; excluded?: boolean },
) {
  await requireUser();
  const clean = ids.filter((n) => Number.isInteger(n));
  if (clean.length === 0) return { ok: true as const };

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.have !== undefined) set.have = Math.max(0, Math.floor(patch.have));
  if (patch.buyOverride !== undefined) {
    set.buyOverride = patch.buyOverride == null ? null : Math.max(0, Math.floor(patch.buyOverride));
  }
  if (patch.excluded !== undefined) set.excluded = patch.excluded;

  await db.update(restockPlanItems).set(set).where(inArray(restockPlanItems.id, clean));
  return { ok: true as const };
}

/** Bulk "we have enough of these": set have = needed, clear any override/exclusion. */
export async function markRestockInStock(ids: number[]) {
  await requireUser();
  const clean = ids.filter((n) => Number.isInteger(n));
  if (clean.length === 0) return { ok: true as const };

  await db
    .update(restockPlanItems)
    .set({
      have: sql`${restockPlanItems.needed}`,
      buyOverride: null,
      excluded: false,
      updatedAt: new Date(),
    })
    .where(inArray(restockPlanItems.id, clean));
  return { ok: true as const };
}
