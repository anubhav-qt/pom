import { asc, eq, sql } from "drizzle-orm";

import { redirect } from "next/navigation";

import { db } from "@/db";
import { channelListings, inventory, products } from "@/db/schema";
import { FEATURES } from "@/config/features";
import { requireUser } from "@/lib/auth";

import { listUnmappedSkus } from "./actions";
import { InventoryTable, UnmappedSkus, type StockRow } from "./inventory-table";

export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  await requireUser();
  if (!FEATURES.inventoryManagement) redirect("/orders");

  const rows = await db
    .select({
      productId: products.id,
      sku: products.sku,
      name: products.name,
      binLocation: products.binLocation,
      onHand: sql<number>`COALESCE(${inventory.onHand}, 0)`,
      reserved: sql<number>`COALESCE(${inventory.reserved}, 0)`,
      buffer: sql<number>`COALESCE(${inventory.buffer}, 0)`,
      listingCount: sql<number>`(
        SELECT COUNT(*) FROM ${channelListings}
        WHERE ${channelListings.productId} = ${products.id}
          AND ${channelListings.active} = true
      )`,
    })
    .from(products)
    .leftJoin(inventory, eq(inventory.productId, products.id))
    .where(eq(products.active, true))
    .orderBy(asc(products.sku));

  const unmapped = await listUnmappedSkus();

  const data: StockRow[] = rows.map((r) => ({
    ...r,
    onHand: Number(r.onHand),
    reserved: Number(r.reserved),
    buffer: Number(r.buffer),
    listingCount: Number(r.listingCount),
    sellable: Math.max(0, Number(r.onHand) - Number(r.reserved) - Number(r.buffer)),
  }));

  return (
    <div className="space-y-6">
      {unmapped.length > 0 ? (
        <UnmappedSkus
          rows={unmapped.map((u) => ({
            externalSku: u.externalSku,
            title: u.title,
            channel: u.channel,
            channelAccountId: Number(u.channelAccountId),
            orderCount: Number(u.orderCount),
          }))}
        />
      ) : null}

      <InventoryTable rows={data} />
    </div>
  );
}
