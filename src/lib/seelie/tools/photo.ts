import "server-only";

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Type, type ImageContent, type Static } from "@paribelle/pi-ai";

import { subjectMask } from "../media/cutout";
import { assetSummary, mediaFolder, MediaError, saveAsset, type AssetRow } from "../media/files";
import { REF_PATTERN, resolveRef } from "../media/refs";
import { renderStill } from "../media/render";
import { compareColours, matchColour, palette, rgbToLab, deltaE2000 } from "../studio/colour";
import {
  aspectBox,
  backdrop,
  borderColour,
  catalogueWhite,
  compose,
  defringe,
  extend,
  fit,
  grade,
  light,
  loadLut,
  padTo,
  perspective,
  smoothSkin,
  straighten,
  turn,
  whiteCheck,
  type Grade,
  type Layer,
  type Padding,
  type Point,
  type RGB,
  type TextBlock,
} from "../studio/edit";
import { inpaint } from "../studio/inpaint";
import {
  alphaMask,
  blank,
  blend,
  boxMask,
  coverage,
  crop,
  decode,
  emptyMask,
  encode,
  feather,
  grow,
  hasAlpha,
  intersect,
  invert,
  maskBox,
  maskFromImage,
  maskImage,
  parseColour,
  polygonMask,
  preview,
  resizeMask,
  toCanvas,
  union,
  withAlpha,
  type Format,
  type Mask,
  type Raster,
} from "../studio/raster";
import { select } from "../studio/select";
import { getSpec, listSpecs, removeSpec, saveSpec } from "../studio/specs";
import { MAX_UPSCALE_INPUT, upscale } from "../studio/upscale";
import { removeWatermark } from "../studio/watermark";
import { publicHttps } from "./images";
import { defineTool, ToolError, type ToolContext } from "./types";
import { optional, plural, StringEnum, todayIst } from "./util";

/* -------------------------------------------------------------------------- */
/* Shared                                                                     */
/* -------------------------------------------------------------------------- */

export const jpegBlock = (bytes: Buffer): ImageContent => ({ type: "image", data: bytes.toString("base64"), mimeType: "image/jpeg" });

/** An image ref's name and bytes; clips and sounds are refused. */
export async function imageOf(ref: string, ctx: Pick<ToolContext, "chatImages">) {
  const r = ref.trim();
  if (!REF_PATTERN.test(r)) throw new ToolError(`"${ref}" isn't an image ref (chat:<n> or asset:<id>).`);
  const m = await resolveRef(r, { chatImages: ctx.chatImages, workDir: await mediaFolder("cache") });
  if (m.kind !== "image") throw new ToolError(`${r} isn't an image${m.kind === "video" ? " (video_assets save_frame keeps a still from a clip)" : ""}.`);
  return { ref: r, name: m.name, bytes: await readFile(m.file) };
}

const MIME: Record<Format, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** A picture as a file: `format`, at `quality`, brought under `maxBytes` (JPEG/WebP) by lowering the quality. */
export async function toFile(r: Raster, format: Format, quality: number, maxBytes?: number): Promise<{ bytes: Buffer; quality: number; over: boolean }> {
  let q = quality;
  let bytes = await encode(r, format, q);
  // Not below 60: past that JPEG falls apart, so the caller hears it's still over instead.
  while (maxBytes && bytes.length > maxBytes && format !== "png" && q > 60) {
    q = Math.max(60, q - 4);
    bytes = await encode(r, format, q);
  }
  return { bytes, quality: q, over: !!maxBytes && bytes.length > maxBytes };
}

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

/* -------------------------------------------------------------------------- */
/* photo_edit: the parameters                                                 */
/* -------------------------------------------------------------------------- */

const Frac = Type.Number({ minimum: 0, maximum: 1 });
const Pt = Type.Object({ x: Frac, y: Frac });
const BoxT = Type.Object({ x: Frac, y: Frac, w: Frac, h: Frac });
const ASPECT = Type.String({ pattern: "^\\d+(\\.\\d+)?:\\d+(\\.\\d+)?$", description: "w:h, e.g. 4:5" });
const MASK_TYPES = ["subject", "select", "box", "ellipse", "polygon", "colour", "asset", "all"] as const;

const MaskSpec = Type.Object({
  name: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,31}$" }),
  type: StringEnum(MASK_TYPES),
  points: optional(Type.Array(Type.Object({ x: Frac, y: Frac, on: optional(Type.Boolean()) }), { maxItems: 16 })),
  box: optional(BoxT),
  polygon: optional(Type.Array(Pt, { minItems: 3, maxItems: 200 })),
  colour: optional(Type.String()),
  at: optional(Pt),
  tolerance: optional(Type.Number({ minimum: 1, maximum: 60 })),
  ref: optional(Type.String()),
  within: optional(Type.String()),
  plus: optional(Type.Array(Type.String(), { maxItems: 8 })),
  minus: optional(Type.Array(Type.String(), { maxItems: 8 })),
  invert: optional(Type.Boolean()),
  grow: optional(Type.Number({ minimum: -300, maximum: 300 })),
  feather: optional(Type.Number({ minimum: 0, maximum: 300 })),
});
type MaskSpecT = Static<typeof MaskSpec>;

const OPS = [
  "cutout",
  "background",
  "white",
  "fit",
  "crop",
  "extend",
  "rotate",
  "perspective",
  "grade",
  "light",
  "remove",
  "smooth",
  "colour_match",
  "watermark",
  "upscale",
  "compose",
  "ffmpeg",
  "canvas",
] as const;

const Signed = Type.Number({ minimum: -1, maximum: 1 });

const Step = Type.Object({
  op: StringEnum(OPS),
  mask: optional(Type.String()),
  strength: optional(Frac),
  // background / extend / canvas
  fill: optional(StringEnum(["colour", "gradient", "sweep", "blur", "image", "mirror", "edge", "inpaint"])),
  colour: optional(Type.String()),
  colour2: optional(Type.String()),
  angle: optional(Type.Number({ minimum: -360, maximum: 360 })),
  blur: optional(Type.Number({ minimum: 0, maximum: 400 })),
  shadow: optional(Frac),
  ref: optional(Type.String()),
  // white / fit / canvas
  width: optional(Type.Integer({ minimum: 16, maximum: 8192 })),
  height: optional(Type.Integer({ minimum: 16, maximum: 8192 })),
  share: optional(Type.Number({ minimum: 0.3, maximum: 1 })),
  preset: optional(Type.String()),
  mode: optional(StringEnum(["cover", "pad", "stretch"])),
  focus: optional(Pt),
  // crop / extend
  box: optional(BoxT),
  aspect: optional(ASPECT),
  padding: optional(Type.Object({ top: optional(Type.Number({ minimum: 0, maximum: 3 })), right: optional(Type.Number({ minimum: 0, maximum: 3 })), bottom: optional(Type.Number({ minimum: 0, maximum: 3 })), left: optional(Type.Number({ minimum: 0, maximum: 3 })) })),
  anchor: optional(StringEnum(["centre", "top", "bottom", "left", "right"])),
  // rotate / perspective
  degrees: optional(Type.Number({ minimum: -360, maximum: 360 })),
  flip: optional(StringEnum(["horizontal", "vertical"])),
  corners: optional(Type.Array(Pt, { minItems: 4, maxItems: 4 })),
  // grade
  exposure: optional(Type.Number({ minimum: -3, maximum: 3 })),
  contrast: optional(Signed),
  highlights: optional(Signed),
  shadows: optional(Signed),
  temperature: optional(Signed),
  tint: optional(Signed),
  neutral: optional(Pt),
  saturation: optional(Signed),
  vibrance: optional(Signed),
  curve: optional(Type.Array(Type.Array(Type.Number({ minimum: 0, maximum: 255 }), { minItems: 2, maxItems: 2 }), { minItems: 2, maxItems: 16 })),
  lut: optional(Type.String()),
  clarity: optional(Signed),
  sharpen: optional(Type.Number({ minimum: 0, maximum: 2 })),
  vignette: optional(Signed),
  grain: optional(Frac),
  // light
  centre: optional(Pt),
  radius: optional(Type.Number({ minimum: 0.02, maximum: 2 })),
  from: optional(Pt),
  to: optional(Pt),
  warmth: optional(Signed),
  // smooth
  amount: optional(Frac),
  // colour_match
  refMask: optional(Type.Object({ type: StringEnum(["subject", "select", "box", "all"]), points: optional(Type.Array(Type.Object({ x: Frac, y: Frac, on: optional(Type.Boolean()) }), { maxItems: 16 })), box: optional(BoxT) })),
  keepLightness: optional(Type.Boolean()),
  // upscale
  factor: optional(Type.Integer({ minimum: 2, maximum: 4 })),
  // cutout
  trim: optional(Type.Boolean()),
  // compose
  layers: optional(
    Type.Array(
      Type.Object({
        ref: Type.String(),
        x: Type.Number({ minimum: -1, maximum: 2 }),
        y: Type.Number({ minimum: -1, maximum: 2 }),
        width: Type.Number({ minimum: 0.01, maximum: 3 }),
        cutout: optional(Type.Boolean()),
        opacity: optional(Frac),
        rotate: optional(Type.Number({ minimum: -360, maximum: 360 })),
        shadow: optional(Frac),
      }),
      { maxItems: 12 },
    ),
  ),
  texts: optional(
    Type.Array(
      Type.Object({
        text: Type.String({ minLength: 1, maxLength: 400 }),
        x: Frac,
        y: Frac,
        size: Type.Number({ minimum: 0.005, maximum: 0.5 }),
        colour: Type.String(),
        font: Type.String(),
        align: optional(StringEnum(["left", "centre", "right"])),
        maxWidth: optional(Type.Number({ minimum: 0.05, maximum: 1 })),
        background: optional(Type.String()),
        shadow: optional(Type.Boolean()),
      }),
      { maxItems: 12 },
    ),
  ),
  // ffmpeg
  graph: optional(Type.String({ maxLength: 20_000 })),
  inputs: optional(Type.Array(Type.String(), { maxItems: 8 })),
});
type StepT = Static<typeof Step>;

/* -------------------------------------------------------------------------- */
/* photo_edit: running it                                                     */
/* -------------------------------------------------------------------------- */

interface Run {
  ctx: ToolContext;
  specs: Map<string, MaskSpecT>;
  /** Masks worked out for each state of the picture. */
  cache: WeakMap<Raster, Map<string, Promise<Mask>>>;
  notes: string[];
  /** Output defaults a preset set (format, size limit). */
  output: { format?: Format; maxBytes?: number };
  progress: (text: string) => void;
}

const toPx = (r: Raster, p: { x: number; y: number }): Point => ({ x: p.x * r.w, y: p.y * r.h });
const boxPx = (r: Raster, b: { x: number; y: number; w: number; h: number }) => ({ x: b.x * r.w, y: b.y * r.h, w: b.w * r.w, h: b.h * r.h });

function colourOf(text: string | undefined, fallback?: RGB): RGB | undefined {
  if (!text) return fallback;
  return parseColour(text);
}

/** The subject: the picture's own transparency when it has some (a cut-out), else BiRefNet. */
async function subjectOf(r: Raster, run: Run): Promise<Mask> {
  if (hasAlpha(r)) {
    const a = alphaMask(r);
    if (coverage(a) < 0.98) return a;
  }
  const a = await subjectMask(await toCanvas(r), r.w, r.h, { progress: run.progress, signal: run.ctx.signal });
  return { w: r.w, h: r.h, a };
}

/** Pixels within `tolerance` ΔE00 of a colour (soft out to 1.5x), looked up per 5-bit colour cell. */
function colourMask(r: Raster, target: RGB, tolerance: number): Mask {
  const lab = rgbToLab(...target);
  const table = new Float32Array(32 * 32 * 32).fill(-1);
  const m = emptyMask(r.w, r.h);
  for (let i = 0; i < m.a.length; i++) {
    const p = i * 4;
    const key = ((r.data[p] >> 3) << 10) | ((r.data[p + 1] >> 3) << 5) | (r.data[p + 2] >> 3);
    let d = table[key];
    if (d < 0) {
      d = deltaE2000(lab, rgbToLab((r.data[p] & 0xf8) + 4, (r.data[p + 1] & 0xf8) + 4, (r.data[p + 2] & 0xf8) + 4));
      table[key] = d;
    }
    m.a[i] = d <= tolerance ? 255 : d >= tolerance * 1.5 ? 0 : Math.round((1 - (d - tolerance) / (tolerance * 0.5)) * 255);
  }
  return m;
}

async function buildMask(spec: MaskSpecT, r: Raster, run: Run, depth: number): Promise<Mask> {
  let m: Mask;
  switch (spec.type) {
    case "subject":
      m = await subjectOf(r, run);
      break;
    case "all":
      m = emptyMask(r.w, r.h, 255);
      break;
    case "box":
    case "ellipse": {
      if (!spec.box) throw new ToolError(`Mask ${spec.name}: a ${spec.type} needs box.`);
      const b = boxPx(r, spec.box);
      if (spec.type === "box") m = boxMask(r.w, r.h, b);
      else {
        m = emptyMask(r.w, r.h);
        const cx = b.x + b.w / 2;
        const cy = b.y + b.h / 2;
        for (let y = Math.max(0, Math.floor(b.y)); y < Math.min(r.h, Math.ceil(b.y + b.h)); y++) {
          for (let x = Math.max(0, Math.floor(b.x)); x < Math.min(r.w, Math.ceil(b.x + b.w)); x++) {
            if (((x + 0.5 - cx) / (b.w / 2)) ** 2 + ((y + 0.5 - cy) / (b.h / 2)) ** 2 <= 1) m.a[y * r.w + x] = 255;
          }
        }
      }
      break;
    }
    case "polygon":
      if (!spec.polygon) throw new ToolError(`Mask ${spec.name}: a polygon needs polygon points.`);
      m = await polygonMask(
        r.w,
        r.h,
        spec.polygon.map((p) => [p.x * r.w, p.y * r.h]),
      );
      break;
    case "select": {
      if (!spec.points?.length && !spec.box) throw new ToolError(`Mask ${spec.name}: select needs points on the thing (and/or a box around it).`);
      const res = await select(
        r,
        { points: spec.points?.map((p) => ({ ...toPx(r, p), on: p.on !== false })), box: spec.box ? boxPx(r, spec.box) : undefined },
        { progress: run.progress, signal: run.ctx.signal },
      );
      run.notes.push(`mask ${spec.name}: selected ${Math.round(coverage(res.mask) * 100)}% of the picture (model sure ${res.score})`);
      m = res.mask;
      break;
    }
    case "colour": {
      let target = spec.colour ? parseColour(spec.colour) : null;
      if (!target && spec.at) {
        const p = toPx(r, spec.at);
        const at = (Math.min(r.h - 1, Math.round(p.y)) * r.w + Math.min(r.w - 1, Math.round(p.x))) * 4;
        target = [r.data[at], r.data[at + 1], r.data[at + 2]];
      }
      if (!target) throw new ToolError(`Mask ${spec.name}: which colour (colour, or at a point)?`);
      m = colourMask(r, target, spec.tolerance ?? 12);
      break;
    }
    case "asset": {
      if (!spec.ref) throw new ToolError(`Mask ${spec.name}: which saved mask (ref)?`);
      const img = await imageOf(spec.ref, run.ctx);
      m = await resizeMask(maskFromImage(await decode(img.bytes)), r.w, r.h);
      break;
    }
  }
  const other = (name: string) => maskFor(name, r, run, depth + 1);
  if (spec.within) m = intersect(m, await other(spec.within));
  for (const name of spec.plus ?? []) m = union(m, await other(name));
  for (const name of spec.minus ?? []) m = intersect(m, invert(await other(name)));
  if (spec.invert) m = invert(m);
  if (spec.grow) m = grow(m, spec.grow);
  if (spec.feather) m = feather(m, spec.feather);
  return m;
}

/** A mask by name, for the picture as it is now: one defined in `masks`, or subject / background / all. */
function maskFor(name: string, r: Raster, run: Run, depth = 0): Promise<Mask> {
  if (depth > 8) throw new ToolError(`Mask ${name} refers back to itself.`);
  let cache = run.cache.get(r);
  if (!cache) {
    cache = new Map();
    run.cache.set(r, cache);
  }
  const hit = cache.get(name);
  if (hit) return hit;
  const spec = run.specs.get(name);
  let made: Promise<Mask>;
  if (spec) made = buildMask(spec, r, run, depth);
  else if (name === "subject") made = subjectOf(r, run);
  else if (name === "background") made = maskFor("subject", r, run, depth + 1).then(invert);
  else if (name === "all") made = Promise.resolve(emptyMask(r.w, r.h, 255));
  else throw new ToolError(`There's no mask "${name}": define it in masks, or use subject, background or all.`);
  cache.set(name, made);
  made.catch(() => cache.delete(name));
  return made;
}

async function refMaskFor(spec: NonNullable<StepT["refMask"]> | undefined, r: Raster, run: Run): Promise<Mask | null> {
  if (!spec || spec.type === "subject") return subjectOf(r, run);
  if (spec.type === "all") return null;
  if (spec.type === "box") {
    if (!spec.box) throw new ToolError("refMask box needs box.");
    return boxMask(r.w, r.h, boxPx(r, spec.box));
  }
  if (!spec.points?.length && !spec.box) throw new ToolError("refMask select needs points or a box.");
  const res = await select(
    r,
    { points: spec.points?.map((p) => ({ ...toPx(r, p), on: p.on !== false })), box: spec.box ? boxPx(r, spec.box) : undefined },
    { progress: run.progress, signal: run.ctx.signal },
  );
  return res.mask;
}

async function loadRaster(ref: string, run: Run): Promise<Raster> {
  return decode((await imageOf(ref, run.ctx)).bytes);
}

/** Where to centre a crop: the point given, else the subject's middle. */
async function focusOf(step: StepT, r: Raster, run: Run): Promise<Point> {
  if (step.focus) return toPx(r, step.focus);
  const box = maskBox(await maskFor(step.mask ?? "subject", r, run), 127);
  return box ? { x: box.x + box.w / 2, y: box.y + box.h / 2 } : { x: r.w / 2, y: r.h / 2 };
}

const ratio = (aspect: string) => {
  const [w, h] = aspect.split(":").map(Number);
  if (!w || !h) throw new ToolError(`"${aspect}" isn't an aspect (w:h).`);
  return w / h;
};

/** Mix a step's result back in through its mask, at its strength. */
async function masked(step: StepT, before: Raster, after: Raster, run: Run): Promise<Raster> {
  if (!step.mask && (step.strength ?? 1) >= 1) return after;
  const m = step.mask ? await maskFor(step.mask, before, run) : emptyMask(before.w, before.h, 255);
  return blend(before, after, m, step.strength ?? 1);
}

async function runStep(step: StepT, r: Raster, run: Run): Promise<Raster> {
  const ctx = run.ctx;
  const opts = { progress: run.progress, signal: ctx.signal };
  switch (step.op) {
    case "canvas": {
      if (!step.width || !step.height) throw new ToolError("canvas needs width and height.");
      const c = colourOf(step.colour);
      return blank(step.width, step.height, c ? [c[0], c[1], c[2], 255] : [0, 0, 0, 0]);
    }

    case "cutout": {
      const m = await maskFor(step.mask ?? "subject", r, run);
      let out = withAlpha(defringe(r, m), m);
      if (step.trim !== false) {
        const box = maskBox(m, 16);
        if (!box) throw new ToolError("There's no subject to cut out.");
        const room = Math.round(Math.max(box.w, box.h) * 0.03);
        const x = Math.max(0, box.x - room);
        const y = Math.max(0, box.y - room);
        out = crop(out, x, y, Math.min(r.w, box.x + box.w + room) - x, Math.min(r.h, box.y + box.h + room) - y);
      }
      return out;
    }

    case "background": {
      const m = await maskFor(step.mask ?? "subject", r, run);
      const fill = step.fill ?? "colour";
      if (!["colour", "gradient", "sweep", "blur", "image"].includes(fill)) throw new ToolError(`background fill is colour, gradient, sweep, blur or image (not ${fill}).`);
      let image: Raster | undefined;
      if (fill === "image") {
        if (!step.ref) throw new ToolError("background image needs ref (the backdrop picture).");
        image = await fit(await loadRaster(step.ref, run), r.w, r.h, "cover");
      }
      return backdrop(flattenAlpha(r), m, {
        fill: fill as "colour" | "gradient" | "sweep" | "blur" | "image",
        colour: colourOf(step.colour),
        colour2: colourOf(step.colour2),
        angle: step.angle,
        blur: step.blur,
        image,
        shadow: step.shadow,
      });
    }

    case "white": {
      const preset = step.preset ? await presetOf(step.preset, run) : null;
      const width = step.width ?? preset?.width ?? 2000;
      const height = step.height ?? preset?.height ?? width;
      const m = await maskFor(step.mask ?? "subject", r, run);
      const res = await catalogueWhite(r, m, { width, height, fill: step.share ?? preset?.fill ?? 0.85 });
      const check = whiteCheck(res.raster, res.mask);
      run.notes.push(
        `white: ${width}x${height}, background ${round(check.pureWhite * 100, 1)}% pure white (RGB 255), edges ${check.edgesWhite ? "all white" : "NOT all white"}, product fills ${Math.round(check.fill * 100)}% of the frame`,
      );
      return res.raster;
    }

    case "fit": {
      const preset = step.preset ? await presetOf(step.preset, run) : null;
      const width = step.width ?? preset?.width;
      const height = step.height ?? preset?.height;
      if (!width || !height) throw new ToolError("fit needs a preset, or width and height.");
      const mode = step.mode ?? "pad";
      const scale = mode === "pad" ? Math.min(width / r.w, height / r.h) : Math.max(width / r.w, height / r.h);
      if (scale > 1.05) run.notes.push(`fit: enlarged ${round(scale, 2)}x to reach ${width}x${height} (an upscale step first keeps it sharper)`);
      const colour = colourOf(step.colour) ?? (preset?.background === "white" ? ([255, 255, 255] as RGB) : undefined);
      return fit(r, width, height, mode, { colour, focus: mode === "cover" ? await focusOf(step, r, run) : undefined });
    }

    case "crop": {
      if (step.box) {
        const b = boxPx(r, step.box);
        if (b.w < 8 || b.h < 8) throw new ToolError("That crop box is too small.");
        return crop(r, b.x, b.y, Math.min(b.w, r.w - b.x), Math.min(b.h, r.h - b.y));
      }
      if (!step.aspect) throw new ToolError("crop needs a box or an aspect.");
      const b = aspectBox(r.w, r.h, ratio(step.aspect), await focusOf(step, r, run));
      return crop(r, b.x, b.y, b.w, b.h);
    }

    case "extend": {
      let pad: Padding;
      if (step.aspect) pad = padTo(r.w, r.h, ratio(step.aspect), step.anchor ?? "centre");
      else if (step.padding) {
        const p = step.padding;
        pad = { top: Math.round((p.top ?? 0) * r.h), bottom: Math.round((p.bottom ?? 0) * r.h), left: Math.round((p.left ?? 0) * r.w), right: Math.round((p.right ?? 0) * r.w) };
      } else throw new ToolError("extend needs an aspect or padding.");
      if (pad.top + pad.bottom + pad.left + pad.right === 0) return r;
      let fill = step.fill;
      if (!fill) {
        // A plain backdrop is extended with its own colour; anything else is filled in by LaMa.
        const plain = borderSpread(r) < 6;
        fill = plain ? "colour" : "inpaint";
        run.notes.push(`extend: ${plain ? "the border is plain, so its colour" : "the border has detail, so LaMa filled it in"}`);
      }
      if (fill === "colour" || fill === "mirror" || fill === "edge") return extend(r, pad, fill, colourOf(step.colour)).raster;
      if (fill !== "inpaint") throw new ToolError(`extend fill is colour, mirror, edge or inpaint (not ${fill}).`);
      const res = extend(r, pad, "mirror");
      return inpaint(res.raster, res.hole, opts);
    }

    case "rotate": {
      const deg = step.degrees ?? 0;
      const quarter = ((Math.round(deg) % 360) + 360) % 360;
      if (Math.abs(deg % 90) < 1e-6) return turn(r, quarter as 0 | 90 | 180 | 270, step.flip);
      if (Math.abs(deg) > 45) throw new ToolError("Straighten by up to 45 degrees; turn by 90, 180 or 270.");
      const flipped = step.flip ? turn(r, 0, step.flip) : r;
      return straighten(flipped, deg);
    }

    case "perspective": {
      if (!step.corners) throw new ToolError("perspective needs the four corners (top-left, top-right, bottom-right, bottom-left).");
      const [a, b, c, d] = step.corners.map((p) => toPx(r, p));
      return perspective(r, [a, b, c, d]);
    }

    case "grade": {
      const g: Grade = {
        exposure: step.exposure,
        contrast: step.contrast,
        highlights: step.highlights,
        shadows: step.shadows,
        temperature: step.temperature,
        tint: step.tint,
        neutral: step.neutral ? toPx(r, step.neutral) : undefined,
        saturation: step.saturation,
        vibrance: step.vibrance,
        curve: step.curve as [number, number][] | undefined,
        lut: step.lut ? await loadLut(step.lut) : undefined,
        lutStrength: step.lut ? step.strength : undefined,
        clarity: step.clarity,
        sharpen: step.sharpen,
        vignette: step.vignette,
        grain: step.grain,
      };
      // With a LUT, strength is the LUT's; the mask still limits where it all goes.
      const out = grade(r, g);
      return masked(step.lut ? { ...step, strength: 1 } : step, r, out, run);
    }

    case "light": {
      if (step.exposure === undefined) throw new ToolError("light needs exposure (stops: + brightens, − darkens).");
      const long = Math.max(r.w, r.h);
      const out = light(r, {
        exposure: step.exposure,
        warmth: step.warmth,
        mask: step.mask ? feather(await maskFor(step.mask, r, run), long / 80) : undefined,
        from: step.from ? toPx(r, step.from) : undefined,
        to: step.to ? toPx(r, step.to) : undefined,
        centre: step.centre ? toPx(r, step.centre) : undefined,
        radius: step.radius ? step.radius * long : undefined,
      });
      return step.strength !== undefined ? blend(r, out, emptyMask(r.w, r.h, 255), step.strength) : out;
    }

    case "remove": {
      if (!step.mask) throw new ToolError("remove needs a mask over what to take out.");
      const m = await maskFor(step.mask, r, run);
      if (coverage(m) > 0.4) throw new ToolError(`Mask ${step.mask} covers ${Math.round(coverage(m) * 100)}% of the picture: too much to fill in from around it.`);
      return inpaint(r, m, opts);
    }

    case "smooth": {
      if (!step.mask) throw new ToolError("smooth needs a mask (the skin to smooth: select it, or the subject minus the garment).");
      const m = feather(await maskFor(step.mask, r, run), Math.max(r.w, r.h) / 300);
      return smoothSkin(r, m, step.amount ?? 0.5);
    }

    case "colour_match": {
      if (!step.ref) throw new ToolError("colour_match needs ref: the original photo whose colour is right.");
      const m = await maskFor(step.mask ?? "subject", r, run);
      const ref = await loadRaster(step.ref, run);
      const refMask = await refMaskFor(step.refMask, ref, run);
      const want = palette(ref, refMask);
      const before = compareColours(want, palette(r, m));
      const out = matchColour(r, m, ref, refMask, { strength: step.strength ?? 1, keepLightness: step.keepLightness !== false });
      const after = compareColours(want, palette(out, m));
      run.notes.push(`colour_match: ${colourNote(before, after)}`);
      return out;
    }

    case "watermark": {
      const res = await removeWatermark(r, opts);
      if (!res) {
        run.notes.push("watermark: no Gemini sparkle found; the picture is as it was");
        return r;
      }
      const f = res.found;
      run.notes.push(`watermark: removed the ${f.template} sparkle at ${f.x},${f.y} (${f.size} px, match ${f.before}, strength ${f.gain}${f.filled ? `, ${f.filled} clipped px filled` : ""})`);
      return res.raster;
    }

    case "upscale": {
      if (Math.max(r.w, r.h) > MAX_UPSCALE_INPUT) throw new ToolError(`Upscaling is for pictures up to ${MAX_UPSCALE_INPUT} px on the long side; this one is ${r.w}x${r.h}.`);
      const factor = (step.factor ?? 2) as 2 | 3 | 4;
      return upscale(r, factor, opts);
    }

    case "compose": {
      const layers: Layer[] = [];
      for (const l of step.layers ?? []) {
        let img = await loadRaster(l.ref, run);
        if (l.cutout) img = await runStep({ op: "cutout" }, img, run);
        layers.push({ image: img, x: l.x * r.w, y: l.y * r.h, width: l.width * r.w, opacity: l.opacity, rotate: l.rotate, shadow: l.shadow });
      }
      const texts: TextBlock[] = (step.texts ?? []).map((t) => ({
        text: t.text,
        x: t.x * r.w,
        y: t.y * r.h,
        size: t.size * r.h,
        colour: t.colour,
        font: t.font,
        align: t.align,
        maxWidth: t.maxWidth ? t.maxWidth * r.w : undefined,
        background: t.background,
        shadow: t.shadow,
      }));
      if (!layers.length && !texts.length) throw new ToolError("compose needs layers or texts.");
      return compose(r, layers, texts);
    }

    case "ffmpeg": {
      if (!step.graph) throw new ToolError("ffmpeg needs a graph ([0:v] is the picture, inputs follow as [1:v]...; end at [vout]).");
      const dir = await mkdtemp(path.join(os.tmpdir(), "seelie-edit-"));
      try {
        const file = path.join(dir, "in.png");
        await writeFile(file, await encode(r, "png"));
        const png = await renderStill({ graph: step.graph, inputs: [{ file }, ...(step.inputs ?? []).map((ref) => ({ ref }))] }, { chatImages: ctx.chatImages, signal: ctx.signal, progress: run.progress });
        return decode(png);
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

/**
 * The original's colours against a picture's, before and after a change: the main colour
 * (the base fabric), the share-weighted average, and each colour (prints and borders match
 * less exactly than the base, so the main colour is what to judge first).
 */
export function colourNote(before: ReturnType<typeof compareColours>, after: ReturnType<typeof compareColours>) {
  const weighted = (list: ReturnType<typeof compareColours>) =>
    round(list.reduce((s, c) => s + (c.deltaE ?? 0) * c.original.share, 0) / Math.max(1e-6, list.reduce((s, c) => s + c.original.share, 0)), 1);
  const main = after[0];
  if (!main) return "no colours to compare";
  return [
    `main colour ${main.original.hex} ΔE00 ${before[0]?.deltaE ?? "?"} -> ${main.deltaE ?? "?"} (${main.verdict})`,
    `share-weighted ΔE00 ${weighted(before)} -> ${weighted(after)}`,
    `each: ${after.map((c, i) => `${c.original.hex} ${Math.round(c.original.share * 100)}% ${before[i]?.deltaE ?? "?"} -> ${c.deltaE ?? "?"}`).join(", ")}`,
  ].join("; ");
}

/** How much the border's colour varies (0 = one flat colour). */
function borderSpread(r: Raster): number {
  const [mr, mg, mb] = borderColour(r);
  const bw = Math.max(1, Math.round(Math.min(r.w, r.h) * 0.02));
  let sum = 0;
  let n = 0;
  const step = Math.max(1, Math.round((r.w + r.h) / 500));
  for (let x = 0; x < r.w; x += step) {
    for (const y of [Math.floor(bw / 2), r.h - 1 - Math.floor(bw / 2)]) {
      const p = (y * r.w + x) * 4;
      sum += Math.abs(r.data[p] - mr) + Math.abs(r.data[p + 1] - mg) + Math.abs(r.data[p + 2] - mb);
      n += 3;
    }
  }
  for (let y = 0; y < r.h; y += step) {
    for (const x of [Math.floor(bw / 2), r.w - 1 - Math.floor(bw / 2)]) {
      const p = (y * r.w + x) * 4;
      sum += Math.abs(r.data[p] - mr) + Math.abs(r.data[p + 1] - mg) + Math.abs(r.data[p + 2] - mb);
      n += 3;
    }
  }
  return sum / Math.max(1, n);
}

/** A cut-out put back on a backdrop starts from its colours (its own alpha is the mask). */
function flattenAlpha(r: Raster): Raster {
  if (!hasAlpha(r)) return r;
  const out = { w: r.w, h: r.h, data: new Uint8ClampedArray(r.data) };
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = 255;
  return out;
}

async function presetOf(name: string, run: Run) {
  const spec = await getSpec(name);
  if (!spec) {
    const names = (await listSpecs()).map((s) => s.name);
    throw new ToolError(
      `There's no saved preset "${name}"${names.length ? ` (saved: ${names.join(", ")})` : ""}. Read the marketplace's official image rules (web_search, fetch_url) and save them with image_specs first.`,
    );
  }
  run.output.format ??= spec.format;
  run.output.maxBytes ??= spec.maxBytes;
  return spec;
}

/* -------------------------------------------------------------------------- */
/* photo_edit                                                                 */
/* -------------------------------------------------------------------------- */

export const photoEdit = defineTool({
  name: "photo_edit",
  label: "Edit photos",
  description: [
    "Edit photos with code (no image model, no cost): a list of steps run in order on each ref (chat:<n> or image asset:<id>; up to 24, the same steps on each).",
    "The result is saved as an image asset (asset:<id>) and shown to you; keepSteps saves every step's picture too. Positions and boxes are fractions of the picture as it is at that step (x 0 = left, 1 = right; y 0 = top);",
    "grow, feather and blur are in px of the picture. Generative changes (a new setting, another model, removing a phone, flat lay <-> on-model) are photoshoot recasts, not edits.",
    "MASKS: define named masks once and use them by name in steps (mask: name); subject, background and all need no definition. Types: subject (BiRefNet; a cut-out's own transparency),",
    "select (SlimSAM: points on the thing, on:false for points that are not it, and/or a box around it), box, ellipse (box), polygon (points), colour (colour #hex or at a point; tolerance ΔE00, default 12),",
    "asset (a saved mask picture, ref). Combine: within (intersect), plus, minus (other mask names); invert; grow (px, − shrinks); feather (px). saveMasks keeps masks (as worked out on the starting picture) as mask assets.",
    "STEPS (op): cutout (mask, default subject; trim false keeps the frame) -> transparent PNG.",
    "background (mask = what stays, default subject; fill colour | gradient (colour -> colour2, angle) | sweep (a studio wall into floor, colour) | blur (the photo's own background, blur px) | image (ref, a backdrop); shadow 0-1 a contact shadow).",
    "white: catalogue white: the subject centred on pure RGB 255 white at share of the frame (default 0.85), width x height or a preset (default 2000 square); reports the pure-white check.",
    "fit: exactly width x height or a preset's: mode pad (default; colour, else the border's colour, white for a white preset) | cover (crops around focus, default the subject) | stretch.",
    "crop: box, or the largest aspect around focus (default the subject). extend: to an aspect (anchor) or by padding (fractions per side): fill colour | mirror | edge | inpaint (LaMa; default: colour if the border is plain, else inpaint).",
    "rotate: degrees (90/180/270 turns; small angles straighten and crop clean), flip. perspective: corners (top-left, top-right, bottom-right, bottom-left) squared up.",
    "grade (optionally in a mask, at strength): exposure (stops), contrast, highlights, shadows, temperature, tint, neutral (a point that should be grey), saturation, vibrance (−1..1), curve ([in, out] 0-255),",
    "lut ($lut/<file>.cube, at strength), clarity, sharpen (0-2), vignette, grain (0-1).",
    "light: shape the light: exposure (stops, + dodge, − burn) with warmth, as a pool (centre, radius as a fraction of the long side), a sweep (full at from, gone by to) or in a mask. Code can't re-aim light falling on the garment.",
    "remove: fill a mask from its surroundings (LaMa): tags, hangers, lint, stains, clutter, stray hairs. smooth: even skin in a mask, keeping its texture (amount 0-1).",
    "colour_match: move a region's colour (mask, default subject) onto the original photo's (ref; refMask subject | select | box | all on that photo); keepLightness (default true) keeps the scene's light; reports ΔE00 before and after.",
    "watermark: remove Gemini's visible sparkle (left alone when there is none). upscale: factor 2-4 (Real-ESRGAN, pictures up to 1600 px).",
    "compose: layers (ref, x, y, width as fractions; cutout true cuts its subject out first; opacity, rotate, shadow) and texts (text, x, y, size as a fraction of the height, colour, font $font/<file>, align, maxWidth, background, shadow).",
    "Never put text on a marketplace main image. ffmpeg: a still graph (as in video_render: [0:v] is the picture, inputs are extra refs as [1:v]..., end at [vout]). canvas: a blank width x height (colour, else transparent) to compose on; refs can then be left out.",
    "Output: format (default PNG with transparency, else JPEG), quality, maxBytes (JPEG/WebP quality is lowered to fit); a preset sets its format and size limit.",
  ].join(" "),
  parameters: Type.Object({
    refs: optional(Type.Array(Type.String(), { minItems: 1, maxItems: 24 })),
    masks: optional(Type.Array(MaskSpec, { maxItems: 12 })),
    steps: Type.Array(Step, { minItems: 1, maxItems: 24 }),
    format: optional(StringEnum(["jpeg", "png", "webp"])),
    quality: optional(Type.Integer({ minimum: 50, maximum: 100 })),
    maxBytes: optional(Type.Integer({ minimum: 20_000, maximum: 50_000_000 })),
    keepSteps: optional(Type.Boolean()),
    saveMasks: optional(Type.Array(Type.String(), { maxItems: 8 })),
    name: optional(Type.String({ maxLength: 120 })),
  }),
  kind: "read",
  summary: (a) => `${a.steps.map((s) => s.op).join(" → ")}${a.refs?.length ? ` on ${a.refs.length > 3 ? plural(a.refs.length, "photo") : a.refs.join(", ")}` : ""}`,
  async execute(a, ctx) {
    const specs = new Map((a.masks ?? []).map((m) => [m.name, m]));
    if (specs.size !== (a.masks ?? []).length) throw new ToolError("Two masks have the same name.");
    const refs: (string | null)[] = a.refs?.length ? a.refs : a.steps[0].op === "canvas" ? [null] : [];
    if (!refs.length) throw new ToolError("Which photos (refs)? Or start from a canvas step.");

    const results: unknown[] = [];
    const images: ImageContent[] = [];
    for (const [i, ref] of refs.entries()) {
      const prefix = refs.length > 1 ? `${i + 1} of ${refs.length}: ` : "";
      const run: Run = { ctx, specs, cache: new WeakMap(), notes: [], output: {}, progress: (t) => ctx.progress(prefix + t) };
      try {
        const src = ref ? await imageOf(ref, ctx) : null;
        let cur: Raster = src ? await decode(src.bytes) : blank(1, 1);
        const start = cur;
        const kept: Record<string, unknown>[] = [];

        for (const name of a.saveMasks ?? []) {
          if (!src) throw new ToolError("saveMasks needs a starting photo.");
          const m = await maskFor(name, start, run);
          const row = await saveAsset({
            bytes: await encode(maskImage(m), "png"),
            mime: "image/png",
            name: `${src.name}: ${name} mask`,
            source: "mask",
            chatId: ctx.chatId,
            userId: ctx.user.id,
            meta: { from: ref, mask: specs.get(name) ?? name },
          });
          kept.push({ mask: name, ...assetSummary(row), covers: `${Math.round(coverage(m) * 100)}%` });
        }

        for (const [n, step] of a.steps.entries()) {
          run.progress(`${step.op} (${n + 1} of ${a.steps.length})…`);
          cur = await runStep(step, cur, run);
          if (a.keepSteps && n < a.steps.length - 1) {
            const row = await saveAsset({
              bytes: await encode(cur, hasAlpha(cur) ? "png" : "jpeg", 92),
              mime: hasAlpha(cur) ? "image/png" : "image/jpeg",
              name: `${src?.name ?? "canvas"} after ${step.op}`,
              source: "edited",
              chatId: ctx.chatId,
              userId: ctx.user.id,
              meta: { from: ref, steps: a.steps.slice(0, n + 1) },
            });
            kept.push({ step: n + 1, op: step.op, ...assetSummary(row) });
          }
        }

        const format: Format = a.format ?? run.output.format ?? (hasAlpha(cur) ? "png" : "jpeg");
        const file = await toFile(cur, format, a.quality ?? 92, a.maxBytes ?? run.output.maxBytes);
        if (file.over) run.notes.push(`size: ${Math.round(file.bytes.length / 1024)} KB is still over the ${Math.round((a.maxBytes ?? run.output.maxBytes ?? 0) / 1024)} KB limit${format === "png" ? " (PNG: use jpeg to bring it down)" : ""}`);
        else if (file.quality !== (a.quality ?? 92)) run.notes.push(`size: quality lowered to ${file.quality} to stay under the limit`);
        const row: AssetRow = await saveAsset({
          bytes: file.bytes,
          mime: MIME[format],
          name: a.name ?? `${src?.name ?? "canvas"} edited`,
          source: "edited",
          chatId: ctx.chatId,
          userId: ctx.user.id,
          meta: { from: ref, steps: a.steps, masks: a.masks ?? [], notes: run.notes },
        });
        results.push({ from: ref, ...assetSummary(row), kb: Math.round(file.bytes.length / 1024), notes: run.notes, ...(kept.length ? { kept } : {}) });
        if (images.length < 8) images.push(jpegBlock(await preview(cur, 1024)));
      } catch (err) {
        if (err instanceof ToolError || err instanceof MediaError) results.push({ from: ref, error: err.message, notes: run.notes });
        else throw err;
      }
    }
    if (!images.length) {
      const first = results[0] as { error?: string };
      throw new ToolError(refs.length === 1 ? (first.error ?? "The edit failed.") : `Every edit failed: ${JSON.stringify(results)}`);
    }
    return {
      text: images.length < results.length ? `Showing ${images.length} of ${results.length}.` : undefined,
      data: results,
      images,
    };
  },
});

/* -------------------------------------------------------------------------- */
/* image_specs                                                                */
/* -------------------------------------------------------------------------- */

export const imageSpecs = defineTool({
  name: "image_specs",
  label: "Image specs",
  description: [
    "Marketplace image rules, saved as presets that photo_edit's fit and white steps use by name. list: the saved presets with their source and the day they were checked.",
    "save: only from the marketplace's own official documentation read just now (web_search, then fetch_url the page): name (e.g. amazon-main, amazon-other, flipkart, meesho, paribelle, instagram-post),",
    "marketplace, use, width x height to make, format, maxBytes, background (white | any), fill (the product's share of the frame on white), notes (other rules), source (that page's https URL).",
    "remove: a preset by name. A preset checked more than ~6 months ago should be checked again before relying on it.",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["list", "save", "remove"]),
    name: optional(Type.String({ pattern: "^[a-z][a-z0-9-]{1,40}$" })),
    marketplace: optional(Type.String({ maxLength: 60 })),
    use: optional(Type.String({ maxLength: 80 })),
    width: optional(Type.Integer({ minimum: 100, maximum: 10000 })),
    height: optional(Type.Integer({ minimum: 100, maximum: 10000 })),
    format: optional(StringEnum(["jpeg", "png", "webp"])),
    maxBytes: optional(Type.Integer({ minimum: 20_000, maximum: 100_000_000 })),
    background: optional(StringEnum(["white", "any"])),
    fill: optional(Type.Number({ minimum: 0.3, maximum: 1 })),
    notes: optional(Type.String({ maxLength: 1000 })),
    source: optional(Type.String({ maxLength: 500 })),
  }),
  kind: (a) => (a.action === "list" ? "read" : "write"),
  summary: (a) => (a.action === "list" ? "Saved image presets" : `${a.action === "save" ? "Save" : "Remove"} preset ${a.name ?? ""}`),
  async execute(a, ctx) {
    if (a.action === "list") {
      const all = await listSpecs();
      return { text: all.length ? undefined : "No presets saved yet.", data: all };
    }
    if (!a.name) throw new ToolError("Which preset (name)?");
    if (a.action === "remove") {
      if (!(await removeSpec(a.name, ctx.user.id))) throw new ToolError(`There's no preset ${a.name}.`);
      return { text: `Removed ${a.name}.` };
    }
    const missing = (["marketplace", "use", "width", "height", "format", "background", "source"] as const).filter((k) => a[k] === undefined);
    if (missing.length) throw new ToolError(`A preset needs ${missing.join(", ")}.`);
    if (!publicHttps(a.source!)) throw new ToolError("source must be the official page's https URL.");
    const saved = await saveSpec(
      {
        name: a.name,
        marketplace: a.marketplace!,
        use: a.use!,
        width: a.width!,
        height: a.height!,
        format: a.format!,
        maxBytes: a.maxBytes,
        background: a.background!,
        fill: a.fill,
        notes: a.notes,
        source: a.source!,
        checkedOn: todayIst(),
      },
      ctx.user.id,
    );
    return { text: `Saved ${saved.name}.`, data: saved };
  },
});
