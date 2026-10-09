import "server-only";

import { ensureModel, modelSession, MODELS, oneAtATime, tensor } from "../media/models";
import { alphaMask, hasAlpha, resize, resizeMask, withAlpha, type Raster } from "./raster";

/**
 * 4x upscaling with Real-ESRGAN x4plus (BSD-3; Qualcomm AI Hub's ONNX export), for old
 * low-res photos. The export takes 128x128 tiles, so the picture is done tile by tile with
 * an overlap that is cut away, which leaves no seams.
 */

const TILE = 128;
const PAD = 12;
const STEP = TILE - 2 * PAD;
/** Past this the result would be huge and slow: say so instead. */
export const MAX_UPSCALE_INPUT = 1600;

type Progress = (text: string) => void;

export async function upscale(r: Raster, factor: 2 | 3 | 4, opts: { progress: Progress; signal: AbortSignal }): Promise<Raster> {
  return oneAtATime(async () => {
    const files = await ensureModel("esrgan", opts.progress, opts.signal);
    const model = await modelSession(files.find((f) => f.endsWith(".onnx"))!, MODELS.esrgan.label, opts.progress);
    const W = r.w * 4;
    const H = r.h * 4;
    const out = { w: W, h: H, data: new Uint8ClampedArray(W * H * 4) };
    const n = TILE * TILE;
    const input = new Float32Array(3 * n);
    const tilesX = Math.ceil(r.w / STEP);
    const tilesY = Math.ceil(r.h / STEP);
    let done = 0;
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        if (opts.signal.aborted) throw new Error("Stopped.");
        const ox = tx * STEP - PAD;
        const oy = ty * STEP - PAD;
        // The tile, with the picture's edge repeated where it runs off.
        for (let y = 0; y < TILE; y++) {
          const sy = Math.min(r.h - 1, Math.max(0, oy + y));
          for (let x = 0; x < TILE; x++) {
            const sx = Math.min(r.w - 1, Math.max(0, ox + x));
            const s = (sy * r.w + sx) * 4;
            const d = y * TILE + x;
            for (let c = 0; c < 3; c++) input[c * n + d] = r.data[s + c] / 255;
          }
        }
        const res = await model.run({ [model.inputNames[0]]: tensor("float32", input, [1, 3, TILE, TILE]) });
        const up = res[model.outputNames[0]].data as Float32Array;
        const U = TILE * 4;
        const un = U * U;
        // Keep the tile's middle (its STEP x STEP part), in the output's px.
        for (let y = PAD * 4; y < (PAD + STEP) * 4; y++) {
          const dy = oy * 4 + y;
          if (dy < 0 || dy >= H) continue;
          for (let x = PAD * 4; x < (PAD + STEP) * 4; x++) {
            const dx = ox * 4 + x;
            if (dx < 0 || dx >= W) continue;
            const s = y * U + x;
            const d = (dy * W + dx) * 4;
            out.data[d] = up[s] * 255;
            out.data[d + 1] = up[un + s] * 255;
            out.data[d + 2] = up[2 * un + s] * 255;
            out.data[d + 3] = 255;
          }
        }
        done++;
        if (done % 4 === 0 || done === tilesX * tilesY) opts.progress(`Upscaling ${Math.round((done / (tilesX * tilesY)) * 100)}%`);
      }
    }
    let result: Raster = out;
    if (hasAlpha(r)) result = withAlpha(result, await resizeMask(alphaMask(r), W, H));
    if (factor !== 4) result = await resize(result, r.w * factor, r.h * factor);
    return result;
  });
}
