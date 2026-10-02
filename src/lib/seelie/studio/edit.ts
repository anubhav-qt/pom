import "server-only";

import { readFile, stat } from "node:fs/promises";

import { mediaPath, MediaError } from "../media/files";
import { blank, blend, blurPlane, blurRaster, clone, crop, fromCanvas, maskBox, over, resize, toCanvas, withAlpha, type Mask, type Raster } from "./raster";

/**
 * The photo edits Seelie directs through photo_edit: tone and colour, shaped light,
 * backdrops and catalogue white, fitting, cropping, extending, straightening and
 * perspective, skin smoothing, and composing layers and text. Plain pixel maths over
 * RGBA (canvas only for drawing); each edit takes a picture and returns a new one.
 */

export type RGB = [number, number, number];
export interface Point {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const clamp = (v: number, lo = 0, hi = 255) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** sRGB byte -> linear light, and back (through a fine table). */
const LIN = Float32Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});
const STEPS = 8192;
const ENC = Float32Array.from({ length: STEPS + 1 }, (_, i) => {
  const v = i / STEPS;
  return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
});
const toSrgb = (lin: number) => ENC[lin <= 0 ? 0 : lin >= 1 ? STEPS : Math.round(lin * STEPS)];

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** The mean colour around a point (px), in linear light. */
function meanLinear(r: Raster, at: Point, radius: number): RGB {
  const sum: RGB = [0, 0, 0];
  let n = 0;
  for (let y = Math.max(0, Math.round(at.y - radius)); y <= Math.min(r.h - 1, Math.round(at.y + radius)); y++) {
    for (let x = Math.max(0, Math.round(at.x - radius)); x <= Math.min(r.w - 1, Math.round(at.x + radius)); x++) {
      const p = (y * r.w + x) * 4;
      for (let c = 0; c < 3; c++) sum[c] += LIN[r.data[p + c]];
      n++;
    }
  }
  return sum.map((v) => v / Math.max(1, n)) as RGB;
}

/** The median colour of a picture's outer band (what a plain backdrop most likely is). */
export function borderColour(r: Raster, band = 0.02): RGB {
  const bw = Math.max(1, Math.round(Math.min(r.w, r.h) * band));
  const vals: number[][] = [[], [], []];
  const step = Math.max(1, Math.floor((2 * (r.w + r.h) * bw) / 40_000));
  let k = 0;
  const take = (x: number, y: number) => {
    if (k++ % step) return;
    const p = (y * r.w + x) * 4;
    if (r.data[p + 3] < 128) return;
    for (let c = 0; c < 3; c++) vals[c].push(r.data[p + c]);
  };
  for (let y = 0; y < r.h; y++) {
    if (y < bw || y >= r.h - bw) for (let x = 0; x < r.w; x++) take(x, y);
    else {
      for (let x = 0; x < bw; x++) take(x, y);
      for (let x = r.w - bw; x < r.w; x++) take(x, y);
    }
  }
  if (!vals[0].length) return [255, 255, 255];
  return vals.map((v) => v.sort((a, b) => a - b)[v.length >> 1]) as RGB;
}

/* -------------------------------------------------------------------------- */
/* Grade                                                                      */
/* -------------------------------------------------------------------------- */

export interface Grade {
  /** Stops, −3 to 3. */
  exposure?: number;
  /** −1 to 1 each. */
  contrast?: number;
  highlights?: number;
  shadows?: number;
  /** Warmer (+) or cooler (−), −1 to 1; tint: magenta (+) or green (−). */
  temperature?: number;
  tint?: number;
  /** A point (px) that should be neutral grey: sets the white balance from it. */
  neutral?: Point;
  saturation?: number;
  vibrance?: number;
  /** A tone curve through [in, out] points, 0-255. */
  curve?: [number, number][];
  /** A parsed 3D LUT and how much of it, 0-1. */
  lut?: Lut3D;
  lutStrength?: number;
  clarity?: number;
  /** 0 to 2. */
  sharpen?: number;
  /** Darker (+) or lighter (−) corners, −1 to 1. */
  vignette?: number;
  /** 0 to 1. */
  grain?: number;
}

/** A monotone cubic through the points (Fritsch-Carlson), as a 256-entry table. */
function curveTable(points: [number, number][]): Float32Array {
  const pts = [...points].map(([x, y]) => [clamp(x), clamp(y)] as [number, number]).sort((a, b) => a[0] - b[0]);
  if (pts[0][0] > 0) pts.unshift([0, pts[0][0] === 0 ? pts[0][1] : 0]);
  if (pts[pts.length - 1][0] < 255) pts.push([255, 255]);
  const n = pts.length;
  const d = Array.from({ length: n - 1 }, (_, i) => (pts[i + 1][1] - pts[i][1]) / Math.max(1e-6, pts[i + 1][0] - pts[i][0]));
  const m = Array.from({ length: n }, (_, i) => (i === 0 ? d[0] : i === n - 1 ? d[n - 2] : d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2));
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  const out = new Float32Array(256);
  let seg = 0;
  for (let x = 0; x < 256; x++) {
    while (seg < n - 2 && x > pts[seg + 1][0]) seg++;
    const [x0, y0] = pts[seg];
    const [x1, y1] = pts[seg + 1];
    const h = Math.max(1e-6, x1 - x0);
    const t = clamp((x - x0) / h, 0, 1);
    const t2 = t * t;
    const t3 = t2 * t;
    out[x] = clamp((2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * m[seg] + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * m[seg + 1]);
  }
  return out;
}

/** Contrast, highlights, shadows and the curve, as one table on 0-255. */
function toneTable(g: Grade): Uint8ClampedArray | null {
  const c = clamp(g.contrast ?? 0, -1, 1);
  const hl = clamp(g.highlights ?? 0, -1, 1);
  const sh = clamp(g.shadows ?? 0, -1, 1);
  if (!c && !hl && !sh && !g.curve?.length) return null;
  const curve = g.curve?.length ? curveTable(g.curve) : null;
  const k = 1 + 7 * Math.max(0, c);
  const out = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    let x = v / 255;
    // Shadows and highlights: lifts or pulls that peak at 1/3 and 2/3 and leave black and white alone.
    x += sh * 0.3 * 6.75 * x * (1 - x) * (1 - x);
    x += hl * 0.3 * 6.75 * x * x * (1 - x);
    x = clamp(x, 0, 1);
    // Contrast: a sigmoid that never clips (more), or a straight flattening toward grey (less).
    if (c > 0) x = 0.5 + (0.5 * Math.tanh(k * (x - 0.5))) / Math.tanh(k / 2);
    else if (c < 0) x = 0.5 + (x - 0.5) * (1 + c);
    let y = x * 255;
    if (curve) {
      const i = Math.floor(y);
      const f = y - i;
      y = i >= 255 ? curve[255] : curve[i] * (1 - f) + curve[i + 1] * f;
    }
    out[v] = y;
  }
  return out;
}

/** A tiny seeded random source, so grain is the same on a re-run. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function grade(r: Raster, g: Grade): Raster {
  const out = clone(r);
  const d = out.data;
  const n = r.w * r.h;
  const long = Math.max(r.w, r.h);

  // White balance and exposure: gains in linear light.
  let gains: RGB = [1, 1, 1];
  if (g.neutral) {
    const m = meanLinear(r, g.neutral, Math.max(2, Math.round(long / 400)));
    const y = luma(...m);
    if (Math.min(...m) > 1e-4) gains = [y / m[0], y / m[1], y / m[2]];
  }
  const t = clamp(g.temperature ?? 0, -1, 1);
  const tint = clamp(g.tint ?? 0, -1, 1);
  gains = [gains[0] * (1 + 0.25 * t), gains[1] * (1 - 0.2 * tint), gains[2] * (1 - 0.25 * t)];
  const keep = luma(...gains);
  const ev = 2 ** clamp(g.exposure ?? 0, -3, 3);
  gains = gains.map((v) => (v / keep) * ev) as RGB;
  const linear = gains.some((v) => Math.abs(v - 1) > 1e-4);

  const tone = toneTable(g);
  const sat = clamp(g.saturation ?? 0, -1, 1);
  const vib = clamp(g.vibrance ?? 0, -1, 1);
  const lutAmount = g.lut ? clamp(g.lutStrength ?? 1, 0, 1) : 0;

  for (let i = 0; i < n; i++) {
    const p = i * 4;
    let R = d[p];
    let G = d[p + 1];
    let B = d[p + 2];
    if (linear) {
      R = toSrgb(LIN[R] * gains[0]);
      G = toSrgb(LIN[G] * gains[1]);
      B = toSrgb(LIN[B] * gains[2]);
    }
    if (tone) {
      R = tone[Math.round(R)];
      G = tone[Math.round(G)];
      B = tone[Math.round(B)];
    }
    if (sat || vib) {
      const y = 0.299 * R + 0.587 * G + 0.114 * B;
      const s = (Math.max(R, G, B) - Math.min(R, G, B)) / 255;
      // Vibrance moves the muted colours most and leaves the already strong ones.
      const k = Math.max(0, 1 + sat + vib * (1 - s) * (vib > 0 ? 1 : 0.6));
      R = y + (R - y) * k;
      G = y + (G - y) * k;
      B = y + (B - y) * k;
    }
    if (lutAmount) {
      const [lr, lg, lb] = applyLut(g.lut!, clamp(R) / 255, clamp(G) / 255, clamp(B) / 255);
      R += (lr * 255 - R) * lutAmount;
      G += (lg * 255 - G) * lutAmount;
      B += (lb * 255 - B) * lutAmount;
    }
    d[p] = R;
    d[p + 1] = G;
    d[p + 2] = B;
  }

  // Clarity (local contrast in the midtones) and sharpening work on brightness only, so colours stay put.
  const clarity = clamp(g.clarity ?? 0, -1, 1);
  const sharpen = clamp(g.sharpen ?? 0, 0, 2);
  if (clarity || sharpen) {
    const Y = new Float32Array(n);
    for (let i = 0; i < n; i++) Y[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    const wide = clarity ? blurPlane(Y, r.w, r.h, Math.max(8, long / 60)) : null;
    const fine = sharpen ? blurPlane(Y, r.w, r.h, Math.max(1, long / 1800)) : null;
    for (let i = 0; i < n; i++) {
      let delta = 0;
      if (wide) {
        const m = 1 - (2 * (Y[i] / 255) - 1) ** 2;
        delta += clarity * 0.7 * (Y[i] - wide[i]) * m;
      }
      if (fine) {
        const diff = Y[i] - fine[i];
        if (Math.abs(diff) > 1.5) delta += sharpen * diff;
      }
      if (!delta) continue;
      const p = i * 4;
      d[p] += delta;
      d[p + 1] += delta;
      d[p + 2] += delta;
    }
  }

  const vignette = clamp(g.vignette ?? 0, -1, 1);
  const grain = clamp(g.grain ?? 0, 0, 1);
  if (vignette || grain) {
    const rand = random(r.w * 7919 + r.h);
    const cx = r.w / 2;
    const cy = r.h / 2;
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w; x++) {
        const p = (y * r.w + x) * 4;
        let f = 1;
        if (vignette) {
          const dist = Math.hypot((x - cx) / cx, (y - cy) / cy) / Math.SQRT2;
          f = 1 - vignette * 0.7 * smoothstep(0.4, 1.05, dist);
        }
        const noise = grain ? (rand() + rand() + rand() - 1.5) * grain * 16 : 0;
        for (let c = 0; c < 3; c++) d[p + c] = d[p + c] * f + noise;
      }
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* LUTs ($lut/<file>.cube)                                                     */
/* -------------------------------------------------------------------------- */

export interface Lut3D {
  n: number;
  data: Float32Array;
  min: RGB;
  max: RGB;
}

const lutCache = new Map<string, Promise<Lut3D>>();

export function loadLut(ref: string): Promise<Lut3D> {
  const m = /^\$lut\/([A-Za-z0-9][A-Za-z0-9._-]{0,95}\.cube)$/i.exec(ref.trim());
  if (!m) throw new MediaError(`"${ref}" isn't a LUT: use $lut/<file>.cube (video_assets lists them).`);
  let lut = lutCache.get(m[1]);
  if (!lut) {
    lut = parseCube(m[1]);
    lutCache.set(m[1], lut);
    lut.catch(() => lutCache.delete(m[1]));
  }
  return lut;
}

async function parseCube(name: string): Promise<Lut3D> {
  const text = await readFile(mediaPath("luts", name), "utf8").catch(() => {
    throw new MediaError(`There's no $lut/${name}.`);
  });
  let n = 0;
  let min: RGB = [0, 0, 0];
  let max: RGB = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("TITLE")) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === "LUT_3D_SIZE") n = Number(parts[1]);
    else if (parts[0] === "DOMAIN_MIN") min = parts.slice(1, 4).map(Number) as RGB;
    else if (parts[0] === "DOMAIN_MAX") max = parts.slice(1, 4).map(Number) as RGB;
    else if (parts[0] === "LUT_1D_SIZE") throw new MediaError(`$lut/${name} is a 1D LUT; only 3D LUTs are supported.`);
    else if (/^[-\d.]/.test(parts[0])) values.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
  }
  if (!n || n < 2 || n > 128 || values.length !== n * n * n * 3 || values.some((v) => !Number.isFinite(v))) throw new MediaError(`$lut/${name} isn't a readable .cube file.`);
  return { n, data: Float32Array.from(values), min, max };
}

/** One colour (0-1) through the LUT, trilinear. */
function applyLut(l: Lut3D, r: number, g: number, b: number): RGB {
  const n1 = l.n - 1;
  const pos = [r, g, b].map((v, c) => clamp(((v - l.min[c]) / (l.max[c] - l.min[c] || 1)) * n1, 0, n1));
  const i0 = pos.map((v) => Math.min(n1 - 1, Math.floor(v)));
  const f = pos.map((v, c) => v - i0[c]);
  const out: RGB = [0, 0, 0];
  for (let corner = 0; corner < 8; corner++) {
    const dr = corner & 1;
    const dg = (corner >> 1) & 1;
    const db = (corner >> 2) & 1;
    const w = (dr ? f[0] : 1 - f[0]) * (dg ? f[1] : 1 - f[1]) * (db ? f[2] : 1 - f[2]);
    if (!w) continue;
    const idx = (((i0[2] + db) * l.n + (i0[1] + dg)) * l.n + (i0[0] + dr)) * 3;
    out[0] += l.data[idx] * w;
    out[1] += l.data[idx + 1] * w;
    out[2] += l.data[idx + 2] * w;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Light                                                                      */
/* -------------------------------------------------------------------------- */

export interface Light {
  /** Stops at the strongest point: + brightens (dodge), − darkens (burn). */
  exposure: number;
  /** Warmer (+) or cooler (−) light where it falls, −1 to 1. */
  warmth?: number;
  /** A pool of light around a point, fading out by `radius` px... */
  centre?: Point;
  radius?: number;
  /** ...or a sweep: full at `from`, gone by `to` (px)... */
  from?: Point;
  to?: Point;
  /** ...or inside a mask (soft). */
  mask?: Mask;
}

export function light(r: Raster, l: Light): Raster {
  const out = clone(r);
  const d = out.data;
  const ev = clamp(l.exposure, -3, 3);
  const warmth = clamp(l.warmth ?? 0, -1, 1);
  const weight = (x: number, y: number, i: number): number => {
    if (l.mask) return l.mask.a[i] / 255;
    if (l.from && l.to) {
      const vx = l.to.x - l.from.x;
      const vy = l.to.y - l.from.y;
      const len2 = vx * vx + vy * vy || 1;
      return 1 - smoothstep(0, 1, ((x - l.from.x) * vx + (y - l.from.y) * vy) / len2);
    }
    const c = l.centre ?? { x: r.w / 2, y: r.h / 2 };
    const rad = l.radius ?? Math.max(r.w, r.h) / 3;
    return 1 - smoothstep(0.35, 1, Math.hypot(x - c.x, y - c.y) / rad);
  };
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const i = y * r.w + x;
      const w = weight(x, y, i);
      if (w <= 0.001) continue;
      const gain = 2 ** (ev * w);
      const p = i * 4;
      d[p] = toSrgb(LIN[d[p]] * gain * (1 + 0.15 * warmth * w));
      d[p + 1] = toSrgb(LIN[d[p + 1]] * gain);
      d[p + 2] = toSrgb(LIN[d[p + 2]] * gain * (1 - 0.15 * warmth * w));
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Backdrops, shadows and catalogue white                                     */
/* -------------------------------------------------------------------------- */

/**
 * The subject's soft edge still carries the old background's colour (a halo on a new
 * backdrop). Edge pixels take the colour of the subject just inside them instead.
 */
export function defringe(r: Raster, m: Mask): Raster {
  const n = r.w * r.h;
  const radius = Math.max(2, Math.max(r.w, r.h) / 500);
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = m.a[i] >= 250 ? 1 : 0;
  const den = blurPlane(w, r.w, r.h, radius);
  const out = clone(r);
  for (let c = 0; c < 3; c++) {
    const plane = new Float32Array(n);
    for (let i = 0; i < n; i++) plane[i] = r.data[i * 4 + c] * w[i];
    const num = blurPlane(plane, r.w, r.h, radius);
    for (let i = 0; i < n; i++) if (m.a[i] > 0 && m.a[i] < 250 && den[i] > 0.02) out.data[i * 4 + c] = num[i] / den[i];
  }
  return out;
}

/** Where the subject's shadow falls on the floor (0-1): a soft contact shadow under it and a faint one around it. */
function shadowPlane(m: Mask): Float32Array {
  const n = m.w * m.h;
  const box = maskBox(m, 127);
  const out = new Float32Array(n);
  if (!box) return out;
  const long = Math.max(m.w, m.h);
  const shift = Math.round(m.h * 0.006);
  const ambient = new Float32Array(n);
  for (let y = shift; y < m.h; y++) for (let x = 0; x < m.w; x++) ambient[y * m.w + x] = m.a[(y - shift) * m.w + x] / 255;
  const soft = blurPlane(ambient, m.w, m.h, long * 0.015);
  // The contact shadow: a flat ellipse under the subject's lowest part.
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h;
  const rx = Math.max(4, box.w * 0.45);
  const ry = Math.max(2, box.h * 0.025);
  const contact = new Float32Array(n);
  for (let y = Math.max(0, Math.floor(cy - 3 * ry)); y < Math.min(m.h, Math.ceil(cy + 3 * ry)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rx * 1.2)); x < Math.min(m.w, Math.ceil(cx + rx * 1.2)); x++) {
      const e = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (e < 1) contact[y * m.w + x] = 1 - e;
    }
  }
  const contactSoft = blurPlane(contact, m.w, m.h, Math.max(2, ry));
  for (let i = 0; i < n; i++) out[i] = clamp(0.45 * soft[i] + 0.8 * contactSoft[i], 0, 1);
  return out;
}

export interface Backdrop {
  fill: "colour" | "gradient" | "sweep" | "blur" | "image";
  colour?: RGB;
  colour2?: RGB;
  /** Gradient direction in degrees (0 = left to right, 90 = top to bottom). */
  angle?: number;
  /** Blur radius in px for "blur". */
  blur?: number;
  /** A backdrop picture, already the picture's size. */
  image?: Raster;
  /** How dark the subject's shadow on the floor is, 0 (none) to 1. */
  shadow?: number;
}

/** The subject (inside `m`) over a new backdrop. */
export function backdrop(r: Raster, m: Mask, b: Backdrop): Raster {
  const n = r.w * r.h;
  let bg: Raster;
  if (b.fill === "image") {
    if (!b.image) throw new MediaError("Which picture is the backdrop (ref)?");
    bg = b.image;
  } else if (b.fill === "blur") {
    // The photo's own background, blurred without the subject bleeding into it.
    const radius = b.blur ?? Math.max(r.w, r.h) / 60;
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 1 - m.a[i] / 255;
    const den = blurPlane(w, r.w, r.h, radius);
    bg = blank(r.w, r.h, [0, 0, 0, 255]);
    for (let c = 0; c < 3; c++) {
      const plane = new Float32Array(n);
      for (let i = 0; i < n; i++) plane[i] = r.data[i * 4 + c] * w[i];
      const num = blurPlane(plane, r.w, r.h, radius);
      const whole = blurPlane(Float32Array.from({ length: n }, (_, i) => r.data[i * 4 + c]), r.w, r.h, radius);
      for (let i = 0; i < n; i++) bg.data[i * 4 + c] = den[i] > 0.05 ? num[i] / den[i] : whole[i];
    }
  } else {
    const c1 = b.colour ?? (b.fill === "sweep" ? ([242, 239, 233] as RGB) : ([255, 255, 255] as RGB));
    const c2 = b.colour2 ?? (c1.map((v) => v * 0.85) as RGB);
    bg = blank(r.w, r.h, [c1[0], c1[1], c1[2], 255]);
    if (b.fill !== "colour") {
      const rad = ((b.angle ?? 90) * Math.PI) / 180;
      const dx = Math.cos(rad);
      const dy = Math.sin(rad);
      const span = Math.abs(dx) * r.w + Math.abs(dy) * r.h;
      const x0 = dx >= 0 ? 0 : r.w;
      const y0 = dy >= 0 ? 0 : r.h;
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) {
          let k: number;
          let shade = 1;
          if (b.fill === "gradient") k = clamp(((x - x0) * dx + (y - y0) * dy) / span, 0, 1);
          else {
            // A studio sweep: the wall a touch lighter, curving into a slightly darker floor, soft at the sides.
            const v = y / r.h;
            k = 0;
            shade = 1.03 - 0.1 * smoothstep(0.55, 0.95, v) - 0.06 * smoothstep(0.55, 1.1, Math.abs(x / r.w - 0.5) * 2);
          }
          const p = (y * r.w + x) * 4;
          for (let c = 0; c < 3; c++) bg.data[p + c] = (c1[c] + (c2[c] - c1[c]) * k) * shade;
        }
      }
    }
  }
  if (b.shadow) {
    const s = shadowPlane(m);
    const strength = clamp(b.shadow, 0, 1) * 0.55;
    bg = clone(bg);
    for (let i = 0; i < n; i++) {
      if (s[i] < 0.002) continue;
      const f = 1 - strength * s[i];
      for (let c = 0; c < 3; c++) bg.data[i * 4 + c] *= f;
    }
  }
  return over(bg, withAlpha(defringe(r, m), m));
}

export interface WhiteCheck {
  /** Share of the background that is exactly RGB 255, 255, 255 (Amazon's main image needs 100%). */
  pureWhite: number;
  /** The outermost rows and columns are all pure white. */
  edgesWhite: boolean;
  /** How much of the frame the product's long side fills (Amazon: ~0.85). */
  fill: number;
}

/** Whether a picture's background is catalogue white (the subject mask says what isn't background). */
export function whiteCheck(r: Raster, m: Mask | null): WhiteCheck {
  let bgCount = 0;
  let white = 0;
  for (let i = 0; i < r.w * r.h; i++) {
    if (m && m.a[i] > 4) continue;
    bgCount++;
    const p = i * 4;
    if (r.data[p] === 255 && r.data[p + 1] === 255 && r.data[p + 2] === 255) white++;
  }
  let edgesWhite = true;
  const pure = (x: number, y: number) => {
    const p = (y * r.w + x) * 4;
    return r.data[p] === 255 && r.data[p + 1] === 255 && r.data[p + 2] === 255;
  };
  for (let x = 0; x < r.w && edgesWhite; x++) edgesWhite = pure(x, 0) && pure(x, r.h - 1);
  for (let y = 0; y < r.h && edgesWhite; y++) edgesWhite = pure(0, y) && pure(r.w - 1, y);
  const box = m ? maskBox(m, 127) : null;
  return {
    pureWhite: Math.round((white / Math.max(1, bgCount)) * 1000) / 1000,
    edgesWhite,
    fill: box ? Math.round(Math.max(box.w / r.w, box.h / r.h) * 100) / 100 : 0,
  };
}

/** The subject alone, centred on pure white at `fill` of the frame (Amazon's main image). */
export async function catalogueWhite(r: Raster, m: Mask, opts: { width: number; height: number; fill: number }): Promise<{ raster: Raster; mask: Mask }> {
  const box = maskBox(m, 16);
  if (!box) throw new MediaError("There's no subject to put on white.");
  const subject = withAlpha(defringe(crop(r, box.x, box.y, box.w, box.h), cropMask(m, box)), cropMask(m, box));
  const scale = clamp(opts.fill, 0.3, 1) * Math.min(opts.width / box.w, opts.height / box.h);
  const sw = Math.max(1, Math.round(box.w * scale));
  const sh = Math.max(1, Math.round(box.h * scale));
  const placed = await resize(subject, sw, sh);
  const x = Math.round((opts.width - sw) / 2);
  const y = Math.round((opts.height - sh) / 2);
  const raster = over(blank(opts.width, opts.height, [255, 255, 255, 255]), placed, x, y);
  const mask: Mask = { w: opts.width, h: opts.height, a: new Uint8Array(opts.width * opts.height) };
  // The faintest edge pixels (alpha a few levels above 0) would leave near-white specks: they count as background.
  for (let j = 0; j < sh; j++) {
    for (let i = 0; i < sw; i++) {
      const a = placed.data[(j * sw + i) * 4 + 3];
      mask.a[(y + j) * opts.width + x + i] = a <= 6 ? 0 : a;
    }
  }
  // Whatever the subject doesn't cover is exactly white (no near-white from resampling).
  for (let i = 0; i < mask.a.length; i++) if (mask.a[i] === 0) raster.data.set([255, 255, 255, 255], i * 4);
  return { raster, mask };
}

export function cropMask(m: Mask, box: Box): Mask {
  const x = Math.round(box.x);
  const y = Math.round(box.y);
  const w = Math.round(box.w);
  const h = Math.round(box.h);
  const out: Mask = { w, h, a: new Uint8Array(w * h) };
  for (let j = 0; j < h; j++) {
    const sy = y + j;
    if (sy < 0 || sy >= m.h) continue;
    for (let i = 0; i < w; i++) {
      const sx = x + i;
      if (sx >= 0 && sx < m.w) out.a[j * w + i] = m.a[sy * m.w + sx];
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Size and shape                                                             */
/* -------------------------------------------------------------------------- */

/** The largest box of `aspect` (w/h) inside the picture, centred on `focus` as far as it can be. */
export function aspectBox(w: number, h: number, aspect: number, focus: Point): Box {
  let bw = w;
  let bh = w / aspect;
  if (bh > h) {
    bh = h;
    bw = h * aspect;
  }
  const x = clamp(focus.x - bw / 2, 0, w - bw);
  const y = clamp(focus.y - bh / 2, 0, h - bh);
  return { x: Math.round(x), y: Math.round(y), w: Math.round(bw), h: Math.round(bh) };
}

/**
 * Exactly `width` x `height`: cover (fill it, cropping around `focus`), pad (all of the
 * picture, the rest `colour`), or stretch.
 */
export async function fit(r: Raster, width: number, height: number, mode: "cover" | "pad" | "stretch", opts: { colour?: RGB; focus?: Point } = {}): Promise<Raster> {
  if (mode === "stretch") return resize(r, width, height);
  if (mode === "cover") {
    const box = aspectBox(r.w, r.h, width / height, opts.focus ?? { x: r.w / 2, y: r.h / 2 });
    return resize(crop(r, box.x, box.y, box.w, box.h), width, height);
  }
  const scale = Math.min(width / r.w, height / r.h);
  const sw = Math.max(1, Math.round(r.w * scale));
  const sh = Math.max(1, Math.round(r.h * scale));
  const colour = opts.colour ?? borderColour(r);
  return over(blank(width, height, [colour[0], colour[1], colour[2], 255]), await resize(r, sw, sh), Math.round((width - sw) / 2), Math.round((height - sh) / 2));
}

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The padding (px) that takes the picture to `aspect` (w/h) without cropping, split per `anchor` (where the picture stays). */
export function padTo(w: number, h: number, aspect: number, anchor: "centre" | "top" | "bottom" | "left" | "right" = "centre"): Padding {
  const pad: Padding = { top: 0, right: 0, bottom: 0, left: 0 };
  if (w / h < aspect) {
    const extra = Math.round(h * aspect) - w;
    pad.left = anchor === "left" ? 0 : anchor === "right" ? extra : Math.floor(extra / 2);
    pad.right = extra - pad.left;
  } else {
    const extra = Math.round(w / aspect) - h;
    pad.top = anchor === "top" ? 0 : anchor === "bottom" ? extra : Math.floor(extra / 2);
    pad.bottom = extra - pad.top;
  }
  return pad;
}

/**
 * The canvas grown by `pad` px, the new part filled with a colour, the picture mirrored
 * or its edge stretched (both blurred away from the seam). "inpaint" starts from the
 * mirror; the caller fills the returned hole with LaMa.
 */
export function extend(r: Raster, pad: Padding, fill: "colour" | "mirror" | "edge", colour?: RGB): { raster: Raster; hole: Mask } {
  const W = r.w + pad.left + pad.right;
  const H = r.h + pad.top + pad.bottom;
  const out = blank(W, H, [0, 0, 0, 255]);
  const hole: Mask = { w: W, h: H, a: new Uint8Array(W * H) };
  const c = colour ?? borderColour(r);
  const reflect = (i: number, len: number) => {
    let v = i;
    for (let k = 0; k < 4 && (v < 0 || v >= len); k++) v = v < 0 ? -v - 1 : 2 * len - v - 1;
    return clamp(v, 0, len - 1);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = x - pad.left;
      const sy = y - pad.top;
      const inside = sx >= 0 && sy >= 0 && sx < r.w && sy < r.h;
      const p = (y * W + x) * 4;
      if (inside) {
        out.data.set(r.data.subarray((sy * r.w + sx) * 4, (sy * r.w + sx) * 4 + 4), p);
        continue;
      }
      hole.a[y * W + x] = 255;
      if (fill === "colour") out.data.set([c[0], c[1], c[2], 255], p);
      else {
        const tx = fill === "mirror" ? reflect(sx, r.w) : clamp(sx, 0, r.w - 1);
        const ty = fill === "mirror" ? reflect(sy, r.h) : clamp(sy, 0, r.h - 1);
        out.data.set(r.data.subarray((ty * r.w + tx) * 4, (ty * r.w + tx) * 4 + 4), p);
      }
    }
  }
  if (fill === "colour") return { raster: out, hole };
  // Blur the new part more the further it is from the picture, so it reads as out-of-focus surroundings.
  const blurred = blurRaster(out, Math.max(4, Math.max(W, H) / 80));
  const dist = new Float32Array(W * H);
  for (let i = 0; i < dist.length; i++) dist[i] = hole.a[i] / 255;
  const ramp = blurPlane(dist, W, H, Math.max(6, Math.max(W, H) / 60));
  const weight: Mask = { w: W, h: H, a: Uint8Array.from(ramp, (v, i) => (hole.a[i] ? Math.round(clamp(v * 2, 0, 1) * 255) : 0)) };
  return { raster: blend(out, blurred, weight), hole };
}

/** A quarter turn (90, 180 or 270 clockwise) and/or a mirror. */
export function turn(r: Raster, degrees: 0 | 90 | 180 | 270, flip?: "horizontal" | "vertical"): Raster {
  const W = degrees % 180 === 0 ? r.w : r.h;
  const H = degrees % 180 === 0 ? r.h : r.w;
  const out = blank(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const fx = flip === "horizontal" ? W - 1 - x : x;
      const fy = flip === "vertical" ? H - 1 - y : y;
      let sx: number;
      let sy: number;
      if (degrees === 90) [sx, sy] = [fy, r.h - 1 - fx];
      else if (degrees === 180) [sx, sy] = [r.w - 1 - fx, r.h - 1 - fy];
      else if (degrees === 270) [sx, sy] = [r.w - 1 - fy, fx];
      else [sx, sy] = [fx, fy];
      out.data.set(r.data.subarray((sy * r.w + sx) * 4, (sy * r.w + sx) * 4 + 4), (y * W + x) * 4);
    }
  }
  return out;
}

/** Straighten by a small angle (degrees, + clockwise), cropped to the largest upright box with no empty corners. */
export async function straighten(r: Raster, degrees: number): Promise<Raster> {
  const a = (degrees * Math.PI) / 180;
  const c = await toCanvas(r);
  const { createCanvas } = await import("@napi-rs/canvas");
  const out = createCanvas(r.w, r.h);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.translate(r.w / 2, r.h / 2);
  ctx.rotate(a);
  ctx.drawImage(c, -r.w / 2, -r.h / 2);
  // The largest axis-aligned rectangle inside the turned one.
  const sin = Math.abs(Math.sin(a));
  const cos = Math.abs(Math.cos(a));
  const longer = r.w >= r.h;
  const [sl, ss] = longer ? [r.w, r.h] : [r.h, r.w];
  let wr: number;
  let hr: number;
  if (ss <= 2 * sin * cos * sl || Math.abs(sin - cos) < 1e-10) {
    const x = 0.5 * ss;
    [wr, hr] = longer ? [x / sin, x / cos] : [x / cos, x / sin];
  } else {
    const cos2 = cos * cos - sin * sin;
    [wr, hr] = [(r.w * cos - r.h * sin) / cos2, (r.h * cos - r.w * sin) / cos2];
  }
  const turned = await fromCanvas(out);
  const w = Math.floor(wr) - 2;
  const h = Math.floor(hr) - 2;
  return crop(turned, (r.w - w) / 2, (r.h - h) / 2, w, h);
}

/** The colour at (x, y) px, bilinear, edges repeated. */
function sampleInto(r: Raster, x: number, y: number, out: Uint8ClampedArray, o: number) {
  const fx = clamp(x - 0.5, 0, r.w - 1);
  const fy = clamp(y - 0.5, 0, r.h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(r.w - 1, x0 + 1);
  const y1 = Math.min(r.h - 1, y0 + 1);
  const ax = fx - x0;
  const ay = fy - y0;
  const p00 = (y0 * r.w + x0) * 4;
  const p10 = (y0 * r.w + x1) * 4;
  const p01 = (y1 * r.w + x0) * 4;
  const p11 = (y1 * r.w + x1) * 4;
  for (let c = 0; c < 4; c++) {
    const top = r.data[p00 + c] * (1 - ax) + r.data[p10 + c] * ax;
    const bottom = r.data[p01 + c] * (1 - ax) + r.data[p11 + c] * ax;
    out[o + c] = top * (1 - ay) + bottom * ay;
  }
}

/** Solve a small linear system (Gaussian elimination with pivoting). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    if (Math.abs(M[col][col]) < 1e-12) throw new MediaError("Those corners don't make a four-sided shape.");
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/**
 * A slanted rectangle (a garment shot at an angle, a label) made square to the camera:
 * the four corners (px; top-left, top-right, bottom-right, bottom-left) become the edges
 * of the result.
 */
export function perspective(r: Raster, corners: [Point, Point, Point, Point]): Raster {
  const [tl, tr, br, bl] = corners;
  const W = Math.round(Math.max(Math.hypot(tr.x - tl.x, tr.y - tl.y), Math.hypot(br.x - bl.x, br.y - bl.y)));
  const H = Math.round(Math.max(Math.hypot(bl.x - tl.x, bl.y - tl.y), Math.hypot(br.x - tr.x, br.y - tr.y)));
  if (W < 8 || H < 8) throw new MediaError("Those corners are too close together.");
  const src = [
    [0, 0, tl],
    [W, 0, tr],
    [W, H, br],
    [0, H, bl],
  ] as const;
  const A: number[][] = [];
  const b: number[] = [];
  for (const [u, v, p] of src) {
    A.push([u, v, 1, 0, 0, 0, -u * p.x, -v * p.x]);
    b.push(p.x);
    A.push([0, 0, 0, u, v, 1, -u * p.y, -v * p.y]);
    b.push(p.y);
  }
  const h = solve(A, b);
  const out = blank(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x + 0.5;
      const v = y + 0.5;
      const z = h[6] * u + h[7] * v + 1;
      sampleInto(r, (h[0] * u + h[1] * v + h[2]) / z, (h[3] * u + h[4] * v + h[5]) / z, out.data, (y * W + x) * 4);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Retouching                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Smoother skin that keeps its texture (frequency separation): the uneven tone in between
 * (blotches, shine, small blemishes) is evened out, the fine grain (pores) stays.
 */
export function smoothSkin(r: Raster, m: Mask, amount: number, radius?: number): Raster {
  const long = Math.max(r.w, r.h);
  const R = radius ?? Math.max(3, long / 250);
  const low = blurRaster(r, R);
  const fine = blurRaster(r, Math.max(1, R / 5));
  const k = clamp(amount, 0, 1);
  const out = clone(r);
  for (let p = 0; p < out.data.length; p += 4) {
    for (let c = 0; c < 3; c++) {
      const mid = fine.data[p + c] - low.data[p + c];
      const grain = r.data[p + c] - fine.data[p + c];
      out.data[p + c] = low.data[p + c] + mid * (1 - k) + grain * (1 - 0.25 * k);
    }
  }
  return blend(r, out, m);
}

/* -------------------------------------------------------------------------- */
/* Compose: layers and text                                                   */
/* -------------------------------------------------------------------------- */

export interface Layer {
  image: Raster;
  /** Top-left and width in px; height follows the layer's shape. */
  x: number;
  y: number;
  width: number;
  opacity?: number;
  /** Degrees, + clockwise, about the layer's centre. */
  rotate?: number;
  /** A soft drop shadow, 0-1. */
  shadow?: number;
}

export interface TextBlock {
  text: string;
  /** The anchor (px): `align` says which side of the text it is; `y` is the top. */
  x: number;
  y: number;
  /** Letter height in px. */
  size: number;
  colour: string;
  /** "$font/<file>". */
  font: string;
  align?: "left" | "centre" | "right";
  /** Wrap at this width (px). */
  maxWidth?: number;
  lineHeight?: number;
  /** A box behind the text. */
  background?: string;
  opacity?: number;
  shadow?: boolean;
}

const fonts = new Map<string, string>();

async function fontFamily(ref: string): Promise<string> {
  const m = /^\$font\/([A-Za-z0-9][A-Za-z0-9._-]{0,95})$/.exec(ref.trim());
  if (!m) throw new MediaError(`"${ref}" isn't a font: use $font/<file> (video_assets lists the fonts; add_font adds a Google font).`);
  const known = fonts.get(m[1]);
  if (known) return known;
  const file = mediaPath("fonts", m[1]);
  await stat(file).catch(() => {
    throw new MediaError(`There's no ${ref}.`);
  });
  const { GlobalFonts } = await import("@napi-rs/canvas");
  const family = `seelie ${m[1].replace(/\.[^.]+$/, "")}`;
  if (!GlobalFonts.registerFromPath(file, family)) throw new MediaError(`${ref} couldn't be loaded as a font.`);
  fonts.set(m[1], family);
  return family;
}

export async function compose(base: Raster, layers: Layer[], texts: TextBlock[]): Promise<Raster> {
  const canvas = await toCanvas(base);
  // Layers are resized first and drawn at their own size (Skia's default bilinear only
  // matters for a turn or a fractional offset; "high" would soften them).
  const ctx = canvas.getContext("2d");
  for (const l of layers) {
    const h = Math.round((l.width * l.image.h) / l.image.w);
    const src = await toCanvas(await resize(l.image, Math.max(1, Math.round(l.width)), Math.max(1, h)));
    ctx.save();
    ctx.globalAlpha = clamp(l.opacity ?? 1, 0, 1);
    if (l.shadow) {
      ctx.shadowColor = `rgba(0,0,0,${clamp(l.shadow, 0, 1) * 0.5})`;
      ctx.shadowBlur = Math.max(4, l.width * 0.04);
      ctx.shadowOffsetY = Math.max(2, l.width * 0.015);
    }
    ctx.translate(l.x + l.width / 2, l.y + h / 2);
    if (l.rotate) ctx.rotate((l.rotate * Math.PI) / 180);
    ctx.drawImage(src, -l.width / 2, -h / 2, l.width, h);
    ctx.restore();
  }
  for (const t of texts) {
    const family = await fontFamily(t.font);
    ctx.save();
    ctx.globalAlpha = clamp(t.opacity ?? 1, 0, 1);
    ctx.font = `${Math.round(t.size)}px "${family}"`;
    ctx.textBaseline = "top";
    const lines: string[] = [];
    for (const para of t.text.split("\n")) {
      if (!t.maxWidth) {
        lines.push(para);
        continue;
      }
      let line = "";
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (line && ctx.measureText(next).width > t.maxWidth) {
          lines.push(line);
          line = word;
        } else line = next;
      }
      lines.push(line);
    }
    const lh = t.size * (t.lineHeight ?? 1.2);
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const align = t.align ?? "left";
    const left = align === "left" ? t.x : align === "right" ? t.x - width : t.x - width / 2;
    if (t.background) {
      const pad = t.size * 0.4;
      ctx.fillStyle = t.background;
      ctx.beginPath();
      ctx.roundRect(left - pad, t.y - pad, width + 2 * pad, lines.length * lh + 2 * pad - (lh - t.size), pad * 0.6);
      ctx.fill();
    }
    if (t.shadow) {
      ctx.shadowColor = "rgba(0,0,0,0.45)";
      ctx.shadowBlur = t.size * 0.15;
      ctx.shadowOffsetY = t.size * 0.05;
    }
    ctx.fillStyle = t.colour;
    ctx.textAlign = align === "centre" ? "center" : align;
    lines.forEach((l, i) => ctx.fillText(l, t.x, t.y + i * lh));
    ctx.restore();
  }
  return fromCanvas(canvas);
}
