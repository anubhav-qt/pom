import "server-only";

import { blend, clone, hex, type Mask, type Raster } from "./raster";

/**
 * Colour maths for checking a shoot against the real garment: CIELAB (D65), the
 * CIEDE2000 difference (ΔE00: under ~2 is invisible, 2-5 is a slight drift, past ~5 the
 * colour reads as different), a garment's main colours, and moving a region's colour
 * onto the original's (mean and spread per Lab channel, the Reinhard transfer).
 */

export type Lab = [number, number, number];

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

const LINEAR = Float32Array.from({ length: 256 }, (_, i) => toLinear(i));
const XN = 0.95047;
const ZN = 1.08883;
const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
const finv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));

export function rgbToLab(r: number, g: number, b: number): Lab {
  const R = LINEAR[Math.round(r)];
  const G = LINEAR[Math.round(g)];
  const B = LINEAR[Math.round(b)];
  const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / XN;
  const y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B;
  const z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / ZN;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

export function labToRgb([L, a, b]: Lab): [number, number, number] {
  const fy = (L + 16) / 116;
  const x = finv(fy + a / 500) * XN;
  const y = finv(fy);
  const z = finv(fy - b / 200) * ZN;
  const R = 3.2404542 * x - 1.5371385 * y - 0.4985314 * z;
  const G = -0.969266 * x + 1.8760108 * y + 0.041556 * z;
  const B = 0.0556434 * x - 0.2040259 * y + 1.0572252 * z;
  return [R, G, B].map((v) => Math.min(255, Math.max(0, toSrgb(Math.max(0, v))))) as [number, number, number];
}

/** CIEDE2000 (Sharma, Wu and Dalal's formulation). */
export function deltaE2000([L1, a1, b1]: Lab, [L2, a2, b2]: Lab): number {
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (b: number, a: number) => {
    if (b === 0 && a === 0) return 0;
    const h = Math.atan2(b, a) / rad;
    return h >= 0 ? h : h + 360;
  };
  const h1p = hue(b1, a1p);
  const h2p = hue(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hbarp = (h1p + h2p) / 2;
    else hbarp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hbarp - 30) * rad) +
    0.24 * Math.cos(2 * hbarp * rad) +
    0.32 * Math.cos((3 * hbarp + 6) * rad) -
    0.2 * Math.cos((4 * hbarp - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hbarp - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cbarp ** 7 / (Cbarp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lbarp - 50) ** 2) / Math.sqrt(20 + (Lbarp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  return Math.sqrt((dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh));
}

/** Lab values of the pixels inside a mask (sampled to at most `max`). */
function sample(r: Raster, m: Mask | null, max = 60_000): Lab[] {
  const n = r.w * r.h;
  const inside: number[] = [];
  for (let i = 0; i < n; i++) if ((m ? m.a[i] : 255) > 200 && r.data[i * 4 + 3] > 200) inside.push(i);
  const step = Math.max(1, Math.floor(inside.length / max));
  const out: Lab[] = [];
  for (let k = 0; k < inside.length; k += step) {
    const p = inside[k] * 4;
    out.push(rgbToLab(r.data[p], r.data[p + 1], r.data[p + 2]));
  }
  return out;
}

export interface Swatch {
  lab: Lab;
  hex: string;
  /** Share of the region, 0-1. */
  share: number;
}

/** The main colours of a region (k-means in Lab), biggest first; tiny clusters dropped. */
export function palette(r: Raster, m: Mask | null, k = 5): Swatch[] {
  const pts = sample(r, m);
  if (pts.length === 0) return [];
  // Seeds spread by k-means++ (deterministic: the farthest point each time).
  const centres: Lab[] = [pts[Math.floor(pts.length / 2)]];
  while (centres.length < Math.min(k, pts.length)) {
    let best = 0;
    let far = -1;
    for (let i = 0; i < pts.length; i += 7) {
      const d = Math.min(...centres.map((c) => (c[0] - pts[i][0]) ** 2 + (c[1] - pts[i][1]) ** 2 + (c[2] - pts[i][2]) ** 2));
      if (d > far) {
        far = d;
        best = i;
      }
    }
    centres.push(pts[best]);
  }
  const assign = new Int32Array(pts.length);
  for (let iter = 0; iter < 12; iter++) {
    const sums = centres.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i++) {
      let bi = 0;
      let bd = Infinity;
      for (let c = 0; c < centres.length; c++) {
        const d = (centres[c][0] - pts[i][0]) ** 2 + (centres[c][1] - pts[i][1]) ** 2 + (centres[c][2] - pts[i][2]) ** 2;
        if (d < bd) {
          bd = d;
          bi = c;
        }
      }
      assign[i] = bi;
      const s = sums[bi];
      s[0] += pts[i][0];
      s[1] += pts[i][1];
      s[2] += pts[i][2];
      s[3]++;
    }
    for (let c = 0; c < centres.length; c++) if (sums[c][3]) centres[c] = [sums[c][0] / sums[c][3], sums[c][1] / sums[c][3], sums[c][2] / sums[c][3]];
  }
  const counts = centres.map((_, c) => assign.filter((a) => a === c).length);
  // Clusters that ended up nearly the same colour are one colour.
  const merged: { lab: Lab; n: number }[] = [];
  centres.forEach((lab, c) => {
    const same = merged.find((m2) => deltaE2000(m2.lab, lab) < 4);
    if (same) {
      const n = same.n + counts[c];
      same.lab = same.lab.map((v, i) => (v * same.n + lab[i] * counts[c]) / n) as Lab;
      same.n = n;
    } else merged.push({ lab, n: counts[c] });
  });
  return merged
    .filter((m2) => m2.n / pts.length >= 0.03)
    .sort((a, b) => b.n - a.n)
    .map((m2) => ({ lab: m2.lab.map((v) => Math.round(v * 10) / 10) as Lab, hex: hex(labToRgb(m2.lab)), share: Math.round((m2.n / pts.length) * 100) / 100 }));
}

export interface ColourMatch {
  original: Swatch;
  result: Swatch | null;
  deltaE: number | null;
  /** In words: matches / slight drift / visible drift / different. */
  verdict: string;
}

export const deltaVerdict = (d: number) => (d < 2 ? "matches" : d < 5 ? "slight drift" : d < 10 ? "visible drift" : "different");

/** Each of the original's main colours against the nearest one in the result. */
export function compareColours(original: Swatch[], result: Swatch[]): ColourMatch[] {
  return original.map((o) => {
    let best: Swatch | null = null;
    let bd = Infinity;
    for (const r of result) {
      const d = deltaE2000(o.lab, r.lab);
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    const d = best ? Math.round(bd * 10) / 10 : null;
    return { original: o, result: best, deltaE: d, verdict: d === null ? "missing" : deltaVerdict(d) };
  });
}

function stats(pts: Lab[]) {
  const mean = [0, 1, 2].map((c) => pts.reduce((s, p) => s + p[c], 0) / (pts.length || 1));
  const sd = [0, 1, 2].map((c) => Math.sqrt(pts.reduce((s, p) => s + (p[c] - mean[c]) ** 2, 0) / (pts.length || 1)) || 1);
  return { mean, sd };
}

/**
 * Move the colour of `target` inside `targetMask` onto that of `reference` inside
 * `referenceMask` (mean and spread of L, a and b), blended in at `strength`.
 * `keepLightness` leaves L alone, so the scene's light and shadows stay.
 */
export function matchColour(
  target: Raster,
  targetMask: Mask,
  reference: Raster,
  referenceMask: Mask | null,
  opts: { strength: number; keepLightness: boolean },
): Raster {
  const t = stats(sample(target, targetMask));
  const r = stats(sample(reference, referenceMask));
  const out = clone(target);
  for (let i = 0; i < target.w * target.h; i++) {
    if (targetMask.a[i] === 0) continue;
    const p = i * 4;
    const lab = rgbToLab(target.data[p], target.data[p + 1], target.data[p + 2]);
    const moved = lab.map((v, c) => (c === 0 && opts.keepLightness ? v : ((v - t.mean[c]) / t.sd[c]) * r.sd[c] + r.mean[c])) as Lab;
    const rgb = labToRgb(moved);
    out.data[p] = rgb[0];
    out.data[p + 1] = rgb[1];
    out.data[p + 2] = rgb[2];
  }
  return blend(target, out, targetMask, opts.strength);
}
