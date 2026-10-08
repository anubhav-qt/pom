import "server-only";

import { Type, type ImageContent, type Static } from "@paribelle/pi-ai";
import { and, eq, or, type SQL } from "drizzle-orm";

import { db } from "@/db";
import { catalogImages, channelAccounts, channelListings, products } from "@/db/schema";

import { IMAGE_MODEL } from "../gemini";
import { assetSummary, getAsset, MediaError, saveAsset } from "../media/files";
import { budgetLine, CapError, imageBudget, makeImage, type ImageBudget } from "../studio/budget";
import { colourCheck, compareSheet, detailCrop, garmentMask, type DetailPair } from "../studio/check";
import {
  IMAGE_SIZES,
  LOOK_KINDS,
  PromptError,
  RECAST_CHANGES,
  renderLook,
  renderPersona,
  SHOOT_ASPECTS,
  templateVersion,
  type GarmentSpec,
  type LookBrief,
} from "../studio/prompts";
import { crop, decode, preview, type Mask, type Raster } from "../studio/raster";
import {
  anchorOf,
  createShoot,
  garmentKey,
  getGarment,
  getPersona,
  getShoot,
  hasBack,
  isWorn,
  listPersonas,
  lookRefs,
  pruneAttempts,
  recentShoots,
  removePersona,
  saveGarment,
  savePersona,
  shootsWithPersonas,
  updateShoot,
  waitingShoots,
  type Attempt,
  type Garment,
  type GarmentPhoto,
  type LookRef,
  type Shoot,
  type ShootLook,
} from "../studio/shoots";
import { storeApiUrl } from "../store";
import { amazonAccount, amazonAdapter } from "./catalogue";
import { fetchPublic, toJpeg } from "./images";
import { imageOf, jpegBlock } from "./photo";
import { getProduct, isVideoUrl } from "./store";
import { defineTool, ToolError, type ToolContext } from "./types";
import { ist, optional, plural, StringEnum } from "./util";

/**
 * Product photoshoots: the only tool that makes pictures with the image model, so the
 * only one that spends the capped budget. Everything around the shot is free code:
 * finding and studying the product's photos, the garment spec, prompts from the
 * templates, the fidelity check (compare sheet + ΔE00), personas and the queue.
 */

/* -------------------------------------------------------------------------- */
/* Parameters                                                                 */
/* -------------------------------------------------------------------------- */

const Frac = Type.Number({ minimum: 0, maximum: 1 });
const BoxT = Type.Object({ x: Frac, y: Frac, w: Frac, h: Frac }, { description: "Fractions of the picture: x, y = top-left; w, h = size." });
const Text = (max = 400) => optional(Type.String({ maxLength: max }));

const Look = Type.Object({
  id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,23}$", description: "A short name: hero, turn, back, detail-yoke, lifestyle." }),
  kind: StringEnum(LOOK_KINDS),
  change: optional(StringEnum(RECAST_CHANGES, { description: "recast only." })),
  framing: Text(),
  fullLength: optional(Type.Boolean()),
  angle: Text(),
  pose: Text(),
  expression: Text(),
  detail: Text(),
  setting: Text(),
  light: Text(),
  camera: Text(),
  styling: Text(),
  mood: Text(),
  aspect: optional(StringEnum(SHOOT_ASPECTS)),
  size: optional(StringEnum(IMAGE_SIZES)),
  thinking: optional(StringEnum(["minimal", "high"])),
  direction: Text(2000),
  corrections: optional(Type.Array(Type.String({ maxLength: 400 }), { maxItems: 12 })),
  brand: optional(Type.Boolean()),
  source: optional(Type.String({ description: "recast: the photo to change." })),
  detailRefs: optional(Type.Array(Type.Object({ ref: Type.String(), note: Text(200) }), { maxItems: 9 })),
  style: optional(Type.Array(Type.String(), { maxItems: 3 })),
  anchor: optional(Type.Boolean()),
});
type LookT = Static<typeof Look>;

const ACTIONS = ["gather", "zoom", "spec", "plan", "shoot", "check", "choose", "cast", "budget", "show", "feedback"] as const;

const Params = Type.Object({
  action: StringEnum(ACTIONS),
  // gather
  product: optional(Type.String({ description: "OMS SKU or product id, an Amazon seller SKU or ASIN." })),
  store: optional(Type.String({ description: "paribelle.in product id or slug." })),
  refs: optional(Type.Array(Type.String(), { maxItems: 24 })),
  garment: optional(Type.String()),
  name: Text(160),
  // zoom
  crops: optional(Type.Array(Type.Object({ ref: Type.String(), box: BoxT }), { maxItems: 8 })),
  // spec
  spec: optional(
    Type.Object({
      summary: Type.String({ maxLength: 4000 }),
      keep: Type.Array(Type.String({ maxLength: 300 }), { maxItems: 30 }),
      colours: Type.Array(Type.String({ maxLength: 80 }), { maxItems: 12 }),
      hasDupatta: Type.Boolean(),
    }),
  ),
  views: optional(Type.Array(Type.Object({ ref: Type.String(), view: Type.String({ maxLength: 60 }), note: Text(300) }), { maxItems: 24 })),
  // plan, shoot, choose, show, feedback
  shoot: optional(Type.Integer({ minimum: 1 })),
  title: Text(160),
  brief: Text(4000),
  persona: optional(Type.Integer({ minimum: 1 })),
  looks: optional(Type.Array(Look, { maxItems: 12 })),
  lookIds: optional(Type.Array(Type.String(), { maxItems: 12 })),
  size: optional(StringEnum(IMAGE_SIZES)),
  // check, choose
  look: optional(Type.String()),
  result: optional(Type.String()),
  original: optional(Type.String()),
  garmentBox: optional(Type.Object({ original: optional(BoxT), result: optional(BoxT) })),
  details: optional(Type.Array(Type.Object({ name: Type.String({ maxLength: 60 }), original: BoxT, result: BoxT, originalRef: optional(Type.String()) }), { maxItems: 4 })),
  verdict: Text(2000),
  // cast
  cast: optional(StringEnum(["list", "save", "sheet", "remove"])),
  description: Text(1000),
  pictures: optional(Type.Array(Type.Object({ ref: Type.String(), box: optional(BoxT) }), { maxItems: 4 })),
  notes: Text(2000),
  // feedback
  liked: optional(Type.Boolean()),
});
type P = Static<typeof Params>;

/* -------------------------------------------------------------------------- */
/* Shared                                                                     */
/* -------------------------------------------------------------------------- */

const clock = (iso: string | null) => (iso ? (ist(iso)?.slice(11) ?? iso) : "?");
const fmtBudget = (b: ImageBudget) => budgetLine(b, (iso) => `${clock(iso)} IST`);

/** A picture kept for later: a chat image becomes an asset (chat numbers mean nothing in another chat). */
async function keepRef(ref: string, ctx: ToolContext, name?: string): Promise<string> {
  const r = ref.trim();
  if (r.startsWith("asset:")) {
    const asset = await getAsset(Number(r.slice(6)));
    if (!asset) throw new ToolError(`There's no ${r}.`);
    if (asset.kind !== "image") throw new ToolError(`${r} isn't an image.`);
    return r;
  }
  const img = await imageOf(r, ctx);
  const type = img.bytes[0] === 0x89 ? "image/png" : img.bytes[0] === 0x52 ? "image/webp" : "image/jpeg";
  const row = await saveAsset({ bytes: img.bytes, mime: type, name: name ?? img.name, source: "upload", chatId: ctx.chatId, userId: ctx.user.id, meta: { from: r } });
  return `asset:${row.id}`;
}

async function rasterOf(ref: string, ctx: ToolContext): Promise<Raster> {
  return decode((await imageOf(ref, ctx)).bytes);
}

async function needGarment(key: string | null | undefined, opts: { spec?: boolean } = {}): Promise<Garment & { spec: GarmentSpec | null }> {
  if (!key) throw new ToolError("Which garment? (garment: the key gather gave)");
  const g = await getGarment(key);
  if (!g) throw new ToolError(`There's no garment "${key}": gather its photos first.`);
  if (opts.spec && !g.spec) throw new ToolError(`${g.name} has no garment spec yet: look at every photo (zoom into the details) and save one with action spec.`);
  if (!g.photos.length) throw new ToolError(`${g.name} has no photos: gather them first.`);
  return g;
}

async function needShoot(id: number | undefined): Promise<Shoot> {
  if (!id) throw new ToolError("Which shoot? (shoot: its id)");
  const s = await getShoot(id);
  if (!s) throw new ToolError(`There's no shoot ${id}.`);
  return s;
}

/** Our main photo of the garment (the one checks compare against). */
function mainPhoto(g: Garment): GarmentPhoto {
  return lookRefs({ id: "-", brief: { id: "-", kind: "on-model" }, refs: [], anchor: false, status: "planned", attempts: [], chosen: null, verdict: null }, g, null, null)
    .filter((r) => r.role === "product")
    .map((r) => g.photos.find((p) => p.ref === r.ref)!)[0];
}

function lookLine(l: ShootLook) {
  const b = l.brief;
  return `${l.id} (${b.kind}${b.change ? ` ${b.change}` : ""}, ${b.size ?? "2K"}, ${b.aspect ?? "3:4"})`;
}

/** The looks a shoot call makes: those named, else every one planned, waiting or failed. */
function looksToShoot(s: Shoot, ids: string[] | undefined) {
  if (ids?.length) {
    const missing = ids.filter((id) => !s.looks.some((l) => l.id === id));
    if (missing.length) throw new ToolError(`Shoot ${s.id} has no look ${missing.join(", ")} (it has ${s.looks.map((l) => l.id).join(", ")}).`);
    return s.looks.filter((l) => ids.includes(l.id));
  }
  return s.looks.filter((l) => l.status === "planned" || l.status === "waiting" || l.status === "failed");
}

function briefOf(l: LookT): LookBrief {
  const { source: _s, detailRefs: _d, style: _st, anchor: _a, ...brief } = l;
  return brief;
}

function showShoot(s: Shoot) {
  return {
    shoot: s.id,
    title: s.title,
    status: s.status,
    garment: s.garmentKey,
    persona: s.personaId,
    brief: s.brief,
    ...(s.liked !== null ? { liked: s.liked } : {}),
    ...(s.notes ? { notes: s.notes } : {}),
    looks: s.looks.map((l) => ({
      id: l.id,
      kind: l.brief.kind,
      status: l.status,
      chosen: l.chosen,
      ...(l.verdict ? { verdict: l.verdict } : {}),
      ...(l.error ? { error: l.error } : {}),
      attempts: l.attempts.map((a) => ({ ref: a.ref, at: ist(a.at), size: a.size, colours: a.colours, ...(a.verdict ? { verdict: a.verdict } : {}), ...(a.pruned ? { pruned: true } : {}) })),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* gather: the product's photos, from everywhere we have them                 */
/* -------------------------------------------------------------------------- */

interface Found {
  url?: string;
  ref?: string;
  view: string;
}

const ASIN = /^B0[A-Z0-9]{8}$/i;

type AmazonImages = { images?: { marketplaceId?: string; images?: { variant?: string; link?: string; width?: number; height?: number }[] }[] };

/** Every view Amazon's catalogue has for an ASIN (MAIN, PT01-PT08, ...), the largest of each. */
async function amazonImages(asin: string, notes: string[]): Promise<Found[]> {
  try {
    const account = await amazonAccount();
    const adapter = amazonAdapter(account);
    const res = await adapter.call<AmazonImages>("GET", `/catalog/2022-04-01/items/${asin}`, { query: { marketplaceIds: adapter.marketplace, includedData: "images" } });
    const best = new Map<string, { link: string; px: number }>();
    for (const group of res.images ?? []) {
      for (const im of group.images ?? []) {
        if (!im.link) continue;
        const variant = im.variant ?? "MAIN";
        const px = (im.width ?? 0) * (im.height ?? 0);
        if ((best.get(variant)?.px ?? -1) < px) best.set(variant, { link: im.link, px });
      }
    }
    const order = (v: string) => (v === "MAIN" ? "" : v);
    return [...best.entries()].sort((a, b) => order(a[0]).localeCompare(order(b[0]))).map(([variant, b]) => ({ url: b.link, view: `Amazon ${variant} (${asin})` }));
  } catch (err) {
    notes.push(`Amazon's catalogue for ${asin}: ${err instanceof Error ? err.message : String(err)}`);
    const rows = await db.select({ url: catalogImages.imageUrl }).from(catalogImages).where(eq(catalogImages.asin, asin));
    return rows.filter((r) => r.url).map((r) => ({ url: r.url!, view: `Amazon MAIN (${asin})` }));
  }
}

async function gather(a: P, ctx: ToolContext) {
  const found: Found[] = [];
  const notes: string[] = [];
  let name = a.name ?? null;
  let key = a.garment ?? null;

  if (a.product) {
    const p = a.product.trim();
    const match: SQL[] = [eq(products.sku, p), eq(channelListings.externalSku, p), eq(channelListings.externalId, p)];
    if (/^\d{1,9}$/.test(p)) match.push(eq(products.id, Number(p)));
    const [product] = await db
      .select({ id: products.id, sku: products.sku, name: products.name, image: products.imageUrl })
      .from(products)
      .leftJoin(channelListings, eq(channelListings.productId, products.id))
      .where(or(...match))
      .limit(1);
    let asins: string[] = [];
    if (product) {
      name ??= product.name;
      key ??= product.sku;
      if (product.image) found.push({ url: product.image, view: "OMS photo" });
      const listed = await db
        .select({ asin: channelListings.externalId })
        .from(channelListings)
        .innerJoin(channelAccounts, eq(channelAccounts.id, channelListings.channelAccountId))
        .where(and(eq(channelListings.productId, product.id), eq(channelAccounts.channel, "amazon")));
      asins = [...new Set(listed.map((r) => r.asin?.toUpperCase()).filter((x): x is string => !!x && ASIN.test(x)))];
    } else if (ASIN.test(p)) {
      asins = [p.toUpperCase()];
      key ??= p.toUpperCase();
    } else if (!a.store && !a.refs?.length) {
      throw new ToolError(`No OMS product matches ${p} (SKU, product id, Amazon seller SKU or ASIN).`);
    } else notes.push(`No OMS product matches ${p}.`);
    for (const asin of asins.slice(0, 3)) {
      ctx.progress(`Reading Amazon's photos of ${asin}…`);
      found.push(...(await amazonImages(asin, notes)));
    }
  }

  if (a.store) {
    if (!storeApiUrl()) notes.push("paribelle.in isn't connected, so its photos were skipped.");
    else {
      ctx.progress("Reading paribelle.in's photos…");
      const sp = await getProduct(a.store);
      name ??= sp.name;
      key ??= `store:${sp.slug}`;
      const urls = [...(sp.images ?? []), ...(sp.productVariants ?? []).flatMap((v) => v.images ?? [])].filter((u) => !isVideoUrl(u));
      for (const url of [...new Set(urls)]) found.push({ url, view: "paribelle.in" });
    }
  }
  for (const ref of a.refs ?? []) found.push({ ref, view: "given" });
  if (!found.length) throw new ToolError(`No photos found${notes.length ? ` (${notes.join("; ")})` : ""}. Give the product (SKU, ASIN), a paribelle.in product (store) or photos (refs).`);
  if (!key) throw new ToolError("Name the garment (garment: a short key like maroon-anarkali-set) when gathering from photos only.");

  const existing = await getGarment(key);
  const photos: GarmentPhoto[] = [...(existing?.photos ?? [])];
  for (const [i, f] of found.entries()) {
    ctx.progress(`Saving photo ${i + 1} of ${found.length}…`);
    try {
      if (f.url) {
        if (photos.some((p) => p.url === f.url)) continue;
        const { bytes, type } = await fetchPublic(f.url, ctx.signal, { maxBytes: 25 * 1024 * 1024, timeoutMs: 60_000 });
        if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new ToolError(`not a JPEG, PNG or WebP (${type || "unknown"})`);
        const row = await saveAsset({ bytes, mime: type, name: `${name ?? key}: ${f.view}`, source: "url", chatId: ctx.chatId, userId: ctx.user.id, meta: { url: f.url, garment: garmentKey(key) } });
        photos.push({ ref: `asset:${row.id}`, view: f.view, url: f.url });
      } else if (f.ref) {
        const ref = await keepRef(f.ref, ctx, `${name ?? key}: photo`);
        if (!photos.some((p) => p.ref === ref)) photos.push({ ref, view: f.view });
      }
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      notes.push(`${f.url?.slice(0, 100) ?? f.ref}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!photos.length) throw new ToolError(`None of the photos could be saved: ${notes.join("; ")}`);
  const garment = await saveGarment({ key, name: name ?? key, photos }, ctx.user.id);

  const images: ImageContent[] = [];
  const list = [];
  for (const p of garment.photos) {
    const asset = p.ref.startsWith("asset:") ? await getAsset(Number(p.ref.slice(6))) : null;
    list.push({ ref: p.ref, view: p.view, ...(p.note ? { note: p.note } : {}), ...(asset?.width ? { size: `${asset.width}x${asset.height}` } : {}) });
    if (images.length < 14) {
      try {
        images.push(jpegBlock(await toJpeg((await imageOf(p.ref, ctx)).bytes, 1024, 85)));
      } catch {
        // Listed without a picture.
      }
    }
  }
  return {
    text: [
      `${garment.name}: ${plural(garment.photos.length, "photo")}, shown in this order.${garment.spec ? " It already has a garment spec (show it with action show and garment)." : ""}`,
      "Study every one, zoom into the details (prints, borders, neckline, cuffs, embroidery), then save the spec: what the garment is, exactly, and which view each photo shows.",
      notes.length ? `Notes: ${notes.join("; ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    data: { garment: garment.key, name: garment.name, photos: list, ...(garment.spec ? { spec: garment.spec } : {}) },
    images,
  };
}

/* -------------------------------------------------------------------------- */
/* Shooting                                                                   */
/* -------------------------------------------------------------------------- */

/** References go at most this big: enough for print detail, small enough for 14 in one request. */
const REF_EDGE = 1536;

interface Original {
  photo: GarmentPhoto;
  raster: Raster;
  mask: Mask;
}

async function originalOf(g: Garment, ctx: ToolContext): Promise<Original> {
  const photo = mainPhoto(g);
  const raster = await rasterOf(photo.ref, ctx);
  const mask = await garmentMask(raster, undefined, { progress: ctx.progress, signal: ctx.signal });
  return { photo, raster, mask };
}

async function referenceParts(refs: { ref: string }[], ctx: ToolContext) {
  const parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] = [];
  for (const [i, r] of refs.entries()) {
    const img = await imageOf(r.ref, ctx);
    parts.push({ text: `Image ${i + 1}:` }, { inlineData: { mimeType: "image/jpeg", data: (await toJpeg(img.bytes, REF_EDGE, 90)).toString("base64") } });
  }
  return parts;
}

async function shoot(a: P, ctx: ToolContext) {
  // Unchosen attempts past their 30 days go first (before this shoot is read and rewritten).
  await pruneAttempts().catch((err) => console.error("[seelie] pruning shoot attempts", err));
  const s = await needShoot(a.shoot);
  const garment = await needGarment(s.garmentKey, { spec: true });
  const persona = s.personaId ? await getPersona(s.personaId) : null;
  const todo = looksToShoot(s, a.lookIds);
  if (!todo.length) throw new ToolError(`Shoot ${s.id} has nothing left to shoot (${s.looks.map((l) => `${l.id}: ${l.status}`).join(", ")}). Name lookIds to shoot a look again.`);

  const looks = s.looks;
  let writing: Promise<unknown> = Promise.resolve();
  const write = () => (writing = writing.then(() => updateShoot(s.id, { looks })));

  const budget = await imageBudget();
  if (budget.blockedUntil) {
    for (const l of todo) l.status = "waiting";
    await write();
    return {
      text: `The image limit is used up until about ${clock(budget.blockedUntil)} IST, so nothing was made: ${plural(todo.length, "look")} (${todo.map((l) => l.id).join(", ")}) wait in shoot ${s.id}. They stay waiting until the owner says to continue; then shoot again.`,
      data: { shoot: s.id, waiting: todo.map((l) => l.id), comesBack: ist(budget.blockedUntil) },
    };
  }

  const templates = templateVersion();
  const original = await originalOf(garment, ctx);
  let capped: CapError | null = null;
  const results: Record<string, unknown>[] = [];
  const images: ImageContent[] = [];

  async function one(look: ShootLook) {
    if (capped) {
      look.status = "waiting";
      return;
    }
    const size = a.size ?? look.brief.size ?? "2K";
    const aspect = look.brief.aspect ?? "3:4";
    const refs = lookRefs(look, garment, persona, anchorOf({ looks }, look.id));
    let prompt: string;
    try {
      prompt = renderLook({ look: look.brief, garment: { name: garment.name, spec: garment.spec!, hasBack: hasBack(garment) }, model: persona?.description ?? null, refs });
    } catch (err) {
      if (!(err instanceof PromptError)) throw err;
      look.status = "failed";
      look.error = err.message;
      results.push({ look: look.id, error: err.message });
      return;
    }
    look.status = "shooting";
    look.error = null;
    await write();
    ctx.progress(`Shooting ${look.id}…`);
    try {
      const parts = [...(await referenceParts(refs, ctx)), { text: prompt }];
      const made = await makeImage(
        {
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            imageConfig: { aspectRatio: aspect, imageSize: size },
            ...(look.brief.thinking === "high" ? { thinkingConfig: { thinkingLevel: "high" } } : {}),
          },
        },
        { chatId: ctx.chatId, shootId: s.id, look: look.id, size, aspect, refs: refs.length },
        ctx.signal,
      );
      const n = look.attempts.length + 1;
      const sent = refs.map((r) => ({ ref: r.ref, role: r.role }));
      const asset = await saveAsset({
        bytes: made.bytes,
        mime: made.mimeType,
        name: `${s.title}: ${look.id} ${n}`,
        source: "photoshoot",
        chatId: ctx.chatId,
        userId: ctx.user.id,
        meta: { shoot: s.id, look: look.id, attempt: n, prompt, templates, refs: sent, size, aspect, model: IMAGE_MODEL },
      });
      ctx.progress(`Checking ${look.id}…`);
      const result = await decode(made.bytes);
      const colours = colourCheck(original.raster, original.mask, result, await garmentMask(result, undefined, { progress: ctx.progress, signal: ctx.signal }));
      const attempt: Attempt = {
        ref: `asset:${asset.id}`,
        at: new Date().toISOString(),
        size,
        aspect,
        ms: made.ms,
        prompt,
        templates,
        refs: sent,
        colours: colours.note,
        mainDeltaE: colours.main,
        ...(made.text ? { said: made.text.slice(0, 500) } : {}),
      };
      look.attempts.push(attempt);
      look.status = "shot";
      await write();
      results.push({ look: look.id, attempt: n, ...assetSummary(asset), seconds: Math.round(made.ms / 1000), colours: colours.note, ...(made.text ? { modelSaid: made.text.slice(0, 300) } : {}) });
      if (images.length < 8) images.push(jpegBlock(await compareSheet(original.raster, result, [])));
    } catch (err) {
      if (err instanceof CapError) {
        capped ??= err;
        look.status = "waiting";
      } else if (ctx.signal.aborted) {
        look.status = "planned";
      } else {
        look.status = "failed";
        look.error = err instanceof Error ? err.message.slice(0, 500) : String(err);
        results.push({ look: look.id, error: look.error });
      }
      await write();
      if (ctx.signal.aborted) throw err;
    }
  }

  const queue = [...todo];
  // makeImage lets two calls run at once; two workers keep both slots busy.
  await Promise.all([0, 1].map(async () => {
    for (let look = queue.shift(); look; look = queue.shift()) await one(look);
  }));
  for (const l of todo) if (l.status === "shooting") l.status = "planned";
  await write();
  await writing;

  const waiting = looks.filter((l) => l.status === "waiting");
  const after = await imageBudget();
  const cap = capped as CapError | null;
  return {
    text: [
      results.some((r) => r.ref)
        ? `Each result is shown as a compare sheet: our main photo (${original.photo.ref}, ${original.photo.view}) left, the result right, in the order listed. Judge it against the garment spec: colour, every motif's size and placement, embroidery, neckline, sleeves and cuffs, length and hem, flare, the dupatta and its border, bottoms, anything added or missing. Zoom with check (details); fix colour drift with photo_edit colour_match and small defects with photo_edit remove (both free); shoot again only for a wrong garment detail (plan the look again with corrections and detailRefs). Then choose.`
        : "",
      cap
        ? `${cap.message} ${plural(waiting.length, "look")} (${waiting.map((l) => l.id).join(", ")}) wait in shoot ${s.id}${cap.resetAt ? `; it comes back at about ${clock(cap.resetAt)} IST` : ""}. They stay waiting until the owner says to continue; then shoot again.`
        : "",
      fmtBudget(after),
    ]
      .filter(Boolean)
      .join("\n"),
    data: { shoot: s.id, results, ...(waiting.length ? { waiting: waiting.map((l) => l.id) } : {}) },
    images,
    error: results.length > 0 && results.every((r) => r.error) && !cap,
  };
}

/* -------------------------------------------------------------------------- */
/* plan                                                                       */
/* -------------------------------------------------------------------------- */

async function lookFrom(l: LookT, prev: ShootLook | undefined, ctx: ToolContext): Promise<ShootLook> {
  if (l.kind === "recast" && !l.source) throw new ToolError(`Look ${l.id}: a recast needs its source photo (source).`);
  const refs: LookRef[] = [];
  if (l.source) refs.push({ ref: await keepRef(l.source, ctx), role: "source" });
  for (const d of l.detailRefs ?? []) refs.push({ ref: await keepRef(d.ref, ctx), role: "detail", ...(d.note ? { note: d.note } : {}) });
  for (const st of l.style ?? []) refs.push({ ref: await keepRef(st, ctx), role: "style" });
  return {
    id: l.id,
    brief: briefOf(l),
    refs,
    anchor: l.anchor ?? true,
    status: "planned",
    attempts: prev?.attempts ?? [],
    chosen: prev?.chosen ?? null,
    verdict: prev?.verdict ?? null,
    error: null,
  };
}

async function plan(a: P, ctx: ToolContext) {
  const prev = a.shoot ? await needShoot(a.shoot) : null;
  const garment = await needGarment(a.garment ?? prev?.garmentKey, { spec: true });
  const personaId = a.persona ?? prev?.personaId ?? null;
  const persona = personaId ? await getPersona(personaId) : null;
  if (personaId && !persona) throw new ToolError(`There's no persona ${personaId} (cast list shows them).`);
  if (!a.looks?.length && !prev) throw new ToolError("Which looks? (looks: one entry per picture)");

  const ids = (a.looks ?? []).map((l) => l.id);
  if (new Set(ids).size !== ids.length) throw new ToolError("Two looks have the same id.");
  const looks: ShootLook[] = [...(prev?.looks ?? [])];
  for (const l of a.looks ?? []) {
    const i = looks.findIndex((x) => x.id === l.id);
    const next = await lookFrom(l, i >= 0 ? looks[i] : undefined, ctx);
    if (i >= 0) looks[i] = next;
    else looks.push(next);
  }

  const prompts = [];
  for (const look of looks.filter((l) => !a.looks?.length || ids.includes(l.id))) {
    const refs = lookRefs(look, garment, persona, anchorOf({ looks }, look.id));
    try {
      const prompt = renderLook({ look: look.brief, garment: { name: garment.name, spec: garment.spec!, hasBack: hasBack(garment) }, model: persona?.description ?? null, refs });
      prompts.push({ look: lookLine(look), images: refs.map((r, i) => `${i + 1} ${r.role}${r.view ? ` (${r.view})` : ""}: ${r.ref}`), prompt });
    } catch (err) {
      if (err instanceof PromptError) throw new ToolError(`Look ${look.id}: ${err.message}`);
      throw err;
    }
  }

  const s = prev
    ? await updateShoot(prev.id, { looks, personaId, ...(a.title ? { title: a.title } : {}), ...(a.brief ? { brief: a.brief } : {}) })
    : await createShoot({ chatId: ctx.chatId, userId: ctx.user.id, title: a.title ?? `${garment.name} shoot`, garmentKey: garment.key, personaId, brief: a.brief ?? null, looks });
  const toShoot = looksToShoot(s, undefined);
  const budget = await imageBudget();
  const worn = looks.filter((l) => isWorn(l.brief));
  return {
    text: [
      `Shoot ${s.id} "${s.title}": ${plural(toShoot.length, "look")} to shoot, one image each (${toShoot.map(lookLine).join(", ")}).`,
      fmtBudget(budget),
      !persona && worn.length > 1 && !worn.some((l) => l.chosen)
        ? "No persona: the model's face may differ between looks. Shoot the hero first, choose it, and the other worn looks use it as their anchor; or cast a persona."
        : "",
      "Read every prompt before shooting; plan again with the same look id to change one. shoot asks the owner first, showing the looks and their cost.",
    ]
      .filter(Boolean)
      .join("\n"),
    data: { shoot: s.id, persona: persona ? { id: persona.id, name: persona.name } : null, prompts },
  };
}

/* -------------------------------------------------------------------------- */
/* check, choose                                                              */
/* -------------------------------------------------------------------------- */

async function check(a: P, ctx: ToolContext) {
  if (!a.result) throw new ToolError("Which picture? (result: its ref)");
  const s = a.shoot ? await needShoot(a.shoot) : null;
  const garment = a.garment || s?.garmentKey ? await needGarment(a.garment ?? s?.garmentKey) : null;
  const originalRef = a.original ?? (garment ? mainPhoto(garment).ref : null);
  if (!originalRef) throw new ToolError("Compare with which photo? (original, or the garment/shoot it belongs to)");

  ctx.progress("Reading both pictures…");
  const [original, result] = await Promise.all([rasterOf(originalRef, ctx), rasterOf(a.result, ctx)]);
  const opts = { progress: ctx.progress, signal: ctx.signal };
  const colours = colourCheck(original, await garmentMask(original, a.garmentBox?.original, opts), result, await garmentMask(result, a.garmentBox?.result, opts));
  const pairs: DetailPair[] = [];
  for (const d of a.details ?? []) {
    const from = d.originalRef && d.originalRef !== originalRef ? await rasterOf(d.originalRef, ctx) : original;
    pairs.push({ name: d.name, original: detailCrop(from, d.original), result: detailCrop(result, d.result) });
  }
  const sheet = await compareSheet(original, result, pairs);

  let recorded = false;
  if (s && a.look && a.verdict) {
    const look = s.looks.find((l) => l.id === a.look);
    const attempt = look?.attempts.find((x) => x.ref === a.result);
    if (attempt) {
      attempt.verdict = a.verdict;
      await updateShoot(s.id, { looks: s.looks });
      recorded = true;
    }
  }
  return {
    text: [
      `Compare sheet: ${originalRef} left, ${a.result} right${pairs.length ? `; then ${pairs.map((p, i) => `row ${i + 2}: ${p.name}`).join(", ")} (ours left)` : ""}.`,
      `Colours (garment${a.garmentBox ? " in the boxes" : ": the subject, so skin and hair count too; give garmentBox for the garment alone"}): ${colours.note}.`,
      recorded ? "Verdict saved on that attempt." : "",
    ]
      .filter(Boolean)
      .join("\n"),
    data: { colours: colours.matches.map((m) => ({ original: m.original.hex, share: m.original.share, result: m.result?.hex ?? null, deltaE: m.deltaE, verdict: m.verdict })) },
    images: [jpegBlock(sheet)],
  };
}

async function choose(a: P, ctx: ToolContext) {
  const s = await needShoot(a.shoot);
  const look = s.looks.find((l) => l.id === a.look);
  if (!look) throw new ToolError(`Which look of shoot ${s.id}? (${s.looks.map((l) => l.id).join(", ")})`);
  if (!a.result) throw new ToolError("Which picture? (result: an attempt's ref, or a photo_edit fix of it)");
  const ref = await keepRef(a.result, ctx);
  look.chosen = ref;
  look.verdict = a.verdict ?? look.verdict;
  look.status = "done";
  const attempt = look.attempts.find((x) => x.ref === ref);
  if (attempt && a.verdict) attempt.verdict = a.verdict;
  const next = await updateShoot(s.id, { looks: s.looks });
  const open = next.looks.filter((l) => l.status !== "done");
  return {
    text: `${look.id} is ${ref}.${open.length ? ` Still open: ${open.map((l) => `${l.id} (${l.status})`).join(", ")}.` : " Every look is chosen: the shoot is done."}`,
    data: showShoot(next),
  };
}

/* -------------------------------------------------------------------------- */
/* cast: personas                                                             */
/* -------------------------------------------------------------------------- */

async function cast(a: P, ctx: ToolContext) {
  switch (a.cast ?? "list") {
    case "list": {
      const all = await listPersonas();
      const used = await shootsWithPersonas(all.map((p) => p.id));
      const images: ImageContent[] = [];
      for (const p of all.slice(0, 8)) {
        if (!p.refs[0]) continue;
        try {
          images.push(jpegBlock(await toJpeg((await imageOf(`asset:${p.refs[0]}`, ctx)).bytes, 512, 85)));
        } catch {
          // Listed without a picture.
        }
      }
      return {
        text: all.length ? `Faces shown in order (the first ${Math.min(8, all.length)}).` : "No personas yet: cast one (sheet makes a model sheet; save keeps crops of a chosen look).",
        data: all.map((p) => ({ persona: p.id, name: p.name, description: p.description, refs: p.refs.map((id) => `asset:${id}`), notes: p.notes, shoots: used.get(p.id) ?? 0 })),
        images,
      };
    }
    case "save": {
      const prev = a.persona ? await getPersona(a.persona) : null;
      if (a.persona && !prev) throw new ToolError(`There's no persona ${a.persona}.`);
      const name = a.name ?? prev?.name;
      const description = a.description ?? prev?.description;
      if (!name || !description) throw new ToolError("A persona needs a name and a description (age, look, hair, build).");
      let refs = prev?.refs ?? [];
      if (a.pictures?.length) {
        refs = [];
        for (const [i, pic] of a.pictures.entries()) {
          if (!pic.box) {
            const ref = await keepRef(pic.ref, ctx, `${name}: reference ${i + 1}`);
            refs.push(Number(ref.slice(6)));
            continue;
          }
          const r = await rasterOf(pic.ref, ctx);
          const b = pic.box;
          const part = crop(r, b.x * r.w, b.y * r.h, Math.max(16, b.w * r.w), Math.max(16, b.h * r.h));
          const row = await saveAsset({
            bytes: await preview(part, 2048, 92),
            mime: "image/jpeg",
            name: `${name}: reference ${i + 1}`,
            source: "edited",
            chatId: ctx.chatId,
            userId: ctx.user.id,
            meta: { from: pic.ref, box: b, persona: name },
          });
          refs.push(row.id);
        }
      }
      if (!refs.length) throw new ToolError("A persona needs pictures: the face first, then full length (pictures with boxes to crop them).");
      const p = await savePersona({ id: prev?.id, name, description, refs, notes: a.notes ?? prev?.notes ?? null });
      return { text: `Persona ${p.id} saved; use it with plan (persona: ${p.id}).`, data: { persona: p.id, name: p.name, refs: p.refs.map((id) => `asset:${id}`) } };
    }
    case "remove": {
      if (!a.persona) throw new ToolError("Which persona? (persona: its id)");
      if (!(await removePersona(a.persona))) throw new ToolError(`There's no persona ${a.persona}.`);
      return { text: `Persona ${a.persona} removed (its pictures stay in the media).` };
    }
    case "sheet": {
      if (!a.description) throw new ToolError("Describe her (description: age, look, hair, build).");
      let prompt: string;
      try {
        prompt = renderPersona({ description: a.description, direction: a.brief });
      } catch (err) {
        if (err instanceof PromptError) throw new ToolError(err.message);
        throw err;
      }
      const size = a.size ?? "2K";
      ctx.progress("Making the model sheet…");
      let made;
      try {
        made = await makeImage(
          { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "4:3", imageSize: size } } },
          { chatId: ctx.chatId, look: "persona sheet", size, aspect: "4:3", refs: 0 },
          ctx.signal,
        );
      } catch (err) {
        if (err instanceof CapError) throw new ToolError(`${err.message}${err.resetAt ? ` It comes back at about ${clock(err.resetAt)} IST.` : ""}`);
        throw err;
      }
      const row = await saveAsset({
        bytes: made.bytes,
        mime: made.mimeType,
        name: `${a.name ?? "Model"} sheet`,
        source: "photoshoot",
        chatId: ctx.chatId,
        userId: ctx.user.id,
        meta: { persona: a.name ?? null, prompt, templates: templateVersion(), size, model: IMAGE_MODEL },
      });
      const r = await decode(made.bytes);
      return {
        text: `Model sheet ${`asset:${row.id}`}: the face should be left, the full length right. If she is right, save her with cast save (name, description, pictures: this ref with a box around the face, then one around the full length).\n${fmtBudget(await imageBudget())}`,
        data: assetSummary(row),
        images: [jpegBlock(await preview(r, 1536, 88))],
      };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The tool                                                                   */
/* -------------------------------------------------------------------------- */

async function shootSummary(a: P) {
  const s = a.shoot ? await getShoot(a.shoot) : null;
  if (!s) return `Shoot ${a.shoot ?? "?"}`;
  const looks = looksToShoot(s, a.lookIds);
  const b = await imageBudget().catch(() => null);
  const left = !b ? "" : b.blockedUntil ? `; none left until about ${clock(b.blockedUntil)} IST, so they'd wait` : `; about ${b.left} of ~${b.capacity} left${b.left < looks.length ? `, so ${looks.length - b.left} would wait` : ""}`;
  return `${s.title}: ${plural(looks.length, "image")}${left}. ${looks.map((l) => (a.size ? lookLine({ ...l, brief: { ...l.brief, size: a.size } }) : lookLine(l))).join(", ")}`;
}

export const photoshoot = defineTool({
  name: "photoshoot",
  label: "Photoshoot",
  description: [
    "Product photoshoots with the image model (Gemini 3.1 Flash Image): the ONLY way to make new pictures, so the only tool that spends the image budget (about 9 images per ~5 h per account; budget shows it).",
    "Everything else is free code. Order: gather -> zoom -> spec -> plan -> shoot -> check -> fix (photo_edit) or retake -> choose.",
    "gather: every photo of the product as assets: product (OMS SKU, product id, Amazon seller SKU or ASIN: the OMS photo and every Amazon catalogue view), store (paribelle.in product), refs (chat:/asset: photos); garment names it (default the SKU). Shows them all.",
    "zoom: crops (ref + box) shown large, saved nowhere: look closely at prints, borders, embroidery, neckline, cuffs.",
    "spec: the garment spec, written once after studying every photo (summary: pieces, fabric, colours, each motif with its size and placement, neckline, sleeves, length, flare, dupatta, bottoms; keep: the details that must survive, one each; colours as seen in daylight; hasDupatta) and views (ref + what it shows: front, back, side, detail, worn, mirror selfie, flat). No back photo = no back view is ever made.",
    "plan (free): a shoot's looks; renders each prompt from the templates and lists the images sent with their roles. Look: id, kind (on-model | flat-lay | ghost | detail | recast), change (recast: model | remove-phone | to-on-model | to-flat-lay | setting) + source,",
    "framing, fullLength, angle, pose, expression, detail (detail looks), setting, light, camera, styling, mood, aspect (default 3:4), size (1K | 2K default | 4K), thinking (high for hard ones), direction (the owner's words, verbatim), corrections (for a retake),",
    "detailRefs (close-up crops to copy exactly), style (mood images), anchor (default true: later worn looks match the set's first chosen worn look), brand (false drops PariBelle's look). persona: a persona id. Plan again with the same shoot and look id to change a look.",
    "shoot: makes the shoot's planned/waiting/failed looks (or lookIds), one image each, two at a time; ALWAYS asks the owner first (the card shows the looks and what they cost). Each result is checked against our main photo (compare sheet + ΔE00).",
    "If the limit runs out, the rest wait in the shoot until the owner says continue (then shoot again). check (free): a compare sheet of any result against the original with zoomed detail pairs (details: name + box on each) and the garment's colours (garmentBox: the garment alone); verdict saves your judgement on that attempt.",
    "choose: the picture a look keeps (an attempt, or the photo_edit fix of one), with its verdict. cast: personas (recurring models): list | save (name, description, pictures: face first then full length, boxes crop them) | sheet (a new model sheet from description: costs 1 image, asks) | remove.",
    "budget: images left, when it comes back, looks waiting. show: a shoot (shoot) or a garment (garment), or recent shoots. feedback: the owner's verdict on a shoot (liked, notes).",
  ].join(" "),
  parameters: Params,
  kind: (a) => (a.action === "shoot" || (a.action === "cast" && a.cast === "sheet") ? "spend" : a.action === "cast" && a.cast === "remove" ? "write" : "read"),
  summary: (a) => {
    switch (a.action) {
      case "shoot":
        return shootSummary(a);
      case "cast":
        return a.cast === "sheet" ? `New model sheet: 1 image${a.name ? ` (${a.name})` : ""}` : `Personas: ${a.cast ?? "list"}${a.persona ? ` ${a.persona}` : ""}`;
      case "gather":
        return `Photos of ${[a.product, a.store && `store ${a.store}`, a.refs?.length && plural(a.refs.length, "photo")].filter(Boolean).join(", ") || a.garment || "?"}`;
      case "plan":
        return `Plan ${a.shoot ? `shoot ${a.shoot}` : (a.title ?? a.garment ?? "a shoot")}${a.looks?.length ? `: ${a.looks.map((l) => l.id).join(", ")}` : ""}`;
      default:
        return [a.action, a.shoot && `shoot ${a.shoot}`, a.look, a.garment].filter(Boolean).join(" · ");
    }
  },
  async execute(a, ctx) {
    try {
      switch (a.action) {
        case "gather":
          return await gather(a, ctx);
        case "zoom": {
          if (!a.crops?.length) throw new ToolError("What to zoom into? (crops: ref + box)");
          const images: ImageContent[] = [];
          for (const c of a.crops) {
            const r = await rasterOf(c.ref, ctx);
            images.push(jpegBlock(await preview(detailCrop(r, c.box), 1280, 90)));
          }
          return { text: `${plural(images.length, "crop")}, in order.`, images };
        }
        case "spec": {
          const g = await needGarment(a.garment);
          const photos = [...g.photos];
          for (const v of a.views ?? []) {
            const ref = await keepRef(v.ref, ctx);
            const i = photos.findIndex((p) => p.ref === ref);
            const next = { ...(i >= 0 ? photos[i] : { ref }), view: v.view.trim(), ...(v.note ? { note: v.note } : {}) };
            if (i >= 0) photos[i] = next;
            else photos.push(next);
          }
          if (!a.spec && !a.views?.length) throw new ToolError("Nothing to save: give spec and/or views.");
          const saved = await saveGarment({ key: g.key, name: a.name ?? g.name, spec: a.spec ?? g.spec, photos }, ctx.user.id);
          return {
            text: `${saved.name} saved${saved.spec ? "" : " (still no spec)"}; ${hasBack(saved) ? "it has a back view" : "no back photo, so no back views"}.`,
            data: { garment: saved.key, photos: saved.photos.map((p) => ({ ref: p.ref, view: p.view })) },
          };
        }
        case "plan":
          return await plan(a, ctx);
        case "shoot":
          return await shoot(a, ctx);
        case "check":
          return await check(a, ctx);
        case "choose":
          return await choose(a, ctx);
        case "cast":
          return await cast(a, ctx);
        case "budget": {
          const [b, waiting] = await Promise.all([imageBudget(), waitingShoots()]);
          return {
            text: fmtBudget(b),
            data: {
              left: b.left,
              capacity: b.capacity,
              accounts: b.accounts,
              usedThisWindow: b.used,
              blockedUntil: ist(b.blockedUntil),
              freesUpAt: ist(b.resetAt),
              waiting: waiting.map((s) => ({ shoot: s.id, title: s.title, looks: s.looks.filter((l) => l.status === "waiting").map((l) => l.id) })),
            },
          };
        }
        case "show": {
          if (a.shoot) return { data: showShoot(await needShoot(a.shoot)) };
          if (a.garment) {
            const g = await needGarment(a.garment);
            return { data: { garment: g.key, name: g.name, spec: g.spec, photos: g.photos, hasBack: hasBack(g), updated: ist(g.updatedAt) } };
          }
          const list = await recentShoots(20);
          return {
            data: list.map((s) => ({
              shoot: s.id,
              title: s.title,
              status: s.status,
              garment: s.garmentKey,
              looks: s.looks.length,
              chosen: s.looks.filter((l) => l.chosen).length,
              updated: ist(s.updatedAt),
            })),
          };
        }
        case "feedback": {
          const s = await needShoot(a.shoot);
          if (a.liked === undefined && !a.notes) throw new ToolError("What did the owner say? (liked, notes)");
          await updateShoot(s.id, { ...(a.liked !== undefined ? { liked: a.liked } : {}), ...(a.notes ? { notes: a.notes } : {}) });
          return { text: "Saved; later shoots learn from it." };
        }
      }
    } catch (err) {
      if (err instanceof MediaError) throw new ToolError(err.message);
      throw err;
    }
  },
});
