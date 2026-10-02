import "server-only";

import type { Canvas } from "@napi-rs/canvas";

import { MediaError } from "../media/files";

/**
 * Pixels for the photo tools: an image as RGBA bytes, and masks as one byte a pixel
 * (0 = outside, 255 = inside, in between = soft edge). Decoding, drawing and encoding go
 * through @napi-rs/canvas (Skia); the pixel maths is plain loops over typed arrays.
 */

export interface Raster {
  w: number;
  h: number;
  /** RGBA, row by row. */
  data: Uint8ClampedArray;
}

export interface Mask {
  w: number;
  h: number;
  a: Uint8Array;
}

/** Photos are worked on at up to this long edge (a 4K shoot image is 4800). */
export const MAX_EDGE = 6000;

const canvasLib = () => import("@napi-rs/canvas");

export async function decode(bytes: Buffer, maxEdge = MAX_EDGE): Promise<Raster> {
  const { createCanvas, loadImage } = await canvasLib();
  const img = await loadImage(bytes).catch(() => {
    throw new MediaError("That image couldn't be read.");
  });
  const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  // Skia's "high" filter softens even at 1:1, so it's only for shrinking; otherwise the pixels are copied as they are.
  if (scale < 1) ctx.imageSmoothingQuality = "high";
  else ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, w, h);
  return { w, h, data: ctx.getImageData(0, 0, w, h).data };
}

export async function toCanvas(r: Raster): Promise<Canvas> {
  const { createCanvas } = await canvasLib();
  const c = createCanvas(r.w, r.h);
  const ctx = c.getContext("2d");
  const img = ctx.createImageData(r.w, r.h);
  img.data.set(r.data);
  ctx.putImageData(img, 0, 0);
  return c;
}

export async function fromCanvas(c: Canvas): Promise<Raster> {
  return { w: c.width, h: c.height, data: c.getContext("2d").getImageData(0, 0, c.width, c.height).data };
}

export type Format = "png" | "jpeg" | "webp";

export async function encode(r: Raster, format: Format, quality = 92): Promise<Buffer> {
  const c = await toCanvas(r);
  if (format === "png") return c.encode("png");
  if (format === "webp") return c.encode("webp", quality);
  // JPEG has no transparency: flatten onto white first.
  if (hasAlpha(r)) return (await toCanvas(flatten(r, [255, 255, 255]))).encode("jpeg", quality);
  return c.encode("jpeg", quality);
}

/** A JPEG to look at, no longer than `edge`. */
export async function preview(r: Raster, edge = 1280, quality = 85): Promise<Buffer> {
  const small = await resize(r, ...fitWithin(r.w, r.h, edge));
  return encode(hasAlpha(small) ? checkerboard(small) : small, "jpeg", quality);
}

export function fitWithin(w: number, h: number, edge: number): [number, number] {
  const s = Math.min(1, edge / Math.max(w, h));
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

export function blank(w: number, h: number, rgba: [number, number, number, number] = [0, 0, 0, 0]): Raster {
  const data = new Uint8ClampedArray(w * h * 4);
  if (rgba.some((v) => v !== 0)) for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return { w, h, data };
}

export function clone(r: Raster): Raster {
  return { w: r.w, h: r.h, data: new Uint8ClampedArray(r.data) };
}

export function hasAlpha(r: Raster) {
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i] < 255) return true;
  return false;
}

export async function resize(r: Raster, w: number, h: number): Promise<Raster> {
  if (w === r.w && h === r.h) return r;
  const { createCanvas } = await canvasLib();
  const src = await toCanvas(r);
  // Big reductions in halving steps: Skia's single-pass downscale aliases fine prints.
  let cur: Canvas = src;
  while (cur.width / 2 >= w && cur.height / 2 >= h) {
    const half = createCanvas(Math.max(w, Math.round(cur.width / 2)), Math.max(h, Math.round(cur.height / 2)));
    const hctx = half.getContext("2d");
    hctx.imageSmoothingQuality = "high";
    hctx.drawImage(cur, 0, 0, half.width, half.height);
    cur = half;
  }
  const out = createCanvas(w, h);
  const ctx = out.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(cur, 0, 0, w, h);
  return fromCanvas(out);
}

export function crop(r: Raster, x: number, y: number, w: number, h: number): Raster {
  x = Math.round(x);
  y = Math.round(y);
  w = Math.round(w);
  h = Math.round(h);
  const out = blank(w, h);
  for (let row = 0; row < h; row++) {
    const sy = y + row;
    if (sy < 0 || sy >= r.h) continue;
    const x0 = Math.max(0, x);
    const x1 = Math.min(r.w, x + w);
    if (x1 <= x0) continue;
    out.data.set(r.data.subarray((sy * r.w + x0) * 4, (sy * r.w + x1) * 4), (row * w + (x0 - x)) * 4);
  }
  return out;
}

/** `top` over `bottom` at (x, y), through `mask` when given (top's own alpha always counts). */
export function over(bottom: Raster, top: Raster, x = 0, y = 0, mask?: Mask, opacity = 1): Raster {
  const out = clone(bottom);
  for (let ty = 0; ty < top.h; ty++) {
    const by = ty + y;
    if (by < 0 || by >= out.h) continue;
    for (let tx = 0; tx < top.w; tx++) {
      const bx = tx + x;
      if (bx < 0 || bx >= out.w) continue;
      const t = (ty * top.w + tx) * 4;
      let a = (top.data[t + 3] / 255) * opacity;
      if (mask) a *= mask.a[ty * mask.w + tx] / 255;
      if (a <= 0) continue;
      const b = (by * out.w + bx) * 4;
      const ba = out.data[b + 3] / 255;
      const oa = a + ba * (1 - a);
      for (let c = 0; c < 3; c++) out.data[b + c] = (top.data[t + c] * a + out.data[b + c] * ba * (1 - a)) / (oa || 1);
      out.data[b + 3] = oa * 255;
    }
  }
  return out;
}

/** Mix `b` into `a` by the mask (same sizes). */
export function blend(a: Raster, b: Raster, mask: Mask, strength = 1): Raster {
  const out = clone(a);
  for (let i = 0; i < mask.a.length; i++) {
    const m = (mask.a[i] / 255) * strength;
    if (m <= 0) continue;
    const p = i * 4;
    for (let c = 0; c < 4; c++) out.data[p + c] = a.data[p + c] + (b.data[p + c] - a.data[p + c]) * m;
  }
  return out;
}

export function flatten(r: Raster, rgb: [number, number, number]): Raster {
  const out = clone(r);
  for (let p = 0; p < out.data.length; p += 4) {
    const a = out.data[p + 3] / 255;
    for (let c = 0; c < 3; c++) out.data[p + c] = out.data[p + c] * a + rgb[c] * (1 - a);
    out.data[p + 3] = 255;
  }
  return out;
}

export function checkerboard(r: Raster, cell = 16): Raster {
  const bg = blank(r.w, r.h);
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const v = (Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? 217 : 255;
      bg.data.set([v, v, v, 255], (y * r.w + x) * 4);
    }
  }
  return over(bg, r);
}

/* -------------------------------------------------------------------------- */
/* Masks                                                                      */
/* -------------------------------------------------------------------------- */

export function emptyMask(w: number, h: number, fill = 0): Mask {
  return { w, h, a: new Uint8Array(w * h).fill(fill) };
}

export function alphaMask(r: Raster): Mask {
  const a = new Uint8Array(r.w * r.h);
  for (let i = 0; i < a.length; i++) a[i] = r.data[i * 4 + 3];
  return { w: r.w, h: r.h, a };
}

export function withAlpha(r: Raster, m: Mask): Raster {
  const out = clone(r);
  for (let i = 0; i < m.a.length; i++) out.data[i * 4 + 3] = Math.round((out.data[i * 4 + 3] * m.a[i]) / 255);
  return out;
}

export function invert(m: Mask): Mask {
  return { w: m.w, h: m.h, a: m.a.map((v) => 255 - v) };
}

export function intersect(a: Mask, b: Mask): Mask {
  return { w: a.w, h: a.h, a: a.a.map((v, i) => Math.round((v * b.a[i]) / 255)) };
}

export function union(a: Mask, b: Mask): Mask {
  return { w: a.w, h: a.h, a: a.a.map((v, i) => Math.max(v, b.a[i])) };
}

export async function resizeMask(m: Mask, w: number, h: number): Promise<Mask> {
  if (m.w === w && m.h === h) return m;
  const r = blank(m.w, m.h);
  for (let i = 0; i < m.a.length; i++) r.data.set([255, 255, 255, m.a[i]], i * 4);
  return alphaMask(await resize(r, w, h));
}

/** A grayscale-in-RGBA picture of a mask (white = inside), to save or show. */
export function maskImage(m: Mask): Raster {
  const r = blank(m.w, m.h);
  for (let i = 0; i < m.a.length; i++) r.data.set([m.a[i], m.a[i], m.a[i], 255], i * 4);
  return r;
}

/** A saved mask picture back to a mask (its brightness, or its alpha if it has one). */
export function maskFromImage(r: Raster): Mask {
  const alpha = hasAlpha(r);
  const a = new Uint8Array(r.w * r.h);
  for (let i = 0; i < a.length; i++) a[i] = alpha ? r.data[i * 4 + 3] : Math.round((r.data[i * 4] + r.data[i * 4 + 1] + r.data[i * 4 + 2]) / 3);
  return { w: r.w, h: r.h, a };
}

/** A box blur run three times (close to a gaussian) over one channel. */
function blurChannel(src: Float32Array, w: number, h: number, radius: number): Float32Array {
  if (radius < 1) return src;
  // Never written into: the caller's array stays as it was.
  const a = new Float32Array(src);
  const b = new Float32Array(src.length);
  const r = Math.max(1, Math.round(radius / 1.7));
  for (let pass = 0; pass < 3; pass++) {
    // Horizontal.
    for (let y = 0; y < h; y++) {
      let sum = 0;
      const row = y * w;
      for (let x = -r; x <= r; x++) sum += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[row + x] = sum / (2 * r + 1);
        sum += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    // Vertical.
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum / (2 * r + 1);
        sum += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  return a;
}

/** Blur one plane of numbers (a channel, a weight map) by about `radius` px; the input is left as it was. */
export function blurPlane(plane: Float32Array, w: number, h: number, radius: number): Float32Array {
  return radius < 1 ? new Float32Array(plane) : blurChannel(plane, w, h, radius);
}

/** Soften a mask's edge by `radius` px. */
export function feather(m: Mask, radius: number): Mask {
  if (radius < 1) return m;
  const out = blurChannel(Float32Array.from(m.a), m.w, m.h, radius);
  return { w: m.w, h: m.h, a: Uint8Array.from(out, (v) => Math.round(v)) };
}

/** Grow (positive) or shrink (negative) a mask by about `px`. */
export function grow(m: Mask, px: number): Mask {
  if (px === 0) return m;
  const blurred = blurChannel(Float32Array.from(m.a, (v) => (v >= 128 ? 255 : 0)), m.w, m.h, Math.abs(px));
  // After a blur of radius r, an edge spreads ~r px: thresholding low grows it, high shrinks it.
  const cut = px > 0 ? 8 : 247;
  return { w: m.w, h: m.h, a: Uint8Array.from(blurred, (v) => (v > cut ? 255 : 0)) };
}

/** Blur a whole picture (every channel), e.g. a background. */
export function blurRaster(r: Raster, radius: number): Raster {
  const n = r.w * r.h;
  const out = blank(r.w, r.h);
  for (let c = 0; c < 4; c++) {
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = r.data[i * 4 + c];
    const b = blurChannel(ch, r.w, r.h, radius);
    for (let i = 0; i < n; i++) out.data[i * 4 + c] = b[i];
  }
  return out;
}

/** The bounding box of a mask's pixels above `threshold`, or null when it's empty. */
export function maskBox(m: Mask, threshold = 127): { x: number; y: number; w: number; h: number } | null {
  let x0 = m.w;
  let y0 = m.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if (m.a[y * m.w + x] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export function coverage(m: Mask) {
  let s = 0;
  for (const v of m.a) s += v;
  return s / (255 * m.a.length);
}

/** A filled polygon (points in px). */
export async function polygonMask(w: number, h: number, points: [number, number][]): Promise<Mask> {
  const { createCanvas } = await canvasLib();
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
  return alphaMask(await fromCanvas(c));
}

export function boxMask(w: number, h: number, box: { x: number; y: number; w: number; h: number }): Mask {
  const m = emptyMask(w, h);
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(w, Math.round(box.x + box.w));
  const y1 = Math.min(h, Math.round(box.y + box.h));
  for (let y = y0; y < y1; y++) m.a.fill(255, y * w + x0, y * w + x1);
  return m;
}

/** A colour as [r, g, b] from "#rgb", "#rrggbb" or "rgb(r, g, b)". */
export function parseColour(text: string): [number, number, number] {
  const t = text.trim().toLowerCase();
  const named: Record<string, string> = { white: "#ffffff", black: "#000000" };
  const hex = named[t] ?? t;
  let m = /^#([0-9a-f]{3})$/.exec(hex);
  if (m) return [0, 1, 2].map((i) => parseInt(m![1][i] + m![1][i], 16)) as [number, number, number];
  m = /^#([0-9a-f]{6})$/.exec(hex);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as [number, number, number];
  const rgb = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/.exec(t);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])].map((v) => Math.min(255, v)) as [number, number, number];
  throw new MediaError(`"${text}" isn't a colour (use #rrggbb).`);
}

export const hex = (rgb: ArrayLike<number>) => `#${Array.from({ length: 3 }, (_, i) => Math.round(rgb[i]).toString(16).padStart(2, "0")).join("")}`;

/**
 * The separate parts of a mask as boxes (in the mask's px), found on a coarse grid so a
 * 4K mask takes milliseconds; parts closer than `join` px count as one.
 */
export function components(m: Mask, join = 24): { x: number; y: number; w: number; h: number }[] {
  const cell = Math.max(1, Math.ceil(Math.max(m.w, m.h) / 512));
  const gw = Math.ceil(m.w / cell);
  const gh = Math.ceil(m.h / cell);
  const on = new Uint8Array(gw * gh);
  for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (m.a[y * m.w + x] > 0) on[Math.floor(y / cell) * gw + Math.floor(x / cell)] = 1;
  const reach = Math.max(1, Math.ceil(join / cell));
  const seen = new Uint8Array(gw * gh);
  const boxes: { x: number; y: number; w: number; h: number }[] = [];
  for (let start = 0; start < on.length; start++) {
    if (!on[start] || seen[start]) continue;
    let x0 = gw;
    let y0 = gh;
    let x1 = -1;
    let y1 = -1;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % gw;
      const y = (i - x) / gw;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const j = ny * gw + nx;
          if (on[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
      }
    }
    const x = x0 * cell;
    const y = y0 * cell;
    boxes.push({ x, y, w: Math.min(m.w, (x1 + 1) * cell) - x, h: Math.min(m.h, (y1 + 1) * cell) - y });
  }
  return boxes;
}
