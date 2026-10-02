import "server-only";

import { readFile, stat } from "node:fs/promises";

import { Type } from "@paribelle/pi-ai";
import { eq, or } from "drizzle-orm";

import { db } from "@/db";
import { products } from "@/db/schema";
import { LOCAL_COPY_MARK } from "@/lib/photo-src";

import { InstagramError, instagramReady, publishReel } from "../instagram";
import { saveLocalCopy } from "../media/catalogue";
import { subjectMask } from "../media/cutout";
import { getAsset, videoFile } from "../media/files";
import { addPublished, getVideo, publishedOf, versionOf, versionsOf, type VideoRow, type VideoVersion } from "../media/library";
import { publicOrigin, publicVideoUrl } from "../media/public";
import { storeApiUrl, StoreError, storeFetch } from "../store";
import { whiteCheck } from "../studio/edit";
import { decode, toCanvas } from "../studio/raster";
import { amazonAccount, amazonAdapter } from "./catalogue";
import { toJpeg } from "./images";
import { imageOf } from "./photo";
import { getProduct, isVideoUrl, money, uploadJpegs, type StoreVariant } from "./store";
import { defineTool, ToolError, type ToolContext } from "./types";
import { optional, plural, StringEnum } from "./util";

/**
 * Sending finished work out. A video: to a paribelle.in product page (the video goes last
 * in the product's gallery and in each colour's, where the storefront plays it) or to
 * Instagram as a reel. A photo: to the OMS catalogue or an Amazon listing's image slots.
 * All of it always asks first.
 */

/** The store's product-video upload takes up to this. */
const STORE_MAX_BYTES = 100 * 1024 * 1024;
/** Instagram fetches the file itself; the link outlives a slow processing queue. */
const INSTAGRAM_LINK_SECONDS = 2 * 60 * 60;

/** The final version to publish: the one named, or the latest final. */
function finalOf(video: VideoRow, version?: number): VideoVersion {
  if (version !== undefined) {
    const v = versionOf(video, version);
    if (v.quality !== "final") throw new ToolError(`video:${video.id}@${v.version} is a draft. Render it as a final (video_render quality "final") and publish that.`);
    return v;
  }
  const finals = versionsOf(video).filter((v) => v.quality === "final");
  const v = finals.at(-1);
  if (!v) throw new ToolError(`video:${video.id} has no final version yet. Render one (video_render quality "final") first.`);
  return v;
}

const colourOf = (v: StoreVariant) => {
  const attrs = v.variantAttributes ?? {};
  const key = Object.keys(attrs).find((k) => /^colou?r$/i.test(k));
  return key ? attrs[key]?.trim() || null : null;
};

async function toParibelle(video: VideoRow, v: VideoVersion, a: { product?: string; colours?: string[] }, ctx: ToolContext) {
  if (!storeApiUrl()) throw new ToolError("paribelle.in isn't connected on this server.");
  if (!a.product?.trim()) throw new ToolError("Which product (product: its id or slug)?");
  const product = await getProduct(a.product);
  const images = product.images ?? [];
  const photos = images.filter((u) => !isVideoUrl(u));
  if (photos.length < 2) {
    throw new ToolError(`${product.name} has ${photos.length} photo${photos.length === 1 ? "" : "s"}; a video needs at least 2 first (shop cards show the second item when hovered, which would be the video).`);
  }
  const before = publishedOf(video).find((p) => p.to === "paribelle" && p.productId === product.id && p.version === v.version);
  if (before?.to === "paribelle") throw new ToolError(`video:${video.id}@${v.version} is already on ${product.name} (${before.url}).`);

  // Colours with their own photos show their own gallery; the video joins the ones asked for.
  const variants = product.productVariants ?? [];
  const withPhotos = [...new Set(variants.filter((x) => x.images?.some((u) => !isVideoUrl(u))).map(colourOf).filter((c): c is string => !!c))];
  let colours = withPhotos;
  if (a.colours) {
    const unknown = a.colours.filter((c) => !withPhotos.some((w) => w.toLowerCase() === c.trim().toLowerCase()));
    if (unknown.length) {
      throw new ToolError(
        `${product.name} has no colour with its own photos called ${unknown.join(", ")}. ${withPhotos.length ? `Colours with photos: ${withPhotos.join(", ")}.` : "No colour has its own photos (the product gallery is the only one)."}`,
      );
    }
    colours = withPhotos.filter((w) => a.colours!.some((c) => c.trim().toLowerCase() === w.toLowerCase()));
  }

  const file = videoFile(video.id, v.version);
  const { size } = await stat(file);
  if (size > STORE_MAX_BYTES) throw new ToolError(`video:${video.id}@${v.version} is ${(size / 1048576).toFixed(0)} MB; the store takes up to 100 MB.`);
  const bytes = await readFile(file);

  ctx.progress(`Uploading the video (${(size / 1048576).toFixed(1)} MB) to paribelle.in…`);
  let url: string;
  try {
    const up = await storeFetch<{ url?: string }>("POST", "/upload/product-video", {
      form: () => {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(bytes)], { type: "video/mp4" }), `seelie-video-${video.id}-v${v.version}.mp4`);
        return form;
      },
      signal: ctx.signal,
      timeoutMs: 10 * 60_000,
    });
    if (!up?.url) throw new ToolError("The store's video upload didn't answer with a URL.");
    url = up.url;
  } catch (err) {
    if (err instanceof StoreError) {
      throw new ToolError(err.status === 404 ? "paribelle.in's API has no product-video upload yet (POST /upload/product-video): it needs the API update first." : err.message);
    }
    throw err;
  }

  ctx.progress(`Adding it to ${product.name}…`);
  // Variant rows are re-read just before writing, so the figures sent back are current.
  const fresh = colours.length ? await getProduct(product.id) : product;
  const picked = new Set(colours.map((c) => c.toLowerCase()));
  const variantPatch = (fresh.productVariants ?? [])
    .filter((x) => x.images?.some((u) => !isVideoUrl(u)) && picked.has(colourOf(x)?.toLowerCase() ?? ""))
    .map((x) => ({
      id: x.id,
      price: money(x.price),
      compareAtPrice: money(x.compareAtPrice),
      stockQuantity: x.stockQuantity ?? 0,
      isActive: x.isActive,
      images: [...(x.images ?? []), url],
    }));
  try {
    await storeFetch("PATCH", `/products/${product.id}`, {
      body: { images: [...(fresh.images ?? []), url], ...(variantPatch.length ? { productVariants: variantPatch } : {}) },
      signal: ctx.signal,
    });
  } catch (err) {
    if (err instanceof StoreError) throw new ToolError(`The video was uploaded (${url}) but adding it to ${product.name} failed: ${err.message}`);
    throw err;
  }

  await addPublished(video.id, {
    to: "paribelle",
    version: v.version,
    productId: product.id,
    product: product.name,
    url,
    colours,
    at: new Date().toISOString(),
    by: ctx.user.id,
  });
  return {
    data: {
      published: `video:${video.id}@${v.version}`,
      product: product.name,
      page: `https://paribelle.in/products/${product.slug}`,
      video: url,
      gallery: colours.length ? ["the product's", ...colours] : ["the product's"],
    },
  };
}

async function toInstagram(video: VideoRow, v: VideoVersion, a: { caption?: string; shareToFeed?: boolean; coverAt?: number }, ctx: ToolContext) {
  if (!(await instagramReady())) throw new ToolError("Instagram isn't connected: the owner adds the account's token in Seelie's settings (gear, top right).");
  const origin = publicOrigin();
  if (/^https?:\/\/(localhost|127\.|\[::1\])/i.test(origin)) throw new ToolError(`Instagram fetches the video from ${origin}, which it can't reach. Set SEELIE_PUBLIC_URL to the OMS's public address.`);
  if (v.seconds < 3) throw new ToolError("Instagram takes reels of 3 seconds or more.");
  const before = publishedOf(video).find((p) => p.to === "instagram" && p.version === v.version);
  if (before?.to === "instagram") throw new ToolError(`video:${video.id}@${v.version} is already on Instagram${before.permalink ? ` (${before.permalink})` : ""}.`);
  const caption = (a.caption ?? "").trim();
  if (caption.length > 2200) throw new ToolError("Instagram captions are up to 2,200 characters.");
  if ((caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > 30) throw new ToolError("Instagram allows up to 30 hashtags.");
  if (a.coverAt !== undefined && a.coverAt > v.seconds) throw new ToolError(`coverAt is past the end (${v.seconds} s).`);

  try {
    const out = await publishReel({
      videoUrl: publicVideoUrl(video.id, v.version, INSTAGRAM_LINK_SECONDS),
      caption,
      shareToFeed: a.shareToFeed ?? true,
      coverAtMs: a.coverAt !== undefined ? a.coverAt * 1000 : undefined,
      signal: ctx.signal,
      progress: ctx.progress,
    });
    await addPublished(video.id, {
      to: "instagram",
      version: v.version,
      mediaId: out.mediaId,
      permalink: out.permalink,
      caption,
      at: new Date().toISOString(),
      by: ctx.user.id,
    });
    return { data: { published: `video:${video.id}@${v.version}`, account: `@${out.username}`, link: out.permalink } };
  } catch (err) {
    if (err instanceof InstagramError) throw new ToolError(err.message);
    throw err;
  }
}

export const videoPublish = defineTool({
  name: "video_publish",
  label: "Publish a video",
  description: [
    "Send a final version of a library video out. Always asks the owner first; publish only what they asked for.",
    "to 'paribelle': adds it to a paribelle.in product (product: id or slug), last in the product's gallery and in each colour's own gallery,",
    "where the storefront plays it. colours: which colours with their own photos get it (default every one; [] for the product's gallery only).",
    "The product needs at least 2 photos.",
    "to 'instagram': posts it as a reel on the connected account. caption (up to 2,200 characters, 30 hashtags), shareToFeed (default true),",
    "coverAt: the moment, in seconds, for the cover. Reels posted this way can't use Instagram's music library and a commercial song in the video",
    "may get it muted; say so when the video carries a library song.",
    "Each version goes to a product or to Instagram once; video_library get shows where a video went.",
  ].join(" "),
  parameters: Type.Object({
    videoId: Type.Integer(),
    version: optional(Type.Integer({ description: "Default: its latest final." })),
    to: StringEnum(["paribelle", "instagram"]),
    product: optional(Type.String()),
    colours: optional(Type.Array(Type.String(), { maxItems: 40 })),
    caption: optional(Type.String({ maxLength: 2200 })),
    shareToFeed: optional(Type.Boolean()),
    coverAt: optional(Type.Number({ minimum: 0 })),
  }),
  kind: (a) => (a.to === "instagram" ? "publish" : "store"),
  ownerOnly: true,
  summary: (a) =>
    a.to === "instagram"
      ? `Post video:${a.videoId}${a.version ? `@${a.version}` : ""} to Instagram${a.caption ? `: "${a.caption.slice(0, 80)}${a.caption.length > 80 ? "…" : ""}"` : ""}`
      : `Add video:${a.videoId}${a.version ? `@${a.version}` : ""} to paribelle.in product ${a.product ?? "?"}${a.colours ? (a.colours.length ? ` (${a.colours.join(", ")})` : " (gallery only)") : ""}`,
  async execute(a, ctx) {
    const video = await getVideo(a.videoId);
    if (!video) throw new ToolError(`There's no video:${a.videoId}. video_library list shows them.`);
    let v: VideoVersion;
    try {
      v = finalOf(video, a.version);
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError(err instanceof Error ? err.message : String(err));
    }
    return a.to === "instagram" ? toInstagram(video, v, a, ctx) : toParibelle(video, v, a, ctx);
  },
});

/* -------------------------------------------------------------------------- */
/* photo_publish                                                              */
/* -------------------------------------------------------------------------- */

const SLOTS = ["main", "1", "2", "3", "4", "5", "6", "7", "8"] as const;
const slotAttribute = (slot: (typeof SLOTS)[number]) => (slot === "main" ? "main_product_image_locator" : `other_product_image_locator_${slot}`);

/** Amazon's main image: the background must be pure white (RGB 255) to the edges. */
const MAIN_WHITE = 0.97;

/** Made by the image model, or edited from something that was (photo_edit keeps `from`). */
async function generated(ref: string): Promise<boolean> {
  let cur: unknown = ref;
  for (let i = 0; i < 8 && typeof cur === "string" && cur.startsWith("asset:"); i++) {
    const asset = await getAsset(Number(cur.slice(6)));
    if (!asset) return false;
    if (asset.source === "photoshoot" || asset.source === "generated") return true;
    cur = (asset.meta as { from?: unknown } | null)?.from;
  }
  return false;
}

async function omsPhoto(a: { product?: string; ref?: string }, ctx: ToolContext) {
  if (!storeApiUrl()) throw new ToolError("paribelle.in's image host isn't connected on this server, and OMS photos are kept there.");
  const p = a.product?.trim();
  if (!p || !a.ref) throw new ToolError("Which OMS product (product: SKU or id) and which photo (ref)?");
  const [product] = await db
    .select({ id: products.id, sku: products.sku, name: products.name, image: products.imageUrl })
    .from(products)
    .where(or(eq(products.sku, p), /^\d{1,9}$/.test(p) ? eq(products.id, Number(p)) : undefined))
    .limit(1);
  if (!product) throw new ToolError(`There's no OMS product ${p}.`);
  const jpeg = await toJpeg((await imageOf(a.ref, ctx)).bytes, 1600, 88);
  ctx.progress("Uploading the photo…");
  const [url] = await uploadJpegs([jpeg], ctx.signal);
  await saveLocalCopy(url, jpeg);
  await db
    .update(products)
    .set({ imageUrl: `${url}${LOCAL_COPY_MARK}` })
    .where(eq(products.id, product.id));
  return { data: { product: product.sku, name: product.name, before: product.image, now: url, localCopy: true } };
}

type AmazonPhotoArgs = { sku?: string; images?: { slot: (typeof SLOTS)[number]; ref: string }[]; accountId?: number; preview?: boolean; allowGenerated?: boolean };

async function amazonPhotos(a: AmazonPhotoArgs, ctx: ToolContext) {
  const sku = a.sku?.trim();
  if (!sku || !a.images?.length) throw new ToolError("Which listing (sku: the Amazon seller SKU) and which photos (images: slot + ref)?");
  const slots = a.images.map((i) => i.slot);
  if (new Set(slots).size !== slots.length) throw new ToolError("Two photos are for the same slot.");
  if (!a.preview && !storeApiUrl()) throw new ToolError("Amazon fetches each photo from a public URL, and paribelle.in's image host (where they go) isn't connected here.");
  const account = await amazonAccount(a.accountId);
  const adapter = amazonAdapter(account);
  if (!adapter.sellerId) throw new ToolError("This Amazon account has no seller id saved.");
  const path = `/listings/2021-08-01/items/${adapter.sellerId}/${encodeURIComponent(sku)}`;
  const amazonError = (err: unknown) => {
    const e = err as { message?: string; body?: string };
    return new ToolError(`${e.message ?? String(err)}${e.body ? `: ${e.body.slice(0, 1500)}` : ""}`);
  };
  let listing: { summaries?: { productType?: string; itemName?: string }[] };
  try {
    listing = await adapter.call("GET", path, { query: { marketplaceIds: adapter.marketplace, includedData: "summaries" } });
  } catch (err) {
    throw amazonError(err);
  }
  const productType = listing.summaries?.[0]?.productType;
  if (!productType) throw new ToolError(`Amazon has no listing ${sku} in this marketplace (or it has no product type).`);

  const files: Buffer[] = [];
  const checks: Record<string, unknown>[] = [];
  for (const [i, im] of a.images.entries()) {
    ctx.progress(`Preparing photo ${i + 1} of ${a.images.length}…`);
    const jpeg = await toJpeg((await imageOf(im.ref, ctx)).bytes, 3000, 92);
    if (im.slot === "main") {
      if (!a.allowGenerated && (await generated(im.ref))) {
        throw new ToolError(
          `${im.ref} was made by the image model. Amazon's main image is the real product on white: use a real photo (photo_edit white), or allowGenerated only if the owner says so.`,
        );
      }
      const r = await decode(jpeg);
      const mask = { w: r.w, h: r.h, a: await subjectMask(await toCanvas(r), r.w, r.h, { progress: ctx.progress, signal: ctx.signal }) };
      const white = whiteCheck(r, mask);
      const share = Math.round(white.pureWhite * 1000) / 10;
      checks.push({ slot: "main", pureWhite: `${share}%`, edgesWhite: white.edgesWhite, fill: white.fill });
      if (!white.edgesWhite || white.pureWhite < MAIN_WHITE) {
        throw new ToolError(
          `${im.ref} isn't on pure white (${share}% of the background is RGB 255${white.edgesWhite ? "" : ", and the edges aren't"}). Put it on catalogue white first (photo_edit white).`,
        );
      }
    }
    files.push(jpeg);
  }

  const urls = a.preview ? a.images.map(() => "(uploaded on publish)") : await uploadJpegs(files, ctx.signal);
  const patches = a.images.map((im, i) => ({
    op: "replace",
    path: `/attributes/${slotAttribute(im.slot)}`,
    value: [{ marketplace_id: adapter.marketplace, media_location: urls[i] }],
  }));
  const body = { productType, patches };
  if (a.preview) {
    return { text: "Nothing was sent: this is what publishing would send.", data: { listing: listing.summaries?.[0]?.itemName ?? sku, request: { method: "PATCH", path, body }, checks } };
  }
  ctx.progress("Sending the photos to Amazon…");
  try {
    const res = await adapter.call<{ status?: string; issues?: unknown[] }>("PATCH", path, { query: { marketplaceIds: adapter.marketplace, issueLocale: "en_US" }, body });
    return {
      text: res.status === "ACCEPTED" ? "Amazon accepted it; the photos show once its processing is done (minutes to hours)." : `Amazon answered ${res.status ?? "without a status"}.`,
      data: { sku, status: res.status, issues: res.issues ?? [], photos: a.images.map((im, i) => ({ slot: im.slot, from: im.ref, url: urls[i] })), checks },
      error: res.status !== "ACCEPTED",
    };
  } catch (err) {
    throw amazonError(err);
  }
}

export const photoPublish = defineTool({
  name: "photo_publish",
  label: "Publish photos",
  description: [
    "Send finished photos (chat:N or asset:N) out. Always asks the owner first; publish only what they asked for.",
    "to 'oms': the OMS catalogue photo of a product (product: OMS SKU or id; ref): uploaded to paribelle.in's image host, with a copy kept on this server that the OMS shows.",
    "to 'amazon': an Amazon listing's image slots (sku: the seller SKU; images: slot main or 1-8, and ref), uploaded to paribelle.in's host and set on the listing",
    "(main_product_image_locator / other_product_image_locator_N by JSON Patch). The main slot is refused unless code finds a pure white background to the edges,",
    "and refused for a picture the image model made (or one edited from it) unless the owner says otherwise (allowGenerated). preview: what would be sent, nothing uploaded.",
    "paribelle.in product photos go through store_update_products (images take asset:N). Flipkart and Meesho have no API here: make the files in their sizes and the owner downloads them.",
  ].join(" "),
  parameters: Type.Object({
    to: StringEnum(["oms", "amazon"]),
    product: optional(Type.String()),
    ref: optional(Type.String()),
    sku: optional(Type.String()),
    images: optional(Type.Array(Type.Object({ slot: StringEnum(SLOTS), ref: Type.String() }), { minItems: 1, maxItems: 9 })),
    accountId: optional(Type.Integer()),
    preview: optional(Type.Boolean()),
    allowGenerated: optional(Type.Boolean()),
  }),
  kind: (a) => (a.preview ? "read" : a.to === "amazon" ? "market" : "store"),
  ownerOnly: true,
  summary: (a) =>
    a.to === "amazon"
      ? `${a.preview ? "Preview: " : ""}${plural(a.images?.length ?? 0, "photo")} on Amazon listing ${a.sku ?? "?"} (${(a.images ?? []).map((i) => `${i.slot}: ${i.ref}`).join(", ")})`
      : `${a.ref ?? "?"} as the OMS photo of ${a.product ?? "?"}`,
  async execute(a, ctx) {
    return a.to === "amazon" ? amazonPhotos(a, ctx) : omsPhoto(a, ctx);
  },
});
