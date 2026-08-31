import { and, eq, inArray, sql } from "drizzle-orm";

import { adapterFor } from "@/channels";
import { db } from "@/db";
import {
  channelAccounts,
  channelListings,
  inventory,
  inventoryLedger,
  products,
} from "@/db/schema";

/**
 * What we are willing to publish to a marketplace: physical stock, minus units
 * already committed to unshipped orders, minus a manual safety buffer. Floored
 * at zero — a negative would be rejected by every channel anyway.
 */
export function sellableQuantity(row: {
  onHand: number;
  reserved: number;
  buffer: number;
}) {
  return Math.max(0, row.onHand - row.reserved - row.buffer);
}

export interface AdjustStockInput {
  productId: number;
  delta: number;
  reason: "manual" | "stock_take" | "return_received" | "order_packed";
  note?: string;
  userId?: number;
  refType?: string;
  refId?: number;
}

/**
 * Change stock and record why, in one place. Everything that moves stock goes
 * through here so the ledger is a complete account of how a count got to where
 * it is — which is the only way to settle an argument about a missing unit.
 */
export async function adjustStock(input: AdjustStockInput) {
  await db
    .insert(inventory)
    .values({
      productId: input.productId,
      onHand: Math.max(0, input.delta),
      reserved: 0,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: inventory.productId,
      set: {
        // GREATEST keeps a bad adjustment from driving the count negative,
        // which would then be published as nonsense to every channel.
        onHand: sql`GREATEST(0, ${inventory.onHand} + ${input.delta})`,
        updatedAt: new Date(),
      },
    });

  await db.insert(inventoryLedger).values({
    productId: input.productId,
    delta: input.delta,
    reason: input.reason,
    note: input.note ?? null,
    userId: input.userId ?? null,
    refType: input.refType ?? null,
    refId: input.refId ?? null,
  });
}

/**
 * Publish current sellable stock to every live channel.
 *
 * Only pushes SKUs that actually have a listing on that channel; an unmapped
 * product is reported rather than silently ignored, because a product selling
 * on Meesho with no mapping is exactly how oversells happen.
 */
export async function pushInventoryToChannels(productIds?: number[]) {
  const accounts = await db
    .select()
    .from(channelAccounts)
    .where(eq(channelAccounts.active, true));

  const stockRows = await db
    .select({
      productId: inventory.productId,
      onHand: inventory.onHand,
      reserved: inventory.reserved,
      buffer: inventory.buffer,
      sku: products.sku,
    })
    .from(inventory)
    .innerJoin(products, eq(products.id, inventory.productId))
    .where(productIds?.length ? inArray(inventory.productId, productIds) : undefined);

  const stockByProduct = new Map(stockRows.map((r) => [r.productId, r]));
  const results: Record<string, { pushed: number; failed: number; errors: string[] }> = {};

  for (const account of accounts) {
    const adapter = adapterFor(account);
    if (!adapter.supportsInventoryPush) continue;

    const listings = await db
      .select()
      .from(channelListings)
      .where(
        and(
          eq(channelListings.channelAccountId, account.id),
          eq(channelListings.active, true),
          productIds?.length ? inArray(channelListings.productId, productIds) : undefined,
        ),
      );

    const updates = listings
      .map((l) => {
        const stock = stockByProduct.get(l.productId);
        if (!stock) return null;
        return { externalSku: l.externalSku, quantity: sellableQuantity(stock) };
      })
      .filter((u): u is { externalSku: string; quantity: number } => u !== null);

    const key = `${account.channel}:${account.id}`;
    if (updates.length === 0) {
      results[key] = { pushed: 0, failed: 0, errors: [] };
      continue;
    }

    try {
      const res = await adapter.pushInventory(updates);
      results[key] = {
        pushed: res.filter((r) => r.ok).length,
        failed: res.filter((r) => !r.ok).length,
        errors: res.filter((r) => !r.ok).map((r) => `${r.externalSku}: ${r.error}`),
      };
    } catch (err) {
      results[key] = {
        pushed: 0,
        failed: updates.length,
        errors: [err instanceof Error ? err.message : String(err)],
      };
    }
  }

  return results;
}
