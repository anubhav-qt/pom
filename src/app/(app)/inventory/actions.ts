"use server";

import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { channelListings, inventory, orderItems, orders, products } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { adjustStock, pushInventoryToChannels } from "@/lib/inventory";

export async function setStock(productId: number, newCount: number, note?: string) {
  const user = await requireUser();

  const [current] = await db
    .select({ onHand: inventory.onHand })
    .from(inventory)
    .where(eq(inventory.productId, productId))
    .limit(1);

  const delta = newCount - (current?.onHand ?? 0);
  if (delta === 0) return { ok: true as const, delta: 0 };

  await adjustStock({
    productId,
    delta,
    reason: "stock_take",
    note: note ?? "Manual count",
    userId: user.id,
  });

  revalidatePath("/inventory");
  return { ok: true as const, delta };
}

export async function setBuffer(productId: number, buffer: number) {
  await requireUser();
  await db
    .update(inventory)
    .set({ buffer: Math.max(0, buffer), updatedAt: new Date() })
    .where(eq(inventory.productId, productId));

  revalidatePath("/inventory");
  return { ok: true as const };
}

/**
 * Create a product and its channel mapping from an unmapped SKU seen on an
 * order. This is the fast path out of the "unmapped" warning in the queue —
 * the SKU already exists on the channel, we just have not met it yet.
 */
export async function adoptUnmappedSku(input: {
  externalSku: string;
  channelAccountId: number;
  name: string;
  ourSku?: string;
  binLocation?: string;
  openingStock?: number;
}) {
  const user = await requireUser();
  const sku = (input.ourSku?.trim() || input.externalSku).trim();

  const [product] = await db
    .insert(products)
    .values({
      sku,
      name: input.name.trim() || sku,
      binLocation: input.binLocation?.trim() || null,
    })
    .onConflictDoUpdate({
      target: products.sku,
      set: { name: input.name.trim() || sku },
    })
    .returning({ id: products.id });

  await db
    .insert(inventory)
    .values({ productId: product.id, onHand: 0 })
    .onConflictDoNothing();

  await db
    .insert(channelListings)
    .values({
      productId: product.id,
      channelAccountId: input.channelAccountId,
      externalSku: input.externalSku,
    })
    .onConflictDoUpdate({
      target: [channelListings.channelAccountId, channelListings.externalSku],
      set: { productId: product.id, active: true },
    });

  // Backfill the mapping onto orders already sitting in the queue, so the
  // "unmapped" warning clears without waiting for the next sync.
  await db
    .update(orderItems)
    .set({ productId: product.id })
    .where(and(eq(orderItems.externalSku, input.externalSku), isNull(orderItems.productId)));

  if (input.openingStock && input.openingStock > 0) {
    await adjustStock({
      productId: product.id,
      delta: input.openingStock,
      reason: "manual",
      note: "Opening stock at mapping",
      userId: user.id,
    });
  }

  revalidatePath("/inventory");
  revalidatePath("/orders");
  return { ok: true as const, productId: product.id };
}

export async function syncStockToChannels(productId?: number) {
  await requireUser();
  const results = await pushInventoryToChannels(productId ? [productId] : undefined);

  const pushed = Object.values(results).reduce((a, r) => a + r.pushed, 0);
  const failed = Object.values(results).reduce((a, r) => a + r.failed, 0);
  const errors = Object.values(results).flatMap((r) => r.errors).slice(0, 5);

  revalidatePath("/inventory");
  return { ok: failed === 0, pushed, failed, errors };
}

/** Channel SKUs seen on orders that have no product behind them yet. */
export async function listUnmappedSkus() {
  await requireUser();
  return db
    .select({
      externalSku: orderItems.externalSku,
      title: sql<string>`MAX(${orderItems.title})`,
      channelAccountId: sql<number>`MIN(${orders.channelAccountId})`,
      channel: sql<string>`MIN(${orders.channel}::text)`,
      orderCount: sql<number>`COUNT(*)`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(isNull(orderItems.productId))
    .groupBy(orderItems.externalSku)
    .orderBy(sql`COUNT(*) DESC`)
    .limit(50);
}
