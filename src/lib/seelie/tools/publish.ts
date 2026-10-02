import "server-only";

import { readFile, stat } from "node:fs/promises";

import { Type } from "@paribelle/pi-ai";

import { InstagramError, instagramReady, publishReel } from "../instagram";
import { videoFile } from "../media/files";
import { addPublished, getVideo, publishedOf, versionOf, versionsOf, type VideoRow, type VideoVersion } from "../media/library";
import { publicOrigin, publicVideoUrl } from "../media/public";
import { storeApiUrl, StoreError, storeFetch } from "../store";
import { getProduct, isVideoUrl, money, type StoreVariant } from "./store";
import { defineTool, ToolError, type ToolContext } from "./types";
import { optional, StringEnum } from "./util";

/**
 * Sending a finished video out: to a paribelle.in product page (the video goes last in
 * the product's gallery and in each colour's, where the storefront plays it) or to
 * Instagram as a reel. Both always ask first.
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
