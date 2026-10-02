import "server-only";

import { Type } from "@paribelle/pi-ai";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { channelAccounts, channelListings, inventory, products } from "@/db/schema";
import { parseVariantTitle, sortSizes } from "@/lib/variant-title";

import { STORE_VENDOR_ID, storeApiUrl, storeDocs, StoreError, storeFetch, type StoreMethod } from "../store";
import { fetchImage, toJpeg } from "./images";
import { imageOf } from "./photo";
import { defineTool, ToolError, type ToolContext } from "./types";
import { listRefs, num, plural, StringEnum } from "./util";

/* -------------------------------------------------------------------------- */
/* The API's shapes (what Seelie reads of them)                               */
/* -------------------------------------------------------------------------- */

export interface StoreVariant {
  id: string;
  sku: string;
  variantAttributes: Record<string, string> | null;
  price: string | number | null;
  compareAtPrice: string | number | null;
  stockQuantity: number | null;
  images: string[] | null;
  isActive: boolean;
}

export interface StoreProduct {
  id: string;
  name: string;
  slug: string;
  sku: string;
  status: string;
  description?: string;
  price: string | number;
  compareAtPrice: string | number | null;
  mrp?: string | number | null;
  gstRate?: string | number;
  stockQuantity: number;
  images: string[] | null;
  featuredImage: string | null;
  hasVariants: boolean;
  categories?: { id: string; name: string; slug: string }[];
  productVariants?: StoreVariant[];
}

interface Category {
  id: string;
  name: string;
  slug: string;
  parentId?: string | null;
}

const enabled = () => storeApiUrl() !== null;

/** Store failures reach the model as refusals it can read. */
async function call<T>(method: StoreMethod, path: string, req: Parameters<typeof storeFetch>[2] = {}): Promise<T> {
  try {
    return await storeFetch<T>(method, path, req);
  } catch (err) {
    if (err instanceof StoreError) throw new ToolError(err.message);
    throw err;
  }
}

/** A product video in an images list (video_publish adds them last; the storefront gallery plays them). */
export const isVideoUrl = (url: string) => /\.(mp4|mov|webm)(\?|#|$)/i.test(url) || /\/video\/upload\//.test(url);

export const money = (v: unknown) => (v === null || v === undefined || v === "" ? null : Math.round(Number(v) * 100) / 100);

/** New photos, then the videos the old list had that the new one doesn't. */
function keepVideos(next: string[], before: string[] | null) {
  return [...next, ...(before ?? []).filter((u) => isVideoUrl(u) && !next.includes(u))];
}

function discountOf(price: number | null, mrp: number | null) {
  return price && mrp && mrp > price ? Math.round((1 - price / mrp) * 100) : 0;
}

function variantLine(v: StoreVariant) {
  const price = money(v.price);
  const mrp = money(v.compareAtPrice);
  return {
    id: v.id,
    sku: v.sku,
    ...(v.variantAttributes ?? {}),
    price,
    mrp,
    off: discountOf(price, mrp) || undefined,
    stock: v.stockQuantity ?? 0,
    ...(v.isActive ? {} : { active: false }),
    ...(v.images?.length ? { images: v.images.filter((u) => !isVideoUrl(u)).length } : {}),
    ...(v.images?.some(isVideoUrl) ? { videos: v.images.filter(isVideoUrl).length } : {}),
  };
}

function productLine(p: StoreProduct, detail = false) {
  const price = money(p.price);
  const mrp = money(p.compareAtPrice);
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    url: `https://paribelle.in/products/${p.slug}`,
    code: p.sku,
    status: p.status,
    price,
    mrp,
    off: discountOf(price, mrp) || undefined,
    stock: p.stockQuantity,
    categories: p.categories?.map((c) => c.name),
    image: p.featuredImage ?? p.images?.[0] ?? null,
    ...(detail
      ? { images: (p.images ?? []).filter((u) => !isVideoUrl(u)), description: p.description, gstRate: money(p.gstRate) }
      : { photos: p.images?.filter((u) => !isVideoUrl(u)).length ?? 0 }),
    ...(p.images?.some(isVideoUrl) ? { videos: p.images.filter(isVideoUrl) } : {}),
    variants: p.productVariants?.map(variantLine),
  };
}

export async function getProduct(id: string): Promise<StoreProduct> {
  const ref = id.trim();
  const product = /^[0-9a-f-]{36}$/i.test(ref)
    ? await call<StoreProduct>("GET", `/products/${ref}`)
    : await call<StoreProduct>("GET", `/products/slug/${encodeURIComponent(ref)}`);
  if (!product?.id) throw new ToolError(`No store product ${ref}.`);
  product.productVariants = await call<StoreVariant[]>("GET", `/products/${product.id}/variants`);
  return product;
}

/** Every store product, all statuses, with variants (the store is small; this pages through it). */
async function allProducts(ctx?: ToolContext): Promise<StoreProduct[]> {
  const out: StoreProduct[] = [];
  for (let page = 1; page < 100; page++) {
    ctx?.progress(`Reading paribelle.in's products, page ${page}…`);
    const res = await call<{ products: StoreProduct[]; total: number }>("GET", "/products", {
      query: { vendorId: STORE_VENDOR_ID, status: "all", page, limit: 100 },
    });
    out.push(...res.products);
    if (out.length >= res.total || res.products.length === 0) break;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* store_products                                                             */
/* -------------------------------------------------------------------------- */

export const storeProducts = defineTool({
  name: "store_products",
  label: "paribelle.in products",
  description: [
    "Read paribelle.in's catalogue. With `ids` (product ids or slugs): each product in full with every variant (id, SKU, Colour/Size, price, MRP, discount, stock, active).",
    "Otherwise a page of products: search (name, product code, description), status (active, draft, inactive, out_of_stock, archived, all), stock (low = under 10, out).",
    "price is what the customer pays (GST included); mrp is the struck-through MRP (compareAtPrice); off is the discount %.",
  ].join(" "),
  parameters: Type.Object({
    ids: Type.Optional(Type.Array(Type.String(), { maxItems: 30 })),
    search: Type.Optional(Type.String()),
    status: Type.Optional(Type.String()),
    stock: Type.Optional(StringEnum(["low", "out"])),
    page: Type.Optional(Type.Integer({ minimum: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Default 30." })),
  }),
  kind: "read",
  ownerOnly: true,
  enabled,
  summary: (a) => (a.ids?.length ? listRefs(a.ids, 3) : [a.search && `"${a.search}"`, a.status, a.stock && `${a.stock} stock`].filter(Boolean).join(" · ") || "The catalogue"),
  async execute(a) {
    if (a.ids?.length) {
      const items = [];
      for (const id of a.ids) items.push(productLine(await getProduct(id), true));
      return { data: items };
    }
    const res = await call<{ products: StoreProduct[]; total: number; page: number }>("GET", "/products", {
      query: { vendorId: STORE_VENDOR_ID, status: a.status ?? "all", search: a.search, stock: a.stock, page: a.page ?? 1, limit: a.limit ?? 30 },
    });
    return { data: { total: res.total, page: res.page, products: res.products.map((p) => productLine(p)) } };
  },
});

/* -------------------------------------------------------------------------- */
/* store_update_products                                                      */
/* -------------------------------------------------------------------------- */

const PriceFields = {
  price: Type.Optional(Type.Number({ minimum: 1, description: "Selling price, ₹, GST included." })),
  mrp: Type.Optional(Type.Union([Type.Number({ minimum: 1 }), Type.Null()], { description: "MRP shown struck through (compareAtPrice); null removes it." })),
  discountPercent: Type.Optional(Type.Number({ minimum: 0, maximum: 95, description: "Price = MRP × (1 − d/100), rounded to the rupee. Uses the new MRP if given, else the current one." })),
  stock: Type.Optional(Type.Integer({ minimum: 0 })),
};

const StoreChange = Type.Object({
  id: Type.String({ description: "Product id or slug." }),
  name: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  status: Type.Optional(StringEnum(["active", "draft", "inactive", "out_of_stock", "archived"])),
  ...PriceFields,
  categoryIds: Type.Optional(Type.Array(Type.String())),
  images: Type.Optional(Type.Array(Type.String(), { description: "The full photo list (first is the cover): store URLs, other https URLs, chat:N or asset:N (new ones are uploaded first)." })),
  allVariants: Type.Optional(Type.Object(PriceFields, { description: "Applied to every variant." })),
  variants: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.Optional(Type.String()),
        sku: Type.Optional(Type.String()),
        ...PriceFields,
        active: Type.Optional(Type.Boolean()),
        images: Type.Optional(Type.Array(Type.String())),
      }),
      { description: "Single variants, by id or SKU; these win over allVariants." },
    ),
  ),
});

type Prices = { price?: number; mrp?: number | null; discountPercent?: number; stock?: number };

/** New price, MRP and stock from what's asked and what's there. */
function applyPrices(cur: { price: number | null; mrp: number | null; stock: number }, p: Prices | undefined) {
  if (!p) return cur;
  const mrp = p.mrp !== undefined ? p.mrp : cur.mrp;
  let price = p.price ?? cur.price;
  if (p.discountPercent !== undefined) {
    if (!mrp) throw new ToolError("A discount needs an MRP to take it off.");
    price = Math.round(mrp * (1 - p.discountPercent / 100));
  }
  if (price !== null && mrp !== null && price > mrp) throw new ToolError(`A price of ₹${price} would be above the MRP of ₹${mrp}.`);
  return { price, mrp, stock: p.stock ?? cur.stock };
}

function describePrices(p: Prices | undefined) {
  if (!p) return [];
  return [
    p.mrp !== undefined && (p.mrp === null ? "no MRP" : `MRP ₹${p.mrp}`),
    p.discountPercent !== undefined && `${p.discountPercent}% off`,
    p.price !== undefined && `price ₹${p.price}`,
    p.stock !== undefined && `stock ${p.stock}`,
  ].filter((x): x is string => !!x);
}

export const storeUpdateProducts = defineTool({
  name: "store_update_products",
  label: "Edit paribelle.in products",
  description: [
    "Change products on paribelle.in: name, description, status (active/draft/inactive/out_of_stock/archived), price, MRP, a discount % off the MRP,",
    "stock, categories, photos, and per-variant price/MRP/stock/active/photos (by variant id or SKU, or allVariants for every one). New photos replace the old; product videos (video_publish) stay.",
    "A product with variants shows its lowest variant price and highest MRP; that's kept in step. GST is worked out by the store.",
    "`preview: true` works out and shows the before → after without changing anything (do this first for anything broad). Without it, it always asks.",
  ].join(" "),
  parameters: Type.Object({
    changes: Type.Array(StoreChange, { minItems: 1, maxItems: 200 }),
    preview: Type.Optional(Type.Boolean()),
  }),
  kind: (a) => (a.preview ? "read" : "store"),
  ownerOnly: true,
  enabled,
  summary: (a) => {
    const parts = a.changes.slice(0, 3).map((c) => {
      const what = [
        c.name !== undefined && "name",
        c.description !== undefined && "description",
        c.status && `→ ${c.status}`,
        ...describePrices(c),
        ...describePrices(c.allVariants).map((x) => `all sizes ${x}`),
        c.variants?.length && `${plural(c.variants.length, "variant")}`,
        c.categoryIds && "categories",
        c.images && "photos",
      ].filter(Boolean);
      return `${c.id.slice(0, 12)}: ${what.join(", ")}`;
    });
    return `${a.preview ? "Preview: " : ""}${plural(a.changes.length, "product")} — ${parts.join("; ")}${a.changes.length > 3 ? "; …" : ""}`;
  },
  async execute(a, ctx) {
    const results = [];
    // New photos (URLs, chat:N, asset:N) go on the store's own host first; a preview uploads nothing.
    const photos = a.changes.flatMap((c) => [...(c.images ?? []), ...(c.variants ?? []).flatMap((v) => v.images ?? [])]).filter((u) => !isVideoUrl(u));
    const hosted = a.preview ? new Map(photos.map((u) => [u, u])) : await rehost(photos, ctx);
    const host = (list: string[]) => list.map((u) => hosted.get(u) ?? u);
    for (const change of a.changes) {
      if (change.images) change.images = host(change.images);
      for (const v of change.variants ?? []) if (v.images) v.images = host(v.images);
      ctx.progress(`${a.preview ? "Working out" : "Saving"} ${change.id}…`);
      const before = await getProduct(change.id);
      const variants = before.productVariants ?? [];
      const body: Record<string, unknown> = {};
      const diff: string[] = [];

      if (change.name !== undefined && change.name !== before.name) {
        body.name = change.name;
        diff.push(`name "${before.name}" → "${change.name}"`);
      }
      if (change.description !== undefined) {
        body.description = change.description;
        diff.push("description");
      }
      if (change.status && change.status !== before.status) {
        body.status = change.status;
        diff.push(`status ${before.status} → ${change.status}`);
      }
      if (change.categoryIds) body.categoryIds = change.categoryIds;
      if (change.images) {
        // Photos are replaced; the product's videos stay last, where video_publish put them.
        body.images = keepVideos(change.images, before.images);
        body.featuredImage = change.images.find((u) => !isVideoUrl(u)) ?? null;
        diff.push(`${change.images.length} photos`);
      }

      // Variants: each one's new figures, from allVariants then its own change.
      const variantPatch: Record<string, unknown>[] = [];
      for (const v of variants) {
        const own = change.variants?.find((x) => (x.id && x.id === v.id) || (x.sku && x.sku === v.sku));
        if (!own && !change.allVariants) continue;
        const cur = { price: money(v.price), mrp: money(v.compareAtPrice), stock: v.stockQuantity ?? 0 };
        const next = applyPrices(applyPrices(cur, change.allVariants), own);
        const active = own?.active ?? v.isActive;
        const changed = next.price !== cur.price || next.mrp !== cur.mrp || next.stock !== cur.stock || active !== v.isActive || own?.images;
        if (!changed) continue;
        variantPatch.push({
          id: v.id,
          price: next.price,
          compareAtPrice: next.mrp,
          stockQuantity: next.stock,
          isActive: active,
          ...(own?.images ? { images: keepVideos(own.images, v.images) } : {}),
        });
        const label = [v.variantAttributes?.Colour ?? v.variantAttributes?.colour, v.variantAttributes?.Size ?? v.variantAttributes?.size].filter(Boolean).join(" ") || v.sku;
        const bits = [
          next.price !== cur.price && `₹${cur.price} → ₹${next.price}`,
          next.mrp !== cur.mrp && `MRP ${cur.mrp ?? "none"} → ${next.mrp ?? "none"}`,
          next.stock !== cur.stock && `stock ${cur.stock} → ${next.stock}`,
          active !== v.isActive && (active ? "on" : "off"),
          own?.images && "photos",
        ].filter(Boolean);
        diff.push(`${label}: ${bits.join(", ")}`);
      }
      const unmatched = (change.variants ?? []).filter((x) => !variants.some((v) => (x.id && x.id === v.id) || (x.sku && x.sku === v.sku)));
      if (unmatched.length) throw new ToolError(`${before.name} has no variant ${unmatched.map((u) => u.id ?? u.sku).join(", ")}. Nothing was changed.`);
      if (variantPatch.length) body.productVariants = variantPatch;

      // The product's own figures: asked for directly, or following its variants.
      const curProduct = { price: money(before.price), mrp: money(before.compareAtPrice), stock: before.stockQuantity };
      const asked = change.price !== undefined || change.mrp !== undefined || change.discountPercent !== undefined || change.stock !== undefined;
      if (asked) {
        const next = applyPrices(curProduct, change);
        if (next.price !== curProduct.price) body.price = next.price;
        if (next.mrp !== curProduct.mrp) body.compareAtPrice = next.mrp;
        if (next.stock !== curProduct.stock && variants.length === 0) body.stockQuantity = next.stock;
        diff.push(
          ...[
            next.price !== curProduct.price && `price ₹${curProduct.price} → ₹${next.price}`,
            next.mrp !== curProduct.mrp && `MRP ${curProduct.mrp ?? "none"} → ${next.mrp ?? "none"}`,
            next.stock !== curProduct.stock && variants.length === 0 && `stock ${curProduct.stock} → ${next.stock}`,
          ].filter((x): x is string => !!x),
        );
      } else if (variantPatch.length) {
        const merged = variants.map((v) => ({ ...v, ...(variantPatch.find((p) => p.id === v.id) ?? {}) }));
        const live = merged.filter((v) => v.isActive);
        const prices = live.map((v) => Number(v.price)).filter((p) => p > 0);
        const mrps = live.map((v) => Number(v.compareAtPrice)).filter((p) => p > 0);
        if (prices.length && Math.min(...prices) !== curProduct.price) body.price = Math.min(...prices);
        if (mrps.length && Math.max(...mrps) !== curProduct.mrp) body.compareAtPrice = Math.max(...mrps);
      }

      if (Object.keys(body).length === 0) {
        results.push({ id: before.id, name: before.name, changes: "nothing to change" });
        continue;
      }
      if (!a.preview) await call("PATCH", `/products/${before.id}`, { body, signal: ctx.signal });
      results.push({ id: before.id, name: before.name, url: `https://paribelle.in/products/${before.slug}`, changes: diff });
    }
    return { data: { [a.preview ? "wouldChange" : "changed"]: results } };
  },
});

/* -------------------------------------------------------------------------- */
/* store_delete_products                                                      */
/* -------------------------------------------------------------------------- */

export const storeDeleteProducts = defineTool({
  name: "store_delete_products",
  label: "Remove paribelle.in products",
  description:
    "Remove products from paribelle.in. A product that was ever ordered is archived (kept for the old orders, hidden from the shop); one never ordered is deleted with its photos. To just hide a product, prefer store_update_products with status inactive.",
  parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 1, maxItems: 100, description: "Product ids or slugs." }) }),
  kind: "store",
  ownerOnly: true,
  enabled,
  summary: (a) => `Remove ${plural(a.ids.length, "product")} (${listRefs(a.ids, 3)})`,
  async execute(a, ctx) {
    const results = [];
    for (const ref of a.ids) {
      const product = await getProduct(ref);
      ctx.progress(`Removing ${product.name}…`);
      const res = await call<{ outcome: string }>("DELETE", `/products/${product.id}`, { signal: ctx.signal });
      results.push({ id: product.id, name: product.name, outcome: res.outcome });
    }
    return { data: results };
  },
});

/* -------------------------------------------------------------------------- */
/* Photos                                                                     */
/* -------------------------------------------------------------------------- */

const UPLOAD_EDGE = 1920;

/**
 * Photos on the store's own image host, so the shop never hotlinks Amazon.
 * Accepts https URLs, "chat:N" (the Nth image attached in this chat) and "asset:N"
 * (Seelie's media: shoot results, photo_edit output). Cloudinary URLs pass through.
 */
async function rehost(refs: string[], ctx: ToolContext): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const todo = [...new Set(refs)].filter((r) => {
    if (/^https:\/\/res\.cloudinary\.com\//.test(r)) {
      out.set(r, r);
      return false;
    }
    return true;
  });
  if (todo.length === 0) return out;
  for (let i = 0; i < todo.length; i += 10) {
    const batch = todo.slice(i, i + 10);
    ctx.progress(`Uploading photos ${i + 1}–${i + batch.length} of ${todo.length}…`);
    const files: Buffer[] = [];
    for (const ref of batch) {
      const bytes = /^(chat|asset):/.test(ref) ? (await imageOf(ref, ctx)).bytes : await fetchImage(ref, ctx.signal);
      files.push(await toJpeg(bytes, UPLOAD_EDGE, 88));
    }
    const urls = await uploadJpegs(files, ctx.signal);
    batch.forEach((ref, j) => out.set(ref, urls[j]));
  }
  return out;
}

/** JPEGs onto the store's image host (paribelle.in's Cloudinary), 10 at most at a time; their URLs in order. */
export async function uploadJpegs(files: Buffer[], signal: AbortSignal): Promise<string[]> {
  const uploaded = await call<{ url: string }[]>("POST", "/upload/images", {
    form: () => {
      const form = new FormData();
      files.forEach((f, j) => form.append("files", new Blob([new Uint8Array(f)], { type: "image/jpeg" }), `seelie-${Date.now()}-${j}.jpg`));
      return form;
    },
    signal,
  });
  return files.map((_, j) => {
    const url = uploaded[j]?.url;
    if (!url) throw new ToolError("The store's image upload didn't answer with a URL.");
    return url;
  });
}

export const storeUploadImages = defineTool({
  name: "store_upload_images",
  label: "Upload photos to paribelle.in",
  description:
    "Put photos on paribelle.in's image host and get their URLs, to use in store_create_products or store_update_products: https image URLs (e.g. Amazon's), 'chat:N' for the Nth image attached in this chat, or 'asset:N' (a shoot result, a photo_edit output). Up to 30.",
  parameters: Type.Object({ images: Type.Array(Type.String(), { minItems: 1, maxItems: 30 }) }),
  kind: "store",
  ownerOnly: true,
  enabled,
  summary: (a) => `Upload ${plural(a.images.length, "photo")}`,
  async execute(a, ctx) {
    const map = await rehost(a.images, ctx);
    return { data: a.images.map((ref) => ({ from: ref.slice(0, 120), url: map.get(ref) })) };
  },
});

/* -------------------------------------------------------------------------- */
/* store_create_products                                                      */
/* -------------------------------------------------------------------------- */

function slugify(text: string) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function categoryIdsFor(ids: string[] | undefined, names: string[] | undefined) {
  const out = new Set(ids ?? []);
  if (names?.length) {
    const all = await call<Category[]>("GET", "/categories");
    for (const name of names) {
      const hit = all.find((c) => c.name.toLowerCase() === name.trim().toLowerCase() || c.slug === slugify(name));
      if (!hit) throw new ToolError(`paribelle.in has no category "${name}". It has: ${all.map((c) => c.name).join(", ")}.`);
      out.add(hit.id);
    }
  }
  return [...out];
}

const NewVariant = Type.Object({
  sku: Type.String({ description: "Unique; for an Amazon item, its Amazon seller SKU." }),
  colour: Type.Optional(Type.String()),
  size: Type.Optional(Type.String()),
  price: Type.Number({ minimum: 1 }),
  mrp: Type.Optional(Type.Number({ minimum: 1 })),
  stock: Type.Integer({ minimum: 0 }),
  images: Type.Optional(Type.Array(Type.String(), { description: "This colour's photos (URLs, chat:N or asset:N)." })),
});

const NewProduct = Type.Object({
  name: Type.String({ description: "What shoppers see, e.g. 'Rani Pink Chikankari Anarkali Kurti'. No brand, no SEO filler." }),
  description: Type.String(),
  categoryNames: Type.Optional(Type.Array(Type.String(), { description: "Existing category names, e.g. Kurtis." })),
  categoryIds: Type.Optional(Type.Array(Type.String())),
  code: Type.String({ description: "Product code (the product's own SKU)." }),
  status: Type.Optional(StringEnum(["active", "draft"], { description: "Default draft." })),
  images: Type.Array(Type.String(), { description: "Product photos, cover first: URLs, chat:N or asset:N." }),
  price: Type.Optional(Type.Number({ minimum: 1, description: "Single-option products only." })),
  mrp: Type.Optional(Type.Number({ minimum: 1 })),
  stock: Type.Optional(Type.Integer({ minimum: 0 })),
  variants: Type.Optional(Type.Array(NewVariant, { maxItems: 200 })),
  attributes: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Filterable facts, e.g. { Fabric: 'Cotton', Sleeve: 'Three-Quarter' }." })),
  hsnCode: Type.Optional(Type.String()),
});

export const storeCreateProducts = defineTool({
  name: "store_create_products",
  label: "Add products to paribelle.in",
  description: [
    "Create products on paribelle.in, like the store's Add product page: one product per design, with Colour and/or Size variants",
    "(each with its SKU, price, MRP, stock and, per colour, its photos), photos (cover first), category, description and attributes.",
    "Photos given as Amazon or other URLs, or chat:N, are uploaded to the store's own image host first. New products are drafts unless status is active.",
    "GST and the product's shown price (lowest variant price, highest MRP) are worked out. Store convention for items brought over from Amazon:",
    "variant SKU = the Amazon seller SKU, stock = Amazon's quantity but at least 5, category Kurtis.",
  ].join(" "),
  parameters: Type.Object({ products: Type.Array(NewProduct, { minItems: 1, maxItems: 50 }) }),
  kind: "store",
  ownerOnly: true,
  enabled,
  summary: (a) =>
    `Add ${plural(a.products.length, "product")}: ${a.products
      .slice(0, 3)
      .map((p) => `${p.name}${p.variants?.length ? ` (${p.variants.length} variants)` : ""} as ${p.status ?? "draft"}`)
      .join("; ")}${a.products.length > 3 ? "; …" : ""}`,
  async execute(a, ctx) {
    // Everything checked before anything is created.
    for (const p of a.products) {
      if (!p.variants?.length && !p.price) throw new ToolError(`${p.name}: give a price, or variants.`);
      if (p.status === "active" && p.images.length === 0) throw new ToolError(`${p.name}: an active product needs at least one photo.`);
    }
    const allImages = a.products.flatMap((p) => [...p.images, ...(p.variants ?? []).flatMap((v) => v.images ?? [])]);
    const hosted = await rehost(allImages, ctx);
    const created = [];
    for (const p of a.products) {
      ctx.progress(`Creating ${p.name}…`);
      const categoryIds = await categoryIdsFor(p.categoryIds, p.categoryNames ?? ["Kurtis"]);
      const images = p.images.map((i) => hosted.get(i)!);
      const body: Record<string, unknown> = {
        name: p.name.trim(),
        slug: `${slugify(p.name)}-${Date.now().toString(36)}`,
        description: p.description,
        categoryIds,
        status: p.status ?? "draft",
        images,
        featuredImage: images[0] ?? null,
        sku: p.code.trim(),
        hsnCode: p.hsnCode?.trim() || null,
        priceType: "mrp_with_gst",
        productType: "physical",
        vendorId: STORE_VENDOR_ID,
      };
      if (p.variants?.length) {
        const colours = [...new Set(p.variants.map((v) => v.colour).filter((c): c is string => !!c))];
        const sizes = sortSizes([...new Set(p.variants.map((v) => v.size).filter((s): s is string => !!s))]);
        const variants = p.variants.map((v) => ({
          attributes: { ...(v.colour ? { Colour: v.colour } : {}), ...(v.size ? { Size: v.size } : {}) },
          sku: v.sku.trim(),
          price: v.price,
          compareAtPrice: v.mrp ?? null,
          stock: v.stock,
          images: (v.images ?? []).map((i) => hosted.get(i)!),
        }));
        body.price = Math.min(...variants.map((v) => v.price));
        const mrps = variants.map((v) => v.compareAtPrice ?? 0).filter((m) => m > 0);
        body.compareAtPrice = mrps.length ? Math.max(...mrps) : null;
        body.stockQuantity = 0;
        body.variantOptions = [
          ...(colours.length ? [{ id: "colour", name: "Colour", values: colours }] : []),
          ...(sizes.length ? [{ id: "size", name: "Size", values: sizes }] : []),
        ];
        body.variants = variants;
      } else {
        body.price = p.price;
        body.compareAtPrice = p.mrp ?? null;
        body.stockQuantity = p.stock ?? 0;
      }
      if (p.attributes && Object.keys(p.attributes).length) body.attributes = p.attributes;
      try {
        const res = await call<StoreProduct>("POST", "/products", { body, signal: ctx.signal });
        created.push({ id: res.id, name: res.name, status: res.status, url: `https://paribelle.in/products/${res.slug}` });
      } catch (err) {
        created.push({ name: p.name, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { data: created };
  },
});

/* -------------------------------------------------------------------------- */
/* store_amazon_gap                                                           */
/* -------------------------------------------------------------------------- */

export const storeAmazonGap = defineTool({
  name: "store_amazon_gap",
  label: "Amazon items missing on paribelle.in",
  description: [
    "Compare the Amazon catalogue the OMS holds (every Amazon SKU with its title, ASIN, photo and stock) against paribelle.in's variant SKUs,",
    "grouped into designs (sizes and colours together, as the store lists them). Shows designs with no SKU on the store (new products to add)",
    "and designs partly on it (the store product their siblings are on, and the SKUs it lacks). Amazon titles are SEO-stuffed: clean them",
    "into a store name (no brand, no 'Women's', no filler). Run amazon_listings first for prices, and catalogue_link if the OMS is behind Amazon.",
  ].join(" "),
  parameters: Type.Object({
    query: Type.Optional(Type.String({ description: "Only designs whose title or SKU matches." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 300, description: "Designs to show (default 40)." })),
  }),
  kind: "read",
  ownerOnly: true,
  enabled,
  summary: (a) => (a.query ? `"${a.query}"` : "Everything on Amazon"),
  async execute(a, ctx) {
    const storeItems = await allProducts(ctx);
    const storeSku = new Map<string, { id: string; name: string; status: string }>();
    for (const p of storeItems) {
      storeSku.set(p.sku, { id: p.id, name: p.name, status: p.status });
      for (const v of p.productVariants ?? []) storeSku.set(v.sku, { id: p.id, name: p.name, status: p.status });
    }

    ctx.progress("Reading the OMS's Amazon catalogue…");
    const rows = await db
      .select({
        sku: channelListings.externalSku,
        asin: channelListings.externalId,
        title: products.name,
        image: products.imageUrl,
        onHand: inventory.onHand,
        lastPrice: sql<string | null>`(SELECT oi.unit_price FROM order_items oi WHERE oi.external_sku = ${channelListings.externalSku} AND oi.unit_price IS NOT NULL ORDER BY oi.id DESC LIMIT 1)`,
        sold: sql<number>`(SELECT COALESCE(SUM(oi.quantity),0)::int FROM order_items oi WHERE oi.external_sku = ${channelListings.externalSku} AND oi.cancelled = false)`,
      })
      .from(channelListings)
      .innerJoin(channelAccounts, eq(channelAccounts.id, channelListings.channelAccountId))
      .innerJoin(products, eq(products.id, channelListings.productId))
      .leftJoin(inventory, eq(inventory.productId, products.id))
      .where(and(eq(channelAccounts.channel, "amazon"), eq(channelListings.active, true)));

    const q = a.query?.trim().toLowerCase();
    const designs = new Map<
      string,
      { design: string; amazonTitle: string; skus: { sku: string; asin: string | null; colour: string | null; size: string | null; onHand: number; lastPrice: number | null; sold: number; image: string | null; onStore: string | null }[] }
    >();
    for (const r of rows) {
      const parsed = parseVariantTitle(r.title);
      const key = parsed.baseKey || r.sku.toLowerCase();
      let d = designs.get(key);
      if (!d) {
        d = { design: parsed.label, amazonTitle: parsed.base, skus: [] };
        designs.set(key, d);
      }
      d.skus.push({
        sku: r.sku,
        asin: r.asin,
        colour: parsed.color,
        size: parsed.size,
        onHand: r.onHand ?? 0,
        lastPrice: num(r.lastPrice),
        sold: r.sold,
        image: r.image,
        onStore: storeSku.get(r.sku)?.id ?? null,
      });
    }

    const missing = [];
    const partial = [];
    for (const d of designs.values()) {
      if (q && !d.amazonTitle.toLowerCase().includes(q) && !d.skus.some((s) => s.sku.toLowerCase().includes(q))) continue;
      const on = d.skus.filter((s) => s.onStore);
      const off = d.skus.filter((s) => !s.onStore);
      if (off.length === 0) continue;
      const entry = {
        design: d.design,
        amazonTitle: d.amazonTitle,
        colours: [...new Set(off.map((s) => s.colour).filter(Boolean))],
        sizes: sortSizes([...new Set(off.map((s) => s.size).filter((s): s is string => !!s))]),
        sold: d.skus.reduce((s, x) => s + x.sold, 0),
        skus: off.map(({ onStore: _, ...s }) => s),
      };
      if (on.length === 0) missing.push(entry);
      else {
        const host = storeSku.get(on[0].sku)!;
        partial.push({ ...entry, storeProduct: { id: host.id, name: host.name, status: host.status } });
      }
    }
    missing.sort((x, y) => y.sold - x.sold);
    const limit = a.limit ?? 40;
    return {
      data: {
        amazonSkus: rows.length,
        storeProducts: storeItems.length,
        designsMissing: missing.length,
        designsPartlyOnStore: partial.length,
        missing: missing.slice(0, limit),
        partlyOnStore: partial.slice(0, limit),
        note: partial.length
          ? "The store's API can't add variants to an existing product; missing sizes of a design already on the store go in through the store admin's import sheet, or the design is re-created."
          : undefined,
      },
    };
  },
});

/* -------------------------------------------------------------------------- */
/* store_api                                                                  */
/* -------------------------------------------------------------------------- */

export const storeApiRoutes = defineTool({
  name: "store_api_routes",
  label: "paribelle.in API routes",
  description:
    "List paribelle.in's API routes (from its Swagger description): method, path, summary and parameters, filtered by text or tag (products, categories, orders, promotions, homepage, users, vendors, analytics, ...). Use before store_api.",
  parameters: Type.Object({
    filter: Type.Optional(Type.String()),
    schema: Type.Optional(Type.String({ description: "A component schema name to show in full." })),
  }),
  kind: "read",
  ownerOnly: true,
  enabled,
  summary: (a) => a.schema ?? a.filter ?? "All routes",
  async execute(a) {
    let doc;
    try {
      doc = await storeDocs();
    } catch (err) {
      throw new ToolError(err instanceof Error ? err.message : String(err));
    }
    if (a.schema) return { data: doc.components?.schemas?.[a.schema] ?? `No schema ${a.schema}.` };
    const f = a.filter?.toLowerCase();
    const lines: string[] = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        const line = `${method.toUpperCase()} ${path.replace(/^\/api\/v1/, "")}${op.summary ? ` — ${op.summary}` : ""}${op.tags?.length ? ` [${op.tags.join(", ")}]` : ""}${
          op.parameters?.length ? ` (${op.parameters.map((p) => `${p.in}:${p.name}${p.required ? "*" : ""}`).join(", ")})` : ""
        }`;
        if (!f || line.toLowerCase().includes(f)) lines.push(line);
      }
    }
    return { text: lines.length ? lines.join("\n") : "No route matches." };
  },
});

export const storeApi = defineTool({
  name: "store_api",
  label: "paribelle.in API",
  description: [
    "Call any paribelle.in API route as the store's admin, for what the other store tools don't cover (orders, promotions, homepage, categories,",
    "reviews, customers, analytics, ...). Path is under /api/v1, e.g. /orders?page=1. GET only reads; any other method changes the store and always asks.",
    "Check store_api_routes first. Never use it for product deletes or edits the store_* product tools can do.",
  ].join(" "),
  parameters: Type.Object({
    method: StringEnum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: Type.String(),
    query: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
    body: Type.Optional(Type.Unknown()),
  }),
  kind: (a) => (a.method === "GET" ? "read" : "store"),
  ownerOnly: true,
  enabled,
  summary: (a) => `${a.method} ${a.path}${a.body !== undefined ? ` ${JSON.stringify(a.body).slice(0, 200)}` : ""}`,
  async execute(a, ctx) {
    if (/^\/?(auth|users\/me\/password)/.test(a.path.replace(/^\/api\/v1/, "").replace(/^\//, "")) && a.method !== "GET") {
      throw new ToolError("Sign-in and password routes aren't for Seelie.");
    }
    return { data: await call(a.method, a.path, { query: a.query, body: a.body, signal: ctx.signal }) };
  },
});

