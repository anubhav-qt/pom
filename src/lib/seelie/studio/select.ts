import "server-only";

import { ensureModel, modelSession, MODELS, oneAtATime, tensor, type TensorData } from "../media/models";
import { boxMask, intersect, resize, type Mask, type Raster } from "./raster";

/**
 * Selecting one thing by pointing at it, with SlimSAM (a pruned Segment Anything,
 * Apache-2.0): points on the thing (and, optionally, points that are not it), or a box
 * around it. The picture's encoding is kept for the last few pictures, so several
 * selections on one photo pay for it once.
 */

const SIDE = 1024;
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

type Progress = (text: string) => void;

interface Encoded {
  embeddings: TensorData;
  positional: TensorData;
  /** The picture's size at 1024 on the long side (the rest is padding). */
  rw: number;
  rh: number;
}

const encoded = new WeakMap<Raster, Promise<Encoded>>();

async function encode(r: Raster, progress: Progress, signal: AbortSignal): Promise<Encoded> {
  const [encoderFile] = await ensureModel("slimsam", progress, signal);
  const encoder = await modelSession(encoderFile, MODELS.slimsam.label, progress);
  const scale = SIDE / Math.max(r.w, r.h);
  const rw = Math.round(r.w * scale);
  const rh = Math.round(r.h * scale);
  const small = await resize(r, rw, rh);
  const n = SIDE * SIDE;
  const pixels = new Float32Array(3 * n);
  // Padding (right and bottom) stays 0 after normalising, as the model was trained.
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const s = (y * rw + x) * 4;
      const d = y * SIDE + x;
      for (let c = 0; c < 3; c++) pixels[c * n + d] = (small.data[s + c] / 255 - MEAN[c]) / STD[c];
    }
  }
  progress("Looking at the picture…");
  const out = await encoder.run({ pixel_values: tensor("float32", pixels, [1, 3, SIDE, SIDE]) });
  return { embeddings: out.image_embeddings, positional: out.image_positional_embeddings, rw, rh };
}

export interface SelectPrompt {
  /** Points in px: on the thing (true) or not it (false). */
  points?: { x: number; y: number; on: boolean }[];
  /** A box around it, in px. */
  box?: { x: number; y: number; w: number; h: number };
}

/** The thing pointed at, as a mask the picture's size. Also says how sure the model is (0-1). */
export async function select(r: Raster, prompt: SelectPrompt, opts: { progress: Progress; signal: AbortSignal }): Promise<{ mask: Mask; score: number }> {
  return oneAtATime(async () => {
    let enc = encoded.get(r);
    if (!enc) {
      enc = encode(r, opts.progress, opts.signal);
      encoded.set(r, enc);
      enc.catch(() => encoded.delete(r));
    }
    const { embeddings, positional, rw, rh } = await enc;
    const files = await ensureModel("slimsam", opts.progress, opts.signal);
    const decoder = await modelSession(files[1], MODELS.slimsam.label, opts.progress);
    const scale = rw / r.w;

    const pts = [...(prompt.points ?? [])];
    // A box alone: its centre is on the thing, and the mask is kept inside the box.
    if (prompt.box && !pts.some((p) => p.on)) pts.push({ x: prompt.box.x + prompt.box.w / 2, y: prompt.box.y + prompt.box.h / 2, on: true });
    if (pts.length === 0) throw new Error("Point at what to select (points or a box).");
    const coords = new Float32Array(pts.length * 2);
    const labels = new BigInt64Array(pts.length);
    pts.forEach((p, i) => {
      coords[i * 2] = p.x * scale;
      coords[i * 2 + 1] = p.y * scale;
      labels[i] = p.on ? 1n : 0n;
    });
    const out = await decoder.run({
      input_points: tensor("float32", coords, [1, 1, pts.length, 2]),
      input_labels: tensor("int64", labels, [1, 1, pts.length]),
      image_embeddings: embeddings,
      image_positional_embeddings: positional,
    });
    const scores = out.iou_scores.data as Float32Array;
    const masks = out.pred_masks.data as Float32Array;
    const [, , count, mh, mw] = out.pred_masks.dims as number[];
    let best = 0;
    for (let i = 1; i < count; i++) if (scores[i] > scores[best]) best = i;

    // The low-res logits cover the padded 1024 square: take the picture's part, then scale up.
    const low = { w: mw, h: mh, data: new Uint8ClampedArray(mw * mh * 4) };
    const offset = best * mw * mh;
    for (let i = 0; i < mw * mh; i++) {
      const v = 1 / (1 + Math.exp(-masks[offset + i]));
      low.data.set([255, 255, 255, Math.round(v * 255)], i * 4);
    }
    const square = await resize(low, SIDE, SIDE);
    const part = { w: rw, h: rh, data: new Uint8ClampedArray(rw * rh * 4) };
    for (let y = 0; y < rh; y++) part.data.set(square.data.subarray(y * SIDE * 4, (y * SIDE + rw) * 4), y * rw * 4);
    const full = await resize(part, r.w, r.h);
    let mask: Mask = { w: r.w, h: r.h, a: new Uint8Array(r.w * r.h) };
    // A crisp edge with a pixel of softness: the logits' 0.5 is the boundary.
    for (let i = 0; i < mask.a.length; i++) {
      const v = full.data[i * 4 + 3] / 255;
      mask.a[i] = v >= 0.6 ? 255 : v <= 0.4 ? 0 : Math.round(((v - 0.4) / 0.2) * 255);
    }
    if (prompt.box) mask = intersect(mask, boxMask(r.w, r.h, prompt.box));
    return { mask, score: Math.round(scores[best] * 100) / 100 };
  });
}
