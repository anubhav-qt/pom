import "server-only";

import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import {
  labelSender,
  paribelleCall,
  paribelleExchanges,
  paribelleLabel,
  paribelleOrders,
  paribelleProducts,
  titleOf,
  toCanonical,
  toReturn,
  type ParibelleOrder,
  type ParibelleRaw,
} from "@/channels/paribelle";
import { db } from "@/db";
import {
  channelAccounts,
  channelListings,
  inventory,
  orderFulfilment,
  orderItems,
  orders,
  products,
  returns,
  type ChannelAccount,
} from "@/db/schema";
import { storeApiUrl } from "@/lib/seelie/store";

import { markManifestedLocal } from "./fulfilment";
import { adjustStock } from "./inventory";
import { ingestOrders, ingestReturns, recomputeReserved } from "./sync";

/**
 * paribelle.in in the OMS beyond the sync itself: its catalogue joined to the
 * OMS's products, and the OMS's screens writing back to the store (an order
 * confirmed, shipped with its AWB, delivered, cancelled or refused at the door;
 * an exchange approved, inspected, replaced or settled). Every change is made
 * on paribelle.in first and the store's answer is then ingested, so the OMS
 * never shows a state the store doesn't have.
 */

/* -------------------------------------------------------------------------- */
/* The catalogue                                                              */
/* -------------------------------------------------------------------------- */

export interface ParibelleLinkResult {
  storeSkus: number;
  productsCreated: number;
  listingsLinked: number;
  inventoryRowsCreated: number;
  orderItemsLinked: number;
}

const isVideo = (url: string) => /\.(mp4|mov|webm)(\?|#|$)/i.test(url) || /\/video\/upload\//.test(url);

/** A store image as a full URL (the store keeps some as paths on its API's host). */
function imageUrl(path: string | null | undefined): string | null {
  if (!path || isVideo(path)) return null;
  if (/^https?:\/\//.test(path)) return path;
  const api = storeApiUrl();
  return api ? `${new URL(api).origin}${path.startsWith("/") ? "" : "/"}${path}` : null;
}

/**
 * Join paribelle.in's SKUs to the OMS's products. A SKU the OMS already stocks
 * (the same piece sold on Amazon, matched on the SKU whatever its case) shares
 * that product and its stock; a new one becomes a product of its own, its stock
 * row seeded from the store's count plus what's sold and not yet shipped (the
 * store has already taken those off). Existing counts are never touched.
 */
export async function linkParibelleCatalogue(account: ChannelAccount): Promise<ParibelleLinkResult> {
  type Entry = { externalId: string | null; name: string; image: string | null; stock: number | null };
  const all = new Map<string, Entry>();

  // Sold SKUs first (a piece since taken down still has orders), then the live catalogue over them.
  const sold = await db
    .select({ sku: orderItems.externalSku, title: sql<string | null>`max(${orderItems.title})` })
    .from(orderItems)
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(eq(orders.channelAccountId, account.id))
    .groupBy(orderItems.externalSku);
  for (const s of sold) all.set(s.sku, { externalId: null, name: s.title ?? s.sku, image: null, stock: null });

  for (const p of await paribelleProducts()) {
    const cover = imageUrl(p.featuredImage) ?? imageUrl(p.images?.find((u) => !isVideo(u)));
    const variants = p.productVariants ?? [];
    for (const v of variants) {
      const sku = v.sku?.trim();
      if (!sku) continue;
      all.set(sku, {
        externalId: v.id,
        name: titleOf(p.name, v.variantAttributes),
        image: imageUrl(v.images?.find((u) => !isVideo(u))) ?? cover,
        stock: v.stockQuantity ?? 0,
      });
    }
    if (!variants.length && p.sku?.trim()) all.set(p.sku.trim(), { externalId: p.id, name: p.name, image: cover, stock: p.stockQuantity ?? 0 });
  }
  if (!all.size) return { storeSkus: 0, productsCreated: 0, listingsLinked: 0, inventoryRowsCreated: 0, orderItemsLinked: 0 };

  // Where each SKU already belongs: this account's listing, a product with that SKU, another channel's listing.
  const own = new Map(
    (await db.select({ sku: channelListings.externalSku, productId: channelListings.productId }).from(channelListings).where(eq(channelListings.channelAccountId, account.id))).map(
      (r) => [r.sku, r.productId] as const,
    ),
  );
  const bySku = new Map((await db.select({ id: products.id, sku: products.sku }).from(products)).map((p) => [p.sku.toLowerCase(), p.id] as const));
  const elsewhere = new Map(
    (
      await db
        .select({ sku: channelListings.externalSku, productId: channelListings.productId })
        .from(channelListings)
        .where(ne(channelListings.channelAccountId, account.id))
    ).map((r) => [r.sku.toLowerCase(), r.productId] as const),
  );

  const productFor = new Map<string, number>();
  const toCreate: { sku: string; name: string; imageUrl: string | null }[] = [];
  for (const [sku, e] of all) {
    const id = own.get(sku) ?? bySku.get(sku.toLowerCase()) ?? elsewhere.get(sku.toLowerCase());
    if (id !== undefined) productFor.set(sku, id);
    else toCreate.push({ sku, name: e.name, imageUrl: e.image });
  }

  let productsCreated = 0;
  for (let i = 0; i < toCreate.length; i += 500) {
    const rows = await db
      .insert(products)
      .values(toCreate.slice(i, i + 500))
      .onConflictDoUpdate({ target: products.sku, set: { imageUrl: sql`COALESCE(${products.imageUrl}, excluded.image_url)` } })
      .returning({ id: products.id, sku: products.sku });
    productsCreated += rows.length;
    for (const r of rows) productFor.set(r.sku, r.id);
  }

  // A matched product without a photo takes the store's.
  const created = new Set(toCreate.map((c) => c.sku));
  for (const [sku, id] of productFor) {
    const image = all.get(sku)?.image;
    if (image && !created.has(sku)) {
      await db.update(products).set({ imageUrl: image }).where(and(eq(products.id, id), isNull(products.imageUrl)));
    }
  }

  const listingRows = [...productFor].map(([sku, productId]) => ({
    productId,
    channelAccountId: account.id,
    externalSku: sku,
    externalId: all.get(sku)?.externalId ?? null,
  }));
  let listingsLinked = 0;
  for (let i = 0; i < listingRows.length; i += 500) {
    const rows = await db
      .insert(channelListings)
      .values(listingRows.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [channelListings.channelAccountId, channelListings.externalSku],
        set: { productId: sql`excluded.product_id`, externalId: sql`COALESCE(excluded.external_id, ${channelListings.externalId})` },
      })
      .returning({ id: channelListings.id });
    listingsLinked += rows.length;
  }

  // Units sold on the store and not yet shipped: the store's count is already down by these.
  const open = new Map(
    (
      await db
        .select({ sku: orderItems.externalSku, qty: sql<number>`sum(${orderItems.quantity})::int` })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(and(eq(orders.channelAccountId, account.id), eq(orderItems.cancelled, false), inArray(orders.status, ["new", "ready_to_pack", "packed"])))
        .groupBy(orderItems.externalSku)
    ).map((r) => [r.sku, r.qty] as const),
  );
  const stockRows = new Map<number, number>();
  for (const [sku, productId] of productFor) {
    const stock = all.get(sku)?.stock;
    if (stock == null) continue;
    stockRows.set(productId, (stockRows.get(productId) ?? 0) + Math.max(0, stock) + (open.get(sku) ?? 0));
  }
  for (const productId of productFor.values()) if (!stockRows.has(productId)) stockRows.set(productId, 0);
  let inventoryRowsCreated = 0;
  const invRows = [...stockRows].map(([productId, onHand]) => ({ productId, onHand }));
  for (let i = 0; i < invRows.length; i += 500) {
    const rows = await db
      .insert(inventory)
      .values(invRows.slice(i, i + 500))
      .onConflictDoNothing({ target: inventory.productId })
      .returning({ productId: inventory.productId });
    inventoryRowsCreated += rows.length;
  }

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
  await recomputeReserved();

  return {
    storeSkus: all.size,
    productsCreated,
    listingsLinked,
    inventoryRowsCreated,
    orderItemsLinked: (linked as unknown as { rowCount?: number }).rowCount ?? 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Orders                                                                     */
/* -------------------------------------------------------------------------- */

export class ParibelleActionError extends Error {}

async function accountOf(id: number | null) {
  const [account] = id ? await db.select().from(channelAccounts).where(eq(channelAccounts.id, id)).limit(1) : [];
  if (!account) throw new ParibelleActionError("This paribelle.in account is no longer in the OMS.");
  return account;
}

/** An OMS order's paribelle.in record, as the last sync kept it. */
async function storeOrderOf(orderId: number) {
  const [row] = await db
    .select({ id: orders.id, channel: orders.channel, accountId: orders.channelAccountId, raw: orders.raw })
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1);
  if (!row) throw new ParibelleActionError("That order isn't in the OMS.");
  if (row.channel !== "paribelle") throw new ParibelleActionError("That isn't a paribelle.in order.");
  const raw = row.raw as ParibelleRaw | null;
  if (!raw?.id) throw new ParibelleActionError("This order has no paribelle.in id yet. Sync paribelle.in and try again.");
  return { raw, account: await accountOf(row.accountId) };
}

/** The store's order after a change: the answer when it is a whole order, else read afresh. */
async function freshOrder(id: string, answer: unknown): Promise<ParibelleOrder | null> {
  const o = answer as Partial<ParibelleOrder> | null;
  if (o && o.id === id && o.orderNumber && o.createdAt && o.updatedAt && Array.isArray(o.items)) return o as ParibelleOrder;
  return (await paribelleOrders()).find((x) => x.id === id) ?? null;
}

export type ParibelleOrderAction =
  | { action: "confirm" }
  | { action: "ship"; courier: string; awb: string }
  | { action: "deliver" }
  | { action: "cancel"; reason: string }
  | { action: "cod_refused"; decision: "credit" | "nothing"; creditAmount?: number; reason?: string };

/**
 * Change a paribelle.in order from the OMS. Shipping sends the courier and AWB to
 * the store (which tells the customer), and hands the parcel over in the OMS too,
 * so it leaves the pack queue and stops holding stock.
 */
export async function actOnParibelleOrder(orderId: number, act: ParibelleOrderAction, userId: number | null) {
  const { raw, account } = await storeOrderOf(orderId);
  const status = (status: string, extra: Record<string, unknown> = {}) =>
    paribelleCall("PATCH", `/orders/${raw.id}/status`, { body: { status, ...extra } });

  let answer: unknown;
  switch (act.action) {
    case "confirm":
      answer = await status("confirmed");
      break;
    case "ship": {
      const awb = act.awb.trim();
      const courier = act.courier.trim();
      if (!awb || !courier) throw new ParibelleActionError("Add the courier and the AWB.");
      answer = await status("shipped", { trackingNumber: awb, carrier: courier });
      break;
    }
    case "deliver":
      answer = await status("delivered");
      break;
    case "cancel":
      if (!act.reason.trim()) throw new ParibelleActionError("Say why it's cancelled; the customer is told.");
      answer = await status("cancelled", { reason: act.reason.trim() });
      break;
    case "cod_refused":
      answer = await paribelleCall("POST", `/orders/${raw.id}/cod-refused`, {
        body: { decision: act.decision, creditAmount: act.decision === "credit" ? act.creditAmount : undefined, reason: act.reason?.trim() || undefined },
      });
      break;
  }

  const fresh = await freshOrder(raw.id, answer);
  if (fresh) await ingestOrders(account, [toCanonical(fresh)]);
  if (act.action === "ship") {
    await takeOffShelf(orderId, userId);
    await markManifestedLocal([orderId], userId);
    await recomputeReserved();
  }
  return fresh;
}

/**
 * A parcel leaving without going through the pack bench takes its pieces off the
 * shelf here, as packing would have (once: a packed order already has).
 */
async function takeOffShelf(orderId: number, userId: number | null) {
  const [f] = await db.select({ state: orderFulfilment.state }).from(orderFulfilment).where(eq(orderFulfilment.orderId, orderId)).limit(1);
  if (f && f.state !== "to_pack") return;
  const items = await db
    .select({ productId: orderItems.productId, quantity: orderItems.quantity })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, orderId), eq(orderItems.cancelled, false)));
  for (const item of items) {
    if (item.productId === null) continue;
    await adjustStock({ productId: item.productId, delta: -item.quantity, reason: "order_packed", refType: "order", refId: orderId, userId: userId ?? undefined, note: "Shipped from paribelle.in's order" });
  }
}

/** A paribelle.in order's shipping label, made here from what the sync kept. */
export async function paribelleLabelFor(orderId: number) {
  const { raw } = await storeOrderOf(orderId);
  return { orderNumber: raw.orderNumber, pdf: await paribelleLabel(raw, await labelSender()) };
}

/* -------------------------------------------------------------------------- */
/* Exchanges                                                                  */
/* -------------------------------------------------------------------------- */

/** The OMS product behind one line of a paribelle.in order. */
async function itemProduct(orderId: number, externalItemId: string | undefined) {
  if (!externalItemId) return null;
  const [item] = await db
    .select({ productId: orderItems.productId })
    .from(orderItems)
    .where(and(eq(orderItems.orderId, orderId), eq(orderItems.externalItemId, externalItemId)))
    .limit(1);
  return item?.productId ?? null;
}

export interface ParibelleReturnRaw {
  id: string;
  returnNumber: string;
  requestType: "return" | "exchange";
  status: string;
  quantity: number;
  product: string;
  sku: string;
  wants: string | null;
  sameProduct: boolean;
  hasReplacement: boolean;
  rejectionReason: string | null;
  inspectionResult: "passed" | "failed" | null;
  replacementTrackingNumber: string | null;
  completedOrderId: string | null;
}

export type ParibelleExchangeAction =
  | { action: "approve" }
  | { action: "reject"; reason: string }
  | { action: "inspection"; result: "passed" | "failed"; notes?: string; restock?: boolean }
  | { action: "ship_replacement"; awb?: string }
  | { action: "create_replacement_order" }
  | { action: "settle_credit" };

/**
 * Move a paribelle.in exchange along from the returns desk. A replacement made
 * as a new order comes into the OMS's orders straight away, ready to pack.
 */
export async function actOnParibelleExchange(returnId: number, act: ParibelleExchangeAction, userId: number | null) {
  const [row] = await db
    .select({ channel: returns.channel, accountId: returns.channelAccountId, orderId: returns.orderId, receivedAt: returns.receivedAt, raw: returns.raw })
    .from(returns)
    .where(eq(returns.id, returnId))
    .limit(1);
  if (!row) throw new ParibelleActionError("That return isn't in the OMS.");
  if (row.channel !== "paribelle") throw new ParibelleActionError("That isn't a paribelle.in exchange.");
  const raw = row.raw as ParibelleReturnRaw | null;
  if (!raw?.id) throw new ParibelleActionError("This exchange has no paribelle.in id yet. Sync paribelle.in and try again.");
  const account = await accountOf(row.accountId);
  const path = `/exchanges/${raw.id}`;

  switch (act.action) {
    case "approve":
      await paribelleCall("POST", `${path}/approve`);
      break;
    case "reject":
      if (!act.reason.trim()) throw new ParibelleActionError("Say why; the customer is told.");
      await paribelleCall("POST", `${path}/reject`, { body: { reason: act.reason.trim() } });
      break;
    case "inspection":
      await paribelleCall("POST", `${path}/inspection`, { body: { result: act.result, notes: act.notes?.trim() || undefined } });
      break;
    case "ship_replacement":
      await paribelleCall("POST", `${path}/ship-replacement`, { body: { trackingNumber: act.awb?.trim() || undefined } });
      break;
    case "create_replacement_order":
      await paribelleCall("POST", `${path}/create-replacement-order`);
      break;
    case "settle_credit":
      await paribelleCall("POST", `${path}/settle-as-credit`);
      break;
  }

  const fresh = (await paribelleExchanges()).find((e) => e.id === raw.id);
  if (fresh) await ingestReturns(account, [toReturn(fresh)]);

  // The OMS's own record of the parcel and the stock it moves.
  if (act.action === "inspection" && !row.receivedAt) {
    const back = act.result === "passed" && act.restock !== false;
    await db
      .update(returns)
      .set({
        receivedAt: new Date(),
        receivedBy: userId,
        restocked: back,
        outcome: act.result === "passed" ? (back ? "reshelved" : "damaged") : null,
        conditionNote: act.notes?.trim() || null,
      })
      .where(eq(returns.id, returnId));
    const productId = back && row.orderId ? await itemProduct(row.orderId, (row.raw as { orderItemId?: string }).orderItemId) : null;
    if (productId) {
      await adjustStock({ productId, delta: raw.quantity, reason: "return_received", refType: "return", refId: returnId, userId: userId ?? undefined, note: `Exchange ${raw.returnNumber} passed inspection` });
    }
  }
  if (act.action === "ship_replacement") {
    const wantsSku = (row.raw as { wantsSku?: string | null }).wantsSku;
    const [listing] = wantsSku
      ? await db
          .select({ productId: channelListings.productId })
          .from(channelListings)
          .where(and(eq(channelListings.channelAccountId, account.id), eq(channelListings.externalSku, wantsSku)))
          .limit(1)
      : [];
    if (listing) {
      await adjustStock({ productId: listing.productId, delta: -raw.quantity, reason: "order_packed", refType: "return", refId: returnId, userId: userId ?? undefined, note: `Replacement for exchange ${raw.returnNumber}` });
    }
  }
  if (act.action === "create_replacement_order") {
    const made = (await paribelleOrders()).filter((o) => o.replacementForExchange?.returnNumber === raw.returnNumber);
    if (made.length) await ingestOrders(account, made.map(toCanonical));
  }
}
