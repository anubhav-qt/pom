import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import os from "node:os";

import type { InferenceSession } from "onnxruntime-node";

import { mediaFolder, mediaPath, MediaError } from "./files";

/**
 * Background removal with BiRefNet lite (MIT), run on the CPU through onnxruntime-node.
 * The model (115 MB) is downloaded from Hugging Face the first time it's needed and
 * kept in the media folder's models/; its hash is checked before it is used.
 * One image takes ~3-4 s on a laptop CPU.
 */

const MODEL_FILE = "birefnet-lite-fp16.onnx";
const MODEL_URL = "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model_fp16.onnx";
const MODEL_SHA256 = "d39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402";
const SIDE = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];
/** The cut-out keeps the photo's size up to this long edge. */
const MAX_EDGE = 2048;

let downloading: Promise<string> | null = null;
let session: Promise<InferenceSession> | null = null;
/** One cut-out at a time: each one uses several cores. */
let queue: Promise<unknown> = Promise.resolve();

async function download(file: string, progress: (text: string) => void, signal: AbortSignal) {
  await mediaFolder("models");
  const part = `${file}.${randomBytes(4).toString("hex")}.part`;
  try {
    const res = await fetch(MODEL_URL, { signal: AbortSignal.any([signal, AbortSignal.timeout(20 * 60_000)]) });
    if (!res.ok || !res.body) throw new MediaError(`The cut-out model couldn't be downloaded (HTTP ${res.status}).`);
    const total = Number(res.headers.get("content-length") ?? 0);
    const hash = createHash("sha256");
    const out = createWriteStream(part);
    let got = 0;
    let shown = -1;
    const reader = res.body.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      hash.update(r.value);
      got += r.value.length;
      if (!out.write(r.value)) await new Promise<void>((ok) => out.once("drain", () => ok()));
      const pct = total ? Math.floor((got / total) * 100) : -1;
      if (pct !== shown && pct % 5 === 0) {
        shown = pct;
        progress(`Downloading the cut-out model (once): ${pct}%`);
      }
    }
    await new Promise<void>((ok, fail) => out.end((err?: Error | null) => (err ? fail(err) : ok())));
    if (hash.digest("hex") !== MODEL_SHA256) throw new MediaError("The cut-out model downloaded wrong (its hash doesn't match). Try again.");
    await rename(part, file);
    return file;
  } finally {
    await rm(part, { force: true });
  }
}

async function modelFile(progress: (text: string) => void, signal: AbortSignal) {
  const file = mediaPath("models", MODEL_FILE);
  if ((await stat(file).catch(() => null))?.isFile()) return file;
  downloading ??= download(file, progress, signal).finally(() => {
    downloading = null;
  });
  return downloading;
}

async function load(progress: (text: string) => void, signal: AbortSignal) {
  if (!session) {
    session = (async () => {
      const file = await modelFile(progress, signal);
      progress("Loading the cut-out model…");
      const ort = await import("onnxruntime-node");
      return ort.InferenceSession.create(file, {
        graphOptimizationLevel: "all",
        intraOpNumThreads: Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))),
        logSeverityLevel: 3,
      });
    })();
    session.catch(() => {
      session = null;
    });
  }
  return session;
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
  const run = queue.then(() => cutoutNow(bytes, opts));
  queue = run.catch(() => {});
  return run;
}

async function cutoutNow(bytes: Buffer, opts: { trim: boolean; progress: (text: string) => void; signal: AbortSignal }): Promise<Cutout> {
  const model = await load(opts.progress, opts.signal);
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const ort = await import("onnxruntime-node");
  const img = await loadImage(bytes).catch(() => {
    throw new MediaError("That image couldn't be read.");
  });

  // The model takes 1024x1024, normalised like ImageNet, channels first.
  const square = createCanvas(SIDE, SIDE);
  square.getContext("2d").drawImage(img, 0, 0, SIDE, SIDE);
  const px = square.getContext("2d").getImageData(0, 0, SIDE, SIDE).data;
  const n = SIDE * SIDE;
  const input = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) input[c * n + i] = (px[i * 4 + c] / 255 - MEAN[c]) / STD[c];
  }
  opts.progress("Cutting out…");
  const out = await model.run({ [model.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, SIDE, SIDE]) });
  const raw = out[model.outputNames[model.outputNames.length - 1]].data as Float32Array;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of raw) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  // Some exports end in logits, some in a sigmoid already.
  const logits = lo < -0.01 || hi > 1.01;

  const maskCanvas = createCanvas(SIDE, SIDE);
  const mctx = maskCanvas.getContext("2d");
  const mask = mctx.createImageData(SIDE, SIDE);
  let top = SIDE;
  let bottom = -1;
  let left = SIDE;
  let right = -1;
  let solid = 0;
  for (let i = 0; i < n; i++) {
    const v = logits ? 1 / (1 + Math.exp(-raw[i])) : Math.min(1, Math.max(0, raw[i]));
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
