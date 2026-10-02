import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { inpaint } from "./inpaint";
import { decode, emptyMask, grow, type Raster } from "./raster";

/**
 * Removing Gemini's visible watermark (the sparkle in the bottom-right corner of images
 * made in the Gemini app; images made through the API carry none). Gemini blends a white
 * logo over the picture: marked = α·255 + (1 − α)·original, so the original comes back
 * exactly by reversing it: original = (marked − α·255) / (1 − α). Lossless wherever the
 * mark didn't clip at white; those few pixels are filled by LaMa.
 *
 * The α maps (48 px and 96 px sparkles, and the 96 px one Gemini switched to in May 2026)
 * are the calibrated captures from GargantuaX/gemini-watermark-remover (MIT, after
 * AllenK's GeminiWatermarkTool; LICENSE-gemini-watermark-remover beside them).
 *
 * Finding it: Gemini puts the logo at the same distance from the right and bottom edges,
 * so the search runs along that diagonal over the logo's possible sizes (a resized image
 * scales it). Each spot is scored by how well the picture's edges line up with the logo's
 * outline (the correlation of their gradients), which a busy background or a bright blob
 * that merely sits in the corner doesn't fake. Gemini's own placements need less evidence
 * than an odd size or spot. The blend strength (JPEG and resizing weaken it) is then
 * solved so that no trace of the outline is left.
 */

const DIR = path.join(process.cwd(), "src/lib/seelie/studio/watermark");

interface Template {
  /** e.g. "96", or "48@40" for the 48 px capture scaled to 40 px. */
  name: string;
  base: string;
  size: number;
  native: boolean;
  alpha: Float32Array;
  /** α's gradient, and the pixels near the outline that the score looks at. */
  gx: Float32Array;
  gy: Float32Array;
  support: Int32Array;
  energy: number;
}

/** Where Gemini puts each logo (its native size, the same margin right and bottom). */
const PLACEMENTS: [base: string, margin: number][] = [
  ["48", 32],
  ["48", 96],
  ["48", 89],
  ["96", 64],
  ["96-2026", 192],
  ["96-2026", 64],
];

/** Gradient correlation needed: at one of Gemini's placements, elsewhere at native size, and scaled. */
const NEED = { placement: 0.3, native: 0.4, scaled: 0.45 };

function prepare(name: string, base: string, size: number, alpha: Float32Array, native: boolean): Template {
  const A = (x: number, y: number) => (x < 0 || y < 0 || x >= size || y >= size ? 0 : alpha[y * size + x]);
  const gx = new Float32Array(size * size);
  const gy = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      gx[y * size + x] = A(x + 1, y) - A(x - 1, y);
      gy[y * size + x] = A(x, y + 1) - A(x, y - 1);
    }
  }
  const edge = (x: number, y: number) => x >= 0 && y >= 0 && x < size && y < size && Math.hypot(gx[y * size + x], gy[y * size + x]) > 0.02;
  const support: number[] = [];
  let energy = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let near = false;
      for (let j = -2; j <= 2 && !near; j++) for (let i = -2; i <= 2 && !near; i++) near = edge(x + i, y + j);
      if (!near) continue;
      support.push(y * size + x);
      energy += gx[y * size + x] ** 2 + gy[y * size + x] ** 2;
    }
  }
  return { name, base, size, native, alpha, gx, gy, support: Int32Array.from(support), energy };
}

let bases: Promise<Template[]> | null = null;

async function loadBases(): Promise<Template[]> {
  bases ??= Promise.all(
    [
      ["48", "bg_48.png"],
      ["96", "bg_96.png"],
      ["96-2026", "bg_96_20260520.png"],
    ].map(async ([name, file]) => {
      const r = await decode(await readFile(path.join(DIR, file)));
      const alpha = new Float32Array(r.w * r.h);
      for (let i = 0; i < alpha.length; i++) alpha[i] = Math.max(r.data[i * 4], r.data[i * 4 + 1], r.data[i * 4 + 2]) / 255;
      return prepare(name, name, r.w, alpha, true);
    }),
  );
  return bases;
}

/** A base α map resampled to `size` (bilinear on the pixel grid's centres). */
function rescale(t: Template, size: number): Template {
  if (size === t.size) return t;
  const out = new Float32Array(size * size);
  const k = t.size / size;
  for (let y = 0; y < size; y++) {
    const sy = Math.min(t.size - 1, Math.max(0, (y + 0.5) * k - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(t.size - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < size; x++) {
      const sx = Math.min(t.size - 1, Math.max(0, (x + 0.5) * k - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(t.size - 1, x0 + 1);
      const fx = sx - x0;
      const top = t.alpha[y0 * t.size + x0] * (1 - fx) + t.alpha[y0 * t.size + x1] * fx;
      const bottom = t.alpha[y1 * t.size + x0] * (1 - fx) + t.alpha[y1 * t.size + x1] * fx;
      out[y * size + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return prepare(`${t.base}@${size}`, t.base, size, out, false);
}

/** Brightness of a region of the picture (x0, y0 is its top-left in the picture). */
interface Lum {
  x0: number;
  y0: number;
  w: number;
  h: number;
  l: Float32Array;
}

function luminance(r: Raster, x0: number, y0: number, w: number, h: number): Lum {
  const l = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = ((y0 + y) * r.w + x0 + x) * 4;
      l[y * w + x] = 0.299 * r.data[p] + 0.587 * r.data[p + 1] + 0.114 * r.data[p + 2];
    }
  }
  return { x0, y0, w, h, l };
}

/** How well the edges at (x, y) (picture px) line up with the logo's outline: −1 to 1. */
function outlineScore(L: Lum, t: Template, x: number, y: number): number {
  let num = 0;
  let energy = 0;
  const s = t.size;
  for (const k of t.support) {
    const i = k % s;
    const X = x + i - L.x0;
    const Y = y + (k - i) / s - L.y0;
    if (X < 1 || Y < 1 || X >= L.w - 1 || Y >= L.h - 1) continue;
    const p = Y * L.w + X;
    const ix = L.l[p + 1] - L.l[p - 1];
    const iy = L.l[p + L.w] - L.l[p - L.w];
    num += ix * t.gx[k] + iy * t.gy[k];
    energy += ix * ix + iy * iy;
  }
  return energy > 1e-6 ? num / Math.sqrt(energy * t.energy) : 0;
}

/** The logo's window with the blend reversed at strength `gain` (1 px of untouched border around it). */
function reversed(r: Raster, t: Template, x: number, y: number, gain: number): Raster {
  const W = t.size + 2;
  const out = { w: W, h: W, data: new Uint8ClampedArray(W * W * 4) };
  for (let j = -1; j <= t.size; j++) {
    for (let i = -1; i <= t.size; i++) {
      const X = Math.min(r.w - 1, Math.max(0, x + i));
      const Y = Math.min(r.h - 1, Math.max(0, y + j));
      const s = (Y * r.w + X) * 4;
      const d = ((j + 1) * W + i + 1) * 4;
      const inside = i >= 0 && j >= 0 && i < t.size && j < t.size;
      const a = inside ? Math.min(0.99, t.alpha[j * t.size + i] * gain) : 0;
      for (let c = 0; c < 3; c++) out.data[d + c] = a < 0.002 ? r.data[s + c] : (r.data[s + c] - a * 255) / (1 - a);
      out.data[d + 3] = r.data[s + 3];
    }
  }
  return out;
}

export interface WatermarkFound {
  template: string;
  size: number;
  x: number;
  y: number;
  /** How well the corner's edges matched the logo's outline (0-1) before, and after removal (~0). */
  before: number;
  after: number;
  gain: number;
  /** Pixels that were clipped at white and were filled by inpainting. */
  filled: number;
}

interface Hit {
  t: Template;
  x: number;
  y: number;
  score: number;
  need: number;
}

const near = (a: Hit, b: Hit) => a.t.base === b.t.base && Math.abs(a.t.size - b.t.size) <= 6 && Math.abs(a.x - b.x) <= 6 && Math.abs(a.y - b.y) <= 6;

function needFor(r: Raster, t: Template, x: number, y: number): number {
  if (!t.native) return NEED.scaled;
  const mx = r.w - t.size - x;
  const my = r.h - t.size - y;
  return PLACEMENTS.some(([base, m]) => base === t.base && Math.abs(mx - m) <= 2 && Math.abs(my - m) <= 2) ? NEED.placement : NEED.native;
}

/** Where the logo is, if it's there. */
export async function findWatermark(r: Raster): Promise<Hit | null> {
  const natives = await loadBases();
  const maxMargin = Math.min(Math.round(Math.max(r.w, r.h) * 0.12), 320);
  const side = Math.min(r.w, r.h, maxMargin + 192 + 8);
  const L = luminance(r, r.w - side, r.h - side, side, side);
  const fits = (t: Template, x: number, y: number) => x >= L.x0 && y >= L.y0 && x + t.size <= r.w && y + t.size <= r.h;

  // Every size: the captures, and scales of them (each from the capture closest in size).
  const templates: Template[] = [];
  for (const base of natives) {
    if (base.size * 3 <= Math.min(r.w, r.h)) templates.push(base);
    for (let s = 32; s <= 192; s += s < 64 ? 2 : 4) {
      if (s === base.size || (base.size === 48) !== (s <= 64) || s * 3 > Math.min(r.w, r.h)) continue;
      templates.push(rescale(base, s));
    }
  }

  // Along the diagonal (natives also a pixel off it), keeping the best few distinct spots.
  const top: Hit[] = [];
  const consider = (h: Hit) => {
    const i = top.findIndex((o) => near(o, h));
    if (i >= 0) {
      if (top[i].score >= h.score) return;
      top.splice(i, 1);
    }
    top.push(h);
    top.sort((a, b) => b.score - a.score);
    if (top.length > 6) top.pop();
  };
  for (const t of templates) {
    const offsets = t.native ? [-1, 0, 1] : [0];
    for (let m = 4; m <= maxMargin; m++) {
      for (const dy of offsets) {
        for (const dx of offsets) {
          const x = r.w - t.size - m + dx;
          const y = r.h - t.size - m + dy;
          if (!fits(t, x, y)) continue;
          consider({ t, x, y, score: outlineScore(L, t, x, y), need: 0 });
        }
      }
    }
  }

  // Refine each: a few px either way, and (scaled) a px or two either side in size.
  let best: Hit | null = null;
  for (const hit of top) {
    const base = natives.find((b) => b.name === hit.t.base)!;
    const sizes = hit.t.native ? [hit.t.size] : [-2, -1, 0, 1, 2].map((d) => hit.t.size + d).filter((s) => s >= 30 && s !== base.size);
    for (const s of sizes) {
      const t = s === hit.t.size ? hit.t : rescale(base, s);
      const shift = Math.round((s - hit.t.size) / 2);
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const x = hit.x - shift + dx;
          const y = hit.y - shift + dy;
          if (!fits(t, x, y)) continue;
          const score = outlineScore(L, t, x, y);
          const need = needFor(r, t, x, y);
          if (score >= need && (!best || score - need > best.score - best.need)) best = { t, x, y, score, need };
        }
      }
    }
  }
  return best;
}

/**
 * The picture with Gemini's sparkle removed, or null when there isn't one (the picture
 * is then untouched).
 */
export async function removeWatermark(
  r: Raster,
  opts: { progress: (text: string) => void; signal: AbortSignal },
): Promise<{ raster: Raster; found: WatermarkFound } | null> {
  opts.progress("Looking for the Gemini sparkle…");
  const hit = await findWatermark(r);
  if (!hit) return null;
  const { t, x, y } = hit;

  // The strength at which the outline is gone: too little leaves a white ghost (the score
  // stays positive), too much a dark one (it turns negative), so bisect for zero.
  const after = (g: number) => {
    const w = reversed(r, t, x, y, g);
    return outlineScore(luminance(w, 0, 0, w.w, w.h), t, 1, 1);
  };
  let lo = 0.05;
  let hi = 1.6;
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2;
    if (after(mid) > 0) lo = mid;
    else hi = mid;
  }
  const gain = Math.round(((lo + hi) / 2) * 1000) / 1000;
  // Hardly any strength, or more than the logo has: not the logo after all.
  if (gain < 0.2 || gain > 1.5) return null;
  const residual = after(gain);
  const cleaned = reversed(r, t, x, y, gain);

  const out = { w: r.w, h: r.h, data: new Uint8ClampedArray(r.data) };
  const W = t.size + 2;
  for (let j = 0; j < t.size; j++) out.data.set(cleaned.data.subarray(((j + 1) * W + 1) * 4, ((j + 1) * W + 1 + t.size) * 4), ((y + j) * r.w + x) * 4);

  // Where the mark was at full white the original can't be solved: fill those from around them.
  const hole = emptyMask(r.w, r.h);
  let clipped = 0;
  for (let j = 0; j < t.size; j++) {
    for (let i = 0; i < t.size; i++) {
      const a = t.alpha[j * t.size + i] * gain;
      const p = ((y + j) * r.w + x + i) * 4;
      if (a > 0.25 && Math.min(r.data[p], r.data[p + 1], r.data[p + 2]) >= 253) {
        hole.a[(y + j) * r.w + x + i] = 255;
        clipped++;
      }
    }
  }
  const raster = clipped > 4 ? await inpaint(out, grow(hole, 1), opts) : out;
  return {
    raster,
    found: {
      template: t.name,
      size: t.size,
      x,
      y,
      before: Math.round(hit.score * 100) / 100,
      after: Math.round(residual * 100) / 100,
      gain,
      filled: clipped > 4 ? clipped : 0,
    },
  };
}
