import { eq, isNull, sql } from "drizzle-orm";

import { adapterFor } from "@/channels";
import { AmazonAdapter } from "@/channels/amazon";
import { db } from "@/db";
import {
  catalogImages,
  channelListings,
  inventory,
  orderItems,
  orders,
  products,
  type ChannelAccount,
} from "@/db/schema";

import { recomputeReserved } from "./sync";

export interface LinkCatalogueResult {
  listingsFetched: number;
  soldOnlySkus: number;
  productsCreated: number;
  productsUpdated: number;
  listingsLinked: number;
  inventoryRowsCreated: number;
  productImagesSet: number;
  orderItemsLinked: number;
  stillUnmapped: number;
}

/**
 * Build the product catalogue from a channel account and wire every order line
 * to it.
 *
 * Until this runs `channel_listings` is empty, so `ingestOrders` resolves every
 * SKU to null and every order item shows as "unmapped" — which means inventory
 * reservation reserves nothing, the restock planner plans against nothing, and
 * the pack station cannot verify what it is packing. The data was always there;
 * the join between "what Amazon sold" and "what we stock" was simply never made.
 *
 * Two sources, unioned:
 *
 * - The listings report, authoritative for what exists — including SKUs that
 *   have never sold, and the only place Amazon's own on-hand figure appears.
 * - Distinct SKUs on `order_items`, which catches anything sold and since
 *   delisted. The listings report drops those, and without them the order
 *   history would keep a permanent hole in it.
 *
 * Idempotent. Re-running adopts new listings and leaves hand-edited product
 * fields alone — cost price, weight, bin location and active are ours, not
 * Amazon's, and a re-sync must never flatten them.
 */
export async function linkCatalogue(
  account: ChannelAccount,
  opts: { onProgress?: (step: string) => void } = {},
): Promise<LinkCatalogueResult> {
  const say = (m: string) => opts.onProgress?.(m);

  const adapter = adapterFor(account);
  if (!(adapter instanceof AmazonAdapter)) {
    throw new Error(`linkCatalogue only supports Amazon accounts (got ${account.channel})`);
  }

  say("fetching listings report…");
  const listings = await adapter.fetchListings();
  const listedSkus = new Set(listings.map((l) => l.externalSku));

  // Everything this account has ever sold, with the best title and ASIN seen
  // for it. Amazon rewrites titles over time, so several may exist for one SKU;
  // max() is arbitrary but stable, and any of them is a usable picker label.
  say("reading sold SKUs…");
  const sold = await db
    .select({
      externalSku: orderItems.externalSku,
      asin: sql<string | null>`max(${orderItems.externalAsin})`,
      title: sql<string | null>`max(${orderItems.title})`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(eq(orders.channelAccountId, account.id))
    .groupBy(orderItems.externalSku);

  const merged = new Map<
    string,
    { asin: string | null; title: string | null; quantity: number | null }
  >();
  for (const s of sold) {
    merged.set(s.externalSku, { asin: s.asin, title: s.title, quantity: null });
  }
  // Listings win on title and ASIN — they are the live catalogue — but must
  // never erase a title we only know from order history.
  for (const l of listings) {
    const prev = merged.get(l.externalSku);
    merged.set(l.externalSku, {
      asin: l.asin ?? prev?.asin ?? null,
      title: l.title ?? prev?.title ?? null,
      quantity: l.quantity,
    });
  }
  const soldOnlySkus = sold.filter((s) => !listedSkus.has(s.externalSku)).length;

  // Amazon's catalogue image for the ASIN, where an earlier sync cached one.
  const images = new Map(
    (
      await db
        .select({ asin: catalogImages.asin, imageUrl: catalogImages.imageUrl })
        .from(catalogImages)
        .where(eq(catalogImages.channelAccountId, account.id))
    )
      .filter((r) => r.imageUrl)
      .map((r) => [r.asin, r.imageUrl!] as const),
  );

  const CHUNK = 500;
  const chunks = <T,>(xs: T[]) =>
    Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) =>
      xs.slice(i * CHUNK, (i + 1) * CHUNK),
    );

  const productsBefore = (await db.select({ sku: products.sku }).from(products)).length;

  // The seller SKU is our SKU. There is no internal scheme to map onto yet, and
  // inventing one here would be a guess every later import would have to honour.
  say(`upserting ${merged.size} products…`);
  const productRows = [...merged].map(([sku, m]) => ({
    sku,
    name: m.title ?? sku,
    imageUrl: m.asin ? (images.get(m.asin) ?? null) : null,
  }));

  const upsertedProducts: { id: number; sku: string }[] = [];
  for (const batch of chunks(productRows)) {
    const rows = await db
      .insert(products)
      .values(batch)
      .onConflictDoUpdate({
        target: products.sku,
        set: {
          // Only ever refresh what Amazon owns.
          name: sql`excluded.name`,
          imageUrl: sql`COALESCE(excluded.image_url, ${products.imageUrl})`,
        },
      })
      .returning({ id: products.id, sku: products.sku });
    upsertedProducts.push(...rows);
  }
  const idForSku = new Map(upsertedProducts.map((p) => [p.sku, p.id] as const));

  say("linking channel listings…");
  const listingRows = [...merged]
    .map(([sku, m]) => ({
      productId: idForSku.get(sku),
      channelAccountId: account.id,
      externalSku: sku,
      externalId: m.asin,
    }))
    .filter((r): r is typeof r & { productId: number } => r.productId !== undefined);

  let listingsLinked = 0;
  for (const batch of chunks(listingRows)) {
    const rows = await db
      .insert(channelListings)
      .values(batch)
      .onConflictDoUpdate({
        target: [channelListings.channelAccountId, channelListings.externalSku],
        set: {
          productId: sql`excluded.product_id`,
          externalId: sql`COALESCE(excluded.external_id, ${channelListings.externalId})`,
        },
      })
      .returning({ id: channelListings.id });
    listingsLinked += rows.length;
  }

  // A stock row per product, so the inventory screen has something to edit.
  // Amazon's quantity seeds it but is not truth — it is what Amazon believes is
  // sellable, which is our on-hand minus whatever it has already reserved. An
  // existing count is never overwritten: a stock take beats a marketplace guess.
  say("creating inventory rows…");
  let inventoryRowsCreated = 0;
  const inventoryRows = listingRows.map((r) => ({
    productId: r.productId,
    onHand: Math.max(0, merged.get(r.externalSku)?.quantity ?? 0),
  }));
  for (const batch of chunks(inventoryRows)) {
    const rows = await db
      .insert(inventory)
      .values(batch)
      .onConflictDoNothing({ target: inventory.productId })
      .returning({ productId: inventory.productId });
    inventoryRowsCreated += rows.length;
  }

  // Fetch a catalogue image for every ASIN we still have none for, then give it
  // to the product. `enrichCatalogImages` on the sync path cannot do this job:
  // it is capped at 20 per run so it never slows a sync, and it reaches products
  // through `order_items.external_asin`, so a SKU that is listed but has never
  // sold is invisible to it. Here the ASIN is on the listing itself.
  say("fetching product images…");
  const wantImages = [...new Set(listingRows.map((r) => r.externalId).filter((a): a is string => !!a))];
  const haveImages = new Set(
    (
      await db
        .select({ asin: catalogImages.asin })
        .from(catalogImages)
        .where(eq(catalogImages.channelAccountId, account.id))
    ).map((r) => r.asin),
  );
  const missingImages = wantImages.filter((a) => !haveImages.has(a));

  if (missingImages.length > 0) {
    const found = await adapter.fetchCatalogImages(missingImages);
    // Record every ASIN asked about, image or not, so a later run doesn't ask
    // again about the ones Amazon has nothing for.
    for (const batch of chunks(missingImages)) {
      await db
        .insert(catalogImages)
        .values(
          batch.map((asin) => ({
            channelAccountId: account.id,
            asin,
            imageUrl: found.get(asin) ?? null,
          })),
        )
        .onConflictDoUpdate({
          target: [catalogImages.channelAccountId, catalogImages.asin],
          set: {
            imageUrl: sql`COALESCE(excluded.image_url, ${catalogImages.imageUrl})`,
            fetchedAt: new Date(),
          },
        });
    }
  }

  const imagesSet = await db.execute(sql`
    UPDATE products p
    SET image_url = ci.image_url
    FROM channel_listings cl
    JOIN catalog_images ci
      ON ci.channel_account_id = cl.channel_account_id
     AND ci.asin = cl.external_id
    WHERE cl.product_id = p.id
      AND cl.channel_account_id = ${account.id}
      AND ci.image_url IS NOT NULL
      AND p.image_url IS NULL
  `);

  // Existing order lines were written before any mapping existed, and no sync
  // will revisit them — an unchanged order is flagged `itemsKnownCurrent` and
  // never has its items rewritten. They have to be joined up here or they stay
  // unmapped for good.
  say("back-filling order item mappings…");
  const linked = await db.execute(sql`
    UPDATE order_items oi
    SET product_id = cl.product_id
    FROM channel_listings cl, orders o
    WHERE oi.order_id = o.id
      AND o.channel_account_id = ${account.id}
      AND cl.channel_account_id = ${account.id}
      AND cl.external_sku = oi.external_sku
      AND oi.product_id IS DISTINCT FROM cl.product_id
  `);

  // Reservations have been computing against product_id NULL until now, so
  // every mapped line has to be counted afresh.
  await recomputeReserved();

  const [{ unmapped }] = await db
    .select({ unmapped: sql<number>`count(*)::int` })
    .from(orderItems)
    .where(isNull(orderItems.productId));

  return {
    listingsFetched: listings.length,
    soldOnlySkus,
    productsCreated: idForSku.size - productsBefore,
    productsUpdated: productsBefore,
    listingsLinked,
    inventoryRowsCreated,
    productImagesSet: (imagesSet as unknown as { rowCount?: number }).rowCount ?? 0,
    orderItemsLinked: (linked as unknown as { rowCount?: number }).rowCount ?? 0,
    stillUnmapped: unmapped,
  };
}
