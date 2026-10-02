import "server-only";

import { Type } from "@paribelle/pi-ai";
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import { adapterFor } from "@/channels";
import { AmazonAdapter, type AmazonListing } from "@/channels/amazon";
import { db } from "@/db";
import {
  channelAccounts,
  channelListings,
  inventory,
  inventoryLedger,
  orderItems,
  orders,
  products,
  users,
  type ChannelAccount,
} from "@/db/schema";
import { FEATURES } from "@/config/features";
import { linkCatalogue } from "@/lib/catalogue";
import { freezeOrderCosts, productFamilyKey } from "@/lib/finance-queries";
import { adjustStock, pushInventoryToChannels, sellableQuantity } from "@/lib/inventory";
import { recomputeReserved } from "@/lib/sync";
import { getRestockPlan, markRestockInStock, resetRestockPlan, updateRestockItems } from "@/app/(app)/orders/planner-actions";

import { defineTool, ToolError } from "./types";
import { accountsFor, ist, listRefs, num, plural, StringEnum } from "./util";

/** A product as people say it: our id, or a SKU (ours or a marketplace's). */
const ProductRef = Type.Union([Type.Integer(), Type.String()], { description: "Product id, or a SKU (ours or the marketplace's)." });

async function resolveProducts(refs: (number | string)[]) {
  const ids = refs.filter((r): r is number => typeof r === "number");
  const skus = refs.filter((r): r is string => typeof r === "string").map((s) => s.trim());
  const rows = await db
    .select({ id: products.id, sku: products.sku, externalSku: channelListings.externalSku })
    .from(products)
    .leftJoin(channelListings, eq(channelListings.productId, products.id))
    .where(
      or(
        ids.length ? inArray(products.id, ids) : undefined,
        skus.length ? inArray(products.sku, skus) : undefined,
        skus.length ? inArray(channelListings.externalSku, skus) : undefined,
      ),
    );
  const byRef = new Map<string | number, number>();
  for (const r of rows) {
    byRef.set(r.id, r.id);
    byRef.set(r.sku, r.id);
    if (r.externalSku) byRef.set(r.externalSku, r.id);
  }
  const missing = refs.filter((r) => !byRef.has(r)).map(String);
  return { ids: [...new Set(refs.map((r) => byRef.get(r)).filter((x): x is number => x !== undefined))], byRef, missing };
}

/* -------------------------------------------------------------------------- */
/* products                                                                   */
/* -------------------------------------------------------------------------- */

export const productsTool = defineTool({
  name: "products",
  label: "Products and stock",
  description: [
    "The OMS's own catalogue: products (one per seller SKU) with stock (on hand, reserved by open orders, buffer, sellable),",
    "cost price, bin, weight, HSN, image, their marketplace listings (SKU, ASIN) and units sold in the last 30 days.",
    "Search by text (SKU, name, ASIN) or filter: noCost, lowStock (sellable at or under N), inactive. `history` adds each product's stock ledger.",
    "`unmappedSkus: true` instead lists marketplace SKUs on orders that have no product here yet.",
  ].join(" "),
  parameters: Type.Object({
    query: Type.Optional(Type.String()),
    ids: Type.Optional(Type.Array(ProductRef, { maxItems: 200 })),
    noCost: Type.Optional(Type.Boolean()),
    lowStock: Type.Optional(Type.Integer({ minimum: 0 })),
    inactive: Type.Optional(Type.Boolean()),
    unmappedSkus: Type.Optional(Type.Boolean()),
    history: Type.Optional(Type.Boolean({ description: "Each product's last 20 stock movements." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Default 50." })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  kind: "read",
  summary: (a) =>
    a.unmappedSkus
      ? "Unmapped marketplace SKUs"
      : [a.query && `"${a.query}"`, a.ids && listRefs(a.ids), a.noCost && "no cost", a.lowStock !== undefined && `sellable ≤ ${a.lowStock}`, a.inactive && "inactive"]
          .filter(Boolean)
          .join(" · ") || "All products",
  async execute(a) {
    if (a.unmappedSkus) {
      const rows = await db
        .select({
          sku: orderItems.externalSku,
          title: sql<string>`MAX(${orderItems.title})`,
          asin: sql<string | null>`MAX(${orderItems.externalAsin})`,
          accountId: sql<number>`MIN(${orders.channelAccountId})`,
          orders: sql<number>`COUNT(DISTINCT ${orders.id})::int`,
          lastOrdered: sql<Date>`MAX(${orders.orderedAt})`,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(isNull(orderItems.productId))
        .groupBy(orderItems.externalSku)
        .orderBy(sql`COUNT(*) DESC`)
        .limit(a.limit ?? 200);
      return { data: { count: rows.length, skus: rows.map((r) => ({ ...r, lastOrdered: ist(r.lastOrdered) })) } };
    }

    const filters: SQL[] = [];
    if (a.ids?.length) {
      const { ids, missing } = await resolveProducts(a.ids);
      if (ids.length === 0) throw new ToolError(`No such product: ${missing.join(", ")}.`);
      filters.push(inArray(products.id, ids));
    }
    const q = a.query?.trim();
    if (q) {
      const like = `%${q}%`;
      filters.push(
        or(
          ilike(products.sku, like),
          ilike(products.name, like),
          sql`EXISTS (SELECT 1 FROM channel_listings cl WHERE cl.product_id = ${products.id} AND (cl.external_sku ILIKE ${like} OR cl.external_id ILIKE ${like}))`,
        )!,
      );
    }
    if (a.noCost) filters.push(isNull(products.costPrice));
    if (a.inactive !== undefined) filters.push(eq(products.active, !a.inactive));
    if (a.lowStock !== undefined) {
      filters.push(sql`GREATEST(0, COALESCE(${inventory.onHand},0) - COALESCE(${inventory.reserved},0) - COALESCE(${inventory.buffer},0)) <= ${a.lowStock}`);
    }
    const where = filters.length ? and(...filters) : undefined;
    const limit = a.limit ?? 50;
    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: products.id,
          sku: products.sku,
          name: products.name,
          cost: products.costPrice,
          bin: products.binLocation,
          weight: products.weightGrams,
          hsn: products.hsnCode,
          active: products.active,
          image: products.imageUrl,
          onHand: inventory.onHand,
          reserved: inventory.reserved,
          buffer: inventory.buffer,
          sold30: sql<number>`(SELECT COALESCE(SUM(oi.quantity),0)::int FROM order_items oi JOIN orders o ON o.id = oi.order_id
                   WHERE oi.product_id = ${products.id} AND oi.cancelled = false AND o.ordered_at >= now() - interval '30 days')`,
        })
        .from(products)
        .leftJoin(inventory, eq(inventory.productId, products.id))
        .where(where)
        .orderBy(products.sku)
        .limit(limit)
        .offset(a.offset ?? 0),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(products)
        .leftJoin(inventory, eq(inventory.productId, products.id))
        .where(where),
    ]);
    const ids = rows.map((r) => r.id);
    const [listings, ledger] = await Promise.all([
      ids.length
        ? db
            .select({
              productId: channelListings.productId,
              account: channelAccounts.label,
              channel: channelAccounts.channel,
              sku: channelListings.externalSku,
              asin: channelListings.externalId,
              active: channelListings.active,
            })
            .from(channelListings)
            .innerJoin(channelAccounts, eq(channelAccounts.id, channelListings.channelAccountId))
            .where(inArray(channelListings.productId, ids))
        : [],
      a.history && ids.length
        ? db
            .select({
              productId: inventoryLedger.productId,
              delta: inventoryLedger.delta,
              reason: inventoryLedger.reason,
              note: inventoryLedger.note,
              by: users.name,
              at: inventoryLedger.createdAt,
            })
            .from(inventoryLedger)
            .leftJoin(users, eq(users.id, inventoryLedger.userId))
            .where(inArray(inventoryLedger.productId, ids))
            .orderBy(desc(inventoryLedger.createdAt))
            .limit(20 * ids.length)
        : [],
    ]);
    return {
      data: {
        total,
        shown: rows.length,
        products: rows.map((r) => {
          const stock = { onHand: r.onHand ?? 0, reserved: r.reserved ?? 0, buffer: r.buffer ?? 0 };
          return {
            id: r.id,
            sku: r.sku,
            name: r.name,
            stock: { ...stock, sellable: sellableQuantity(stock) },
            sold30: r.sold30,
            cost: num(r.cost),
            bin: r.bin,
            weightGrams: r.weight,
            hsn: r.hsn,
            active: r.active,
            image: r.image,
            listings: listings.filter((l) => l.productId === r.id).map(({ productId: _, ...l }) => l),
            ...(a.history
              ? { history: ledger.filter((l) => l.productId === r.id).slice(0, 20).map((l) => ({ delta: l.delta, reason: l.reason, note: l.note, by: l.by, at: ist(l.at) })) }
              : {}),
          };
        }),
      },
    };
  },
});

/* -------------------------------------------------------------------------- */
/* product_update                                                             */
/* -------------------------------------------------------------------------- */

export const productUpdate = defineTool({
  name: "product_update",
  label: "Edit products",
  description: [
    "Edit OMS products (not paribelle.in, not Amazon): name, cost price, bin location, weight, HSN, image URL, active.",
    "Cost price is what one unit costs us and drives profit: with `wholeFamily` it goes on every size and colour of that design, like the Finance ledger does.",
    "Orders already costed keep the cost they were costed at. Each change names its product by id or SKU.",
  ].join(" "),
  parameters: Type.Object({
    changes: Type.Array(
      Type.Object({
        product: ProductRef,
        name: Type.Optional(Type.String()),
        costPrice: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()], { description: "Rupees per unit; null clears it." })),
        wholeFamily: Type.Optional(Type.Boolean({ description: "Apply costPrice to every size and colour of this design." })),
        binLocation: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        weightGrams: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
        hsnCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        imageUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        active: Type.Optional(Type.Boolean()),
      }),
      { minItems: 1, maxItems: 500 },
    ),
  }),
  kind: "write",
  summary: (a) => {
    const c = a.changes;
    const fields = new Set(c.flatMap((x) => Object.keys(x).filter((k) => k !== "product" && k !== "wholeFamily")));
    const first = c[0];
    const cost = c.length === 1 && first.costPrice !== undefined ? ` (cost ${first.costPrice === null ? "cleared" : `₹${first.costPrice}`}${first.wholeFamily ? ", whole design" : ""})` : "";
    return `${plural(c.length, "product")}: ${[...fields].join(", ")}${cost} — ${listRefs(c.map((x) => x.product))}`;
  },
  async execute(a) {
    const { byRef, missing } = await resolveProducts(a.changes.map((c) => c.product));
    if (missing.length) throw new ToolError(`No such product: ${missing.join(", ")}. Nothing was changed.`);
    const touchesCost = a.changes.some((c) => c.costPrice !== undefined);
    if (touchesCost) await freezeOrderCosts();
    let families: { id: number; name: string }[] | null = null;
    const updated = new Set<number>();
    for (const c of a.changes) {
      const id = byRef.get(c.product)!;
      const set: Partial<typeof products.$inferInsert> = {};
      if (c.name !== undefined) set.name = c.name.trim();
      if (c.binLocation !== undefined) set.binLocation = c.binLocation?.trim() || null;
      if (c.weightGrams !== undefined) set.weightGrams = c.weightGrams;
      if (c.hsnCode !== undefined) set.hsnCode = c.hsnCode?.trim() || null;
      if (c.imageUrl !== undefined) set.imageUrl = c.imageUrl?.trim() || null;
      if (c.active !== undefined) set.active = c.active;
      if (c.costPrice !== undefined && !c.wholeFamily) set.costPrice = c.costPrice === null ? null : c.costPrice.toFixed(2);
      if (Object.keys(set).length) {
        await db.update(products).set(set).where(eq(products.id, id));
        updated.add(id);
      }
      if (c.costPrice !== undefined && c.wholeFamily) {
        families ??= await db.select({ id: products.id, name: products.name }).from(products);
        const [self] = await db.select({ name: products.name }).from(products).where(eq(products.id, id));
        const key = productFamilyKey(self.name);
        const ids = families.filter((p) => productFamilyKey(p.name) === key).map((p) => p.id);
        await db
          .update(products)
          .set({ costPrice: c.costPrice === null ? null : c.costPrice.toFixed(2) })
          .where(inArray(products.id, ids));
        for (const x of ids) updated.add(x);
      }
    }
    if (touchesCost) await freezeOrderCosts();
    return { text: `${plural(updated.size, "product")} updated.` };
  },
});

/* -------------------------------------------------------------------------- */
/* inventory                                                                  */
/* -------------------------------------------------------------------------- */

export const inventoryTool = defineTool({
  name: "inventory",
  label: "Change stock",
  description: [
    "Change OMS stock (the count here, not on Amazon). set: the counted on-hand figure (a stock take); adjust: add or take away units;",
    "buffer: units held back from what's published to marketplaces; map_sku: create a product for a marketplace SKU seen on orders",
    "(with optional name, our SKU, bin and opening stock) and link its orders. Every movement is written to the stock ledger with the note.",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["set", "adjust", "buffer", "map_sku"]),
    items: Type.Array(
      Type.Object({
        product: Type.Optional(ProductRef),
        count: Type.Optional(Type.Integer({ description: "set: the new on-hand; adjust: + or − units; buffer: units held back." })),
        externalSku: Type.Optional(Type.String({ description: "map_sku: the marketplace SKU." })),
        channelAccountId: Type.Optional(Type.Integer()),
        name: Type.Optional(Type.String()),
        ourSku: Type.Optional(Type.String()),
        binLocation: Type.Optional(Type.String()),
        openingStock: Type.Optional(Type.Integer({ minimum: 0 })),
      }),
      { minItems: 1, maxItems: 500 },
    ),
    note: Type.Optional(Type.String()),
  }),
  kind: "write",
  enabled: () => FEATURES.inventoryManagement,
  summary: (a) =>
    a.action === "map_sku"
      ? `Create products for ${listRefs(a.items.map((i) => i.externalSku ?? "?"))}`
      : `${{ set: "Set stock", adjust: "Adjust stock", buffer: "Set buffer" }[a.action]}: ${a.items
          .slice(0, 4)
          .map((i) => `${i.product} → ${a.action === "adjust" && (i.count ?? 0) > 0 ? "+" : ""}${i.count}`)
          .join(", ")}${a.items.length > 4 ? ` +${a.items.length - 4} more` : ""}`,
  async execute(a, ctx) {
    if (a.action === "map_sku") {
      const created: { externalSku: string; productId: number }[] = [];
      for (const item of a.items) {
        if (!item.externalSku) throw new ToolError("map_sku needs externalSku on every item.");
        let accountId = item.channelAccountId;
        if (!accountId) {
          const [seen] = await db
            .select({ accountId: orders.channelAccountId })
            .from(orderItems)
            .innerJoin(orders, eq(orders.id, orderItems.orderId))
            .where(eq(orderItems.externalSku, item.externalSku))
            .limit(1);
          accountId = seen?.accountId;
        }
        if (!accountId) throw new ToolError(`Which account sells ${item.externalSku}? Give channelAccountId.`);
        const sku = (item.ourSku?.trim() || item.externalSku).trim();
        const [title] = await db.select({ title: orderItems.title }).from(orderItems).where(eq(orderItems.externalSku, item.externalSku)).limit(1);
        const name = item.name?.trim() || title?.title || sku;
        const [product] = await db
          .insert(products)
          .values({ sku, name, binLocation: item.binLocation?.trim() || null })
          .onConflictDoUpdate({ target: products.sku, set: { name } })
          .returning({ id: products.id });
        await db.insert(inventory).values({ productId: product.id, onHand: 0 }).onConflictDoNothing();
        await db
          .insert(channelListings)
          .values({ productId: product.id, channelAccountId: accountId, externalSku: item.externalSku })
          .onConflictDoUpdate({ target: [channelListings.channelAccountId, channelListings.externalSku], set: { productId: product.id, active: true } });
        await db
          .update(orderItems)
          .set({ productId: product.id })
          .where(and(eq(orderItems.externalSku, item.externalSku), isNull(orderItems.productId)));
        if (item.openingStock) {
          await adjustStock({ productId: product.id, delta: item.openingStock, reason: "manual", note: a.note ?? "Opening stock at mapping", userId: ctx.user.id });
        }
        created.push({ externalSku: item.externalSku, productId: product.id });
      }
      await recomputeReserved();
      return { data: { mapped: created } };
    }

    const { byRef, missing } = await resolveProducts(a.items.map((i) => i.product ?? -1));
    if (missing.length) throw new ToolError(`No such product: ${missing.join(", ")}. Nothing was changed.`);
    const results: { product: string | number; before?: number; after?: number }[] = [];
    for (const item of a.items) {
      if (item.count === undefined) throw new ToolError("Every item needs a count.");
      const productId = byRef.get(item.product!)!;
      const [current] = await db.select().from(inventory).where(eq(inventory.productId, productId));
      if (a.action === "buffer") {
        await db
          .insert(inventory)
          .values({ productId, buffer: Math.max(0, item.count) })
          .onConflictDoUpdate({ target: inventory.productId, set: { buffer: Math.max(0, item.count), updatedAt: new Date() } });
        results.push({ product: item.product!, before: current?.buffer ?? 0, after: Math.max(0, item.count) });
        continue;
      }
      const before = current?.onHand ?? 0;
      const delta = a.action === "set" ? item.count - before : item.count;
      if (delta !== 0) {
        await adjustStock({
          productId,
          delta,
          reason: a.action === "set" ? "stock_take" : "manual",
          note: a.note ?? (a.action === "set" ? "Counted (Seelie)" : "Adjusted (Seelie)"),
          userId: ctx.user.id,
        });
      }
      results.push({ product: item.product!, before, after: Math.max(0, before + delta) });
    }
    return { data: { [a.action === "buffer" ? "buffers" : "onHand"]: results } };
  },
});

export const pushStock = defineTool({
  name: "push_stock",
  label: "Push stock to marketplaces",
  description:
    "Publish sellable stock (on hand − reserved − buffer) to every live marketplace listing, for the products named or all of them. This CHANGES what Amazon shows as available.",
  parameters: Type.Object({ products: Type.Optional(Type.Array(ProductRef, { maxItems: 1000, description: "Omit for every product." })) }),
  kind: "market",
  enabled: () => FEATURES.inventoryManagement,
  summary: (a) => (a.products?.length ? `Publish stock for ${listRefs(a.products)}` : "Publish stock for EVERY product"),
  async execute(a) {
    let ids: number[] | undefined;
    if (a.products?.length) {
      const res = await resolveProducts(a.products);
      if (res.missing.length) throw new ToolError(`No such product: ${res.missing.join(", ")}.`);
      ids = res.ids;
    }
    return { data: await pushInventoryToChannels(ids) };
  },
});

/* -------------------------------------------------------------------------- */
/* restock_plan                                                               */
/* -------------------------------------------------------------------------- */

export const restockPlan = defineTool({
  name: "restock_plan",
  label: "Restock planner",
  description: [
    "The restock planner (what to buy for open orders): one entry per design with a size × colour grid of needed / have / buy.",
    "view: the plan (largest buys first); rebuild: start it over from the current open orders (loses edits);",
    "update: change cells by id (have, buyOverride or null, excluded); mark_in_stock: cells we have enough of (have = needed).",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["view", "rebuild", "update", "mark_in_stock"]),
    cellIds: Type.Optional(Type.Array(Type.Integer())),
    have: Type.Optional(Type.Integer({ minimum: 0 })),
    buyOverride: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
    excluded: Type.Optional(Type.Boolean()),
    onlyToBuy: Type.Optional(Type.Boolean({ description: "view: only designs with something to buy." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  }),
  kind: (a) => (a.action === "view" ? "read" : "write"),
  summary: (a) =>
    a.action === "view"
      ? "The plan"
      : a.action === "rebuild"
        ? "Rebuild the plan from open orders (edits are lost)"
        : `${a.action === "update" ? "Update" : "Mark in stock"}: ${plural(a.cellIds?.length ?? 0, "cell")}`,
  async execute(a) {
    if (a.action === "update" || a.action === "mark_in_stock") {
      if (!a.cellIds?.length) throw new ToolError("Name the cells (cellIds from view).");
      if (a.action === "update") {
        await updateRestockItems(a.cellIds, { have: a.have, buyOverride: a.buyOverride, excluded: a.excluded });
      } else {
        await markRestockInStock(a.cellIds);
      }
    }
    const plan = a.action === "rebuild" ? await resetRestockPlan() : await getRestockPlan();
    const list = plan.products.filter((p) => !a.onlyToBuy || p.buy > 0).slice(0, a.limit ?? 80);
    return {
      data: {
        generated: ist(plan.generatedAt),
        totals: plan.totals,
        designs: list.map((p) => ({
          design: p.label,
          asin: p.asin,
          needed: p.needed,
          have: p.have,
          buy: p.buy,
          cells: p.cells.map((c) => ({
            id: c.id,
            size: c.size || null,
            colour: c.color || null,
            needed: c.needed,
            have: c.have,
            buy: c.buy,
            ...(c.buyOverride !== null ? { override: c.buyOverride } : {}),
            ...(c.excluded ? { excluded: true } : {}),
          })),
        })),
      },
    };
  },
});

/* -------------------------------------------------------------------------- */
/* Amazon catalogue                                                           */
/* -------------------------------------------------------------------------- */

export function amazonAdapter(account: ChannelAccount): AmazonAdapter {
  const adapter = adapterFor(account);
  if (!(adapter instanceof AmazonAdapter)) throw new ToolError(`Account ${account.id} isn't Amazon.`);
  return adapter;
}

export async function amazonAccount(accountId?: number) {
  const accounts = (await accountsFor(accountId)).filter((a) => a.channel === "amazon");
  if (accounts.length === 0) throw new ToolError("No Amazon account is connected.");
  return accounts[0];
}

/** The listings report takes minutes to build; one per account is kept for a while. */
const listingCache = new Map<number, { at: number; listings: AmazonListing[] }>();
const LISTING_TTL_MS = 15 * 60_000;

async function listingsOf(account: ChannelAccount, fresh: boolean, progress: (t: string) => void) {
  const cached = listingCache.get(account.id);
  if (!fresh && cached && Date.now() - cached.at < LISTING_TTL_MS) return { listings: cached.listings, at: cached.at };
  progress("Asking Amazon for the listings report (this takes a minute or two)…");
  const listings = await amazonAdapter(account).fetchListings();
  listingCache.set(account.id, { at: Date.now(), listings });
  return { listings, at: Date.now() };
}

export const amazonListings = defineTool({
  name: "amazon_listings",
  label: "Amazon listings",
  description: [
    "Read the Amazon account's live catalogue (the All Listings report: every seller SKU with ASIN, title, price, quantity Amazon holds, status)",
    "and compare it with the OMS: `newOnly` shows listings the OMS has no product for yet (new on Amazon), `missingOnAmazon` OMS products",
    "with no live listing. Reading only; it changes nothing. The report is kept for 15 minutes; `fresh` asks Amazon again.",
    "To bring new listings into the OMS, follow with catalogue_link.",
  ].join(" "),
  parameters: Type.Object({
    accountId: Type.Optional(Type.Integer()),
    query: Type.Optional(Type.String({ description: "Filter by SKU, ASIN or title." })),
    newOnly: Type.Optional(Type.Boolean()),
    missingOnAmazon: Type.Optional(Type.Boolean()),
    status: Type.Optional(Type.String({ description: "Active or Inactive." })),
    fresh: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, description: "Default 100." })),
  }),
  kind: "read",
  summary: (a) => [a.newOnly && "new on Amazon", a.missingOnAmazon && "missing on Amazon", a.query && `"${a.query}"`].filter(Boolean).join(" · ") || "The live catalogue",
  async execute(a, ctx) {
    const account = await amazonAccount(a.accountId);
    const { listings, at } = await listingsOf(account, a.fresh ?? false, ctx.progress);
    const linked = await db
      .select({ sku: channelListings.externalSku, productId: channelListings.productId })
      .from(channelListings)
      .where(eq(channelListings.channelAccountId, account.id));
    const known = new Map(linked.map((l) => [l.sku, l.productId]));

    if (a.missingOnAmazon) {
      const live = new Set(listings.map((l) => l.externalSku));
      const gone = linked.filter((l) => !live.has(l.sku));
      return { data: { reportAt: ist(new Date(at)), count: gone.length, skus: gone.slice(0, a.limit ?? 100) } };
    }

    const q = a.query?.trim().toLowerCase();
    const rows = listings.filter(
      (l) =>
        (!a.newOnly || !known.has(l.externalSku)) &&
        (!a.status || l.status?.toLowerCase() === a.status.toLowerCase()) &&
        (!q || [l.externalSku, l.asin, l.title].some((v) => v?.toLowerCase().includes(q))),
    );
    return {
      data: {
        reportAt: ist(new Date(at)),
        totalListings: listings.length,
        notInOms: listings.filter((l) => !known.has(l.externalSku)).length,
        ...(a.query || a.newOnly || a.status ? { matchingFilters: rows.length } : {}),
        listings: rows.slice(0, a.limit ?? 100).map((l) => ({ ...l, inOms: known.has(l.externalSku) })),
      },
    };
  },
});

export const catalogueLink = defineTool({
  name: "catalogue_link",
  label: "Map the Amazon catalogue",
  description: [
    "Bring the Amazon catalogue into the OMS: reads the listings report and every SKU ever sold, creates a product for each new SKU",
    "(seller SKU = our SKU, Amazon's title), links listings, seeds stock rows from Amazon's quantity (never overwriting a count),",
    "fetches missing product photos, and links every old order line to its product. Safe to repeat; never touches cost, bin, weight or active.",
    "This is how 'new items on Amazon, map them here' is done.",
  ].join(" "),
  parameters: Type.Object({ accountId: Type.Optional(Type.Integer()) }),
  kind: "write",
  summary: () => "Create products for new Amazon listings and link orders to them",
  async execute(a, ctx) {
    const account = await amazonAccount(a.accountId);
    const result = await linkCatalogue(account, { onProgress: (step) => ctx.progress(step) });
    listingCache.delete(account.id);
    return { data: result };
  },
});

export const amazonApi = defineTool({
  name: "amazon_api",
  label: "Amazon SP-API",
  description: [
    "Call any Amazon Selling Partner API operation as the connected seller account, for what no other tool covers:",
    "catalog items (/catalog/2022-04-01/items/{asin}?marketplaceIds=…&includedData=attributes,images,summaries,relationships),",
    "a listing (/listings/2021-08-01/items/{sellerId}/{sku}?marketplaceIds=…&includedData=summaries,attributes,issues,offers,fulfillmentAvailability),",
    "pricing, fees estimates, reports, notifications. {marketplaceId} and {sellerId} in the path or query are filled in.",
    "GET only reads. Any other method CHANGES Amazon (prices, listings, stock) and always asks first; prefer a PATCH with a narrow",
    "JSON Patch, and read the listing first so the change is exact.",
  ].join(" "),
  parameters: Type.Object({
    method: StringEnum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: Type.String({ description: "e.g. /catalog/2022-04-01/items/B0ABC12345" }),
    query: Type.Optional(Type.Record(Type.String(), Type.String())),
    body: Type.Optional(Type.Unknown()),
    accountId: Type.Optional(Type.Integer()),
  }),
  kind: (a) => (a.method === "GET" ? "read" : "market"),
  ownerOnly: true,
  summary: (a) => `${a.method} ${a.path}${a.body !== undefined ? ` ${JSON.stringify(a.body).slice(0, 200)}` : ""}`,
  async execute(a) {
    if (!a.path.startsWith("/") || a.path.includes("..")) throw new ToolError("The path starts with / (e.g. /catalog/2022-04-01/items/…).");
    const account = await amazonAccount(a.accountId);
    const adapter = amazonAdapter(account);
    const fill = (s: string) => {
      let out = s.replaceAll("{marketplaceId}", adapter.marketplace);
      if (out.includes("{sellerId}")) {
        if (!adapter.sellerId) throw new ToolError("This account has no seller id saved, so {sellerId} can't be filled.");
        out = out.replaceAll("{sellerId}", adapter.sellerId);
      }
      return out;
    };
    const query = Object.fromEntries(Object.entries(a.query ?? {}).map(([k, v]) => [k, fill(v)]));
    try {
      return { data: await adapter.call(a.method, fill(a.path), { query, body: a.body }) };
    } catch (err) {
      const e = err as { message?: string; body?: string };
      throw new ToolError(`${e.message ?? String(err)}${e.body ? `: ${e.body.slice(0, 2000)}` : ""}`);
    }
  },
});
