import "server-only";

import { ensureModel, modelSession, MODELS, oneAtATime } from "../media/models";
import { blend, components, crop, feather, grow, resize, resizeMask, type Mask, type Raster } from "./raster";

/**
 * Removing things and healing with LaMa (Apache-2.0): it fills a masked hole from what
 * surrounds it. The export takes 512x512, so each hole is filled in a window around it
 * with enough context, scaled to 512 and back; only the hole's pixels change.
 */

const SIDE = 512;

type Progress = (text: string) => void;

async function session(progress: Progress, signal: AbortSignal) {
  const [file] = await ensureModel("lama", progress, signal);
  return modelSession(file, MODELS.lama.label, progress);
}

/** Fill the hole in one window of the picture (x, y, w, h in px). */
async function fillWindow(r: Raster, hole: Mask, win: { x: number; y: number; w: number; h: number }, progress: Progress, signal: AbortSignal): Promise<Raster> {
  const model = await session(progress, signal);
  const ort = await import("onnxruntime-node");
  const part = await resize(crop(r, win.x, win.y, win.w, win.h), SIDE, SIDE);
  const holeCrop: Mask = { w: win.w, h: win.h, a: new Uint8Array(win.w * win.h) };
  for (let y = 0; y < win.h; y++) holeCrop.a.set(hole.a.subarray((win.y + y) * hole.w + win.x, (win.y + y) * hole.w + win.x + win.w), y * win.w);
  const holeSmall = await resizeMask(holeCrop, SIDE, SIDE);
  const n = SIDE * SIDE;
  const image = new Float32Array(3 * n);
  const mask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const m = holeSmall.a[i] > 0 ? 1 : 0;
    mask[i] = m;
    // The hole is blanked: LaMa must not see what was there.
    for (let c = 0; c < 3; c++) image[c * n + i] = m ? 0 : part.data[i * 4 + c] / 255;
  }
  const out = await model.run({
    [model.inputNames[0]]: new ort.Tensor("float32", image, [1, 3, SIDE, SIDE]),
    [model.inputNames[1]]: new ort.Tensor("float32", mask, [1, 1, SIDE, SIDE]),
  });
  const res = out[model.outputNames[0]].data as Float32Array;
  let hi = 0;
  for (let i = 0; i < res.length; i += 97) hi = Math.max(hi, res[i]);
  const k = hi > 2 ? 1 : 255;
  const filled = { w: SIDE, h: SIDE, data: new Uint8ClampedArray(n * 4) };
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) filled.data[i * 4 + c] = res[c * n + i] * k;
    filled.data[i * 4 + 3] = part.data[i * 4 + 3];
  }
  const back = await resize(filled, win.w, win.h);
  // Paste the window's fill into the whole picture, only where the hole is (soft edge).
  const full = { w: r.w, h: r.h, data: new Uint8ClampedArray(r.data) };
  for (let y = 0; y < win.h; y++) full.data.set(back.data.subarray(y * win.w * 4, (y + 1) * win.w * 4), ((win.y + y) * r.w + win.x) * 4);
  const soft = feather(hole, Math.max(1.5, Math.max(win.w, win.h) / SIDE));
  // Only inside this window: the rest of the hole is another window's.
  const inWin: Mask = { w: r.w, h: r.h, a: new Uint8Array(r.w * r.h) };
  for (let y = 0; y < win.h; y++) inWin.a.set(soft.a.subarray((win.y + y) * r.w + win.x, (win.y + y) * r.w + win.x + win.w), (win.y + y) * r.w + win.x);
  return blend(r, full, inWin);
}

/** The windows that cover a hole's box with context around it: one, or several along a long strip. */
function windows(r: Raster, box: { x: number; y: number; w: number; h: number }) {
  const short = Math.min(box.w, box.h);
  const long = Math.max(box.w, box.h);
  const margin = Math.max(48, Math.round(short * 0.6));
  const side = Math.min(Math.max(r.w, r.h), Math.max(SIDE / 2, short + 2 * margin));
  const along = box.w >= box.h ? "x" : "y";
  const count = long + 2 * margin <= side * 1.3 ? 1 : Math.ceil((long + 2 * margin - side) / (side * 0.7)) + 1;
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (let i = 0; i < count; i++) {
    let x: number;
    let y: number;
    let w: number;
    let h: number;
    if (count === 1) {
      w = Math.min(r.w, Math.max(box.w + 2 * margin, Math.min(side, r.w)));
      h = Math.min(r.h, Math.max(box.h + 2 * margin, Math.min(side, r.h)));
      x = box.x + box.w / 2 - w / 2;
      y = box.y + box.h / 2 - h / 2;
    } else if (along === "x") {
      w = Math.min(r.w, side);
      h = Math.min(r.h, Math.max(side, box.h + 2 * margin));
      x = box.x - margin + ((long + 2 * margin - w) * i) / (count - 1);
      y = box.y + box.h / 2 - h / 2;
    } else {
      h = Math.min(r.h, side);
      w = Math.min(r.w, Math.max(side, box.w + 2 * margin));
      y = box.y - margin + ((long + 2 * margin - h) * i) / (count - 1);
      x = box.x + box.w / 2 - w / 2;
    }
    w = Math.round(w);
    h = Math.round(h);
    x = Math.round(Math.min(Math.max(0, x), r.w - w));
    y = Math.round(Math.min(Math.max(0, y), r.h - h));
    out.push({ x, y, w, h });
  }
  return out;
}

/** Fill everything inside `hole` from its surroundings. */
export async function inpaint(r: Raster, hole: Mask, opts: { progress: Progress; signal: AbortSignal }): Promise<Raster> {
  return oneAtATime(async () => {
    // A little wider than asked, so no edge of what's removed survives.
    const wide = grow(hole, Math.max(3, Math.round(Math.max(r.w, r.h) / 600)));
    let cur = r;
    const wins = components(wide).flatMap((box) => windows(r, box));
    for (const [i, win] of wins.entries()) {
      if (opts.signal.aborted) throw new Error("Stopped.");
      opts.progress(wins.length > 1 ? `Filling ${i + 1} of ${wins.length}…` : "Filling…");
      cur = await fillWindow(cur, wide, win, opts.progress, opts.signal);
    }
    return cur;
  });
}
