import "server-only";

import type { Canvas, Image } from "@napi-rs/canvas";

import { MediaError } from "./files";
import { ensureModel, modelSession, MODELS, oneAtATime, tensor } from "./models";

/**
 * Background removal with BiRefNet lite (MIT), run on the CPU through onnxruntime-node.
 * The model (115 MB) is downloaded from Hugging Face the first time it's needed
 * (models.ts) and its hash checked.
 * One image takes ~3-4 s on a laptop CPU.
 */

const SIDE = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
/** The cut-out keeps the photo's size up to this long edge. */
const MAX_EDGE = 2048;

async function load(progress: (text: string) => void, signal: AbortSignal) {
  const [file] = await ensureModel("birefnet", progress, signal);
  return modelSession(file, MODELS.birefnet.label, progress);
}

/** The model's 1024x1024 mask for an image (0-1 per pixel). */
async function predict(img: Image | Canvas, opts: { progress: (text: string) => void; signal: AbortSignal }): Promise<Float32Array> {
  const model = await load(opts.progress, opts.signal);
  const { createCanvas } = await import("@napi-rs/canvas");
  // The model takes 1024x1024, normalised like ImageNet, channels first.
  const square = createCanvas(SIDE, SIDE);
  square.getContext("2d").drawImage(img, 0, 0, SIDE, SIDE);
  const px = square.getContext("2d").getImageData(0, 0, SIDE, SIDE).data;
  const n = SIDE * SIDE;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) input[c * n + i] = (px[i * 4 + c] / 255 - MEAN[c]) / STD[c];
  }
  opts.progress("Finding the subject…");
  const out = await model.run({ [model.inputNames[0]]: tensor("float32", input, [1, 3, SIDE, SIDE]) });
  const raw = out[model.outputNames[model.outputNames.length - 1]].data as Float32Array;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of raw) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  // Some exports end in logits, some in a sigmoid already.
  const logits = lo < -0.01 || hi > 1.01;
  return Float32Array.from(raw, (v) => (logits ? 1 / (1 + Math.exp(-v)) : Math.min(1, Math.max(0, v))));
}

/**
 * The subject of a photo as a mask at `width` x `height` (the size the photo is being
 * worked on at): 255 inside, 0 outside, soft at the edges.
 */
export async function subjectMask(
  src: Buffer | Canvas,
  width: number,
  height: number,
  opts: { progress: (text: string) => void; signal: AbortSignal },
): Promise<Uint8Array> {
  return oneAtATime(async () => {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const img = Buffer.isBuffer(src)
      ? await loadImage(src).catch(() => {
          throw new MediaError("That image couldn't be read.");
        })
      : src;
    const prob = await predict(img, opts);
    const small = createCanvas(SIDE, SIDE);
    const sctx = small.getContext("2d");
    const data = sctx.createImageData(SIDE, SIDE);
    for (let i = 0; i < prob.length; i++) data.data.set([255, 255, 255, Math.round(prob[i] * 255)], i * 4);
    sctx.putImageData(data, 0, 0);
    const full = createCanvas(width, height);
    const fctx = full.getContext("2d");
    fctx.imageSmoothingQuality = "high";
    fctx.drawImage(small, 0, 0, width, height);
    const px = fctx.getImageData(0, 0, width, height).data;
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 3];
    return mask;
  });
}

export interface Cutout {
  /** RGBA PNG, cropped to the subject (with a little room) unless `trim` was off. */
  png: Buffer;
  /** The same on a checkerboard, as a JPEG to look at. */
  preview: Buffer;
  width: number;
  height: number;
  /** How much of the photo the subject covers, 0-1. */
  coverage: number;
}

export async function cutout(bytes: Buffer, opts: { trim: boolean; progress: (text: string) => void; signal: AbortSignal }): Promise<Cutout> {
  return oneAtATime(() => cutoutNow(bytes, opts));
}

async function cutoutNow(bytes: Buffer, opts: { trim: boolean; progress: (text: string) => void; signal: AbortSignal }): Promise<Cutout> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(bytes).catch(() => {
    throw new MediaError("That image couldn't be read.");
  });
  const prob = await predict(img, opts);
  const n = SIDE * SIDE;

  const maskCanvas = createCanvas(SIDE, SIDE);
  const mctx = maskCanvas.getContext("2d");
  const mask = mctx.createImageData(SIDE, SIDE);
  let top = SIDE;
  let bottom = -1;
  let left = SIDE;
  let right = -1;
  let solid = 0;
  for (let i = 0; i < n; i++) {
    const v = prob[i];
    mask.data[i * 4 + 3] = Math.round(v * 255);
    if (v > 0.5) {
      solid++;
      const y = Math.floor(i / SIDE);
      const x = i % SIDE;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }
  }
  if (bottom < 0 || solid < n * 0.002) throw new MediaError("There's no clear subject to cut out in that image.");
  mctx.putImageData(mask, 0, 0);

  const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
  const W = Math.max(1, Math.round(img.width * scale));
  const H = Math.max(1, Math.round(img.height * scale));
  const full = createCanvas(W, H);
  const fctx = full.getContext("2d");
  fctx.drawImage(img, 0, 0, W, H);
  fctx.globalCompositeOperation = "destination-in";
  fctx.drawImage(maskCanvas, 0, 0, W, H);

  // Crop to the subject with 3% room, in the photo's own pixels.
  let [x, y, w, h] = [0, 0, W, H];
  if (opts.trim) {
    const room = 0.03 * SIDE;
    const sx = W / SIDE;
    const sy = H / SIDE;
    x = Math.max(0, Math.floor((left - room) * sx));
    y = Math.max(0, Math.floor((top - room) * sy));
    w = Math.min(W, Math.ceil((right + 1 + room) * sx)) - x;
    h = Math.min(H, Math.ceil((bottom + 1 + room) * sy)) - y;
  }
  const cropped = createCanvas(w, h);
  cropped.getContext("2d").drawImage(full, x, y, w, h, 0, 0, w, h);

  // To look at: on a checkerboard, so the edges show.
  const pscale = Math.min(1, 768 / Math.max(w, h));
  const pw = Math.max(1, Math.round(w * pscale));
  const ph = Math.max(1, Math.round(h * pscale));
  const preview = createCanvas(pw, ph);
  const pctx = preview.getContext("2d");
  const cell = 16;
  for (let yy = 0; yy < ph; yy += cell) {
    for (let xx = 0; xx < pw; xx += cell) {
      pctx.fillStyle = ((xx + yy) / cell) % 2 === 0 ? "#d9d9d9" : "#ffffff";
      pctx.fillRect(xx, yy, cell, cell);
    }
  }
  pctx.drawImage(cropped, 0, 0, pw, ph);

  return {
    png: await cropped.encode("png"),
    preview: await preview.encode("jpeg", 85),
    width: w,
    height: h,
    coverage: Math.round((solid / n) * 1000) / 1000,
  };
}
