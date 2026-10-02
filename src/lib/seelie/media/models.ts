import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import type { InferenceSession } from "onnxruntime-node";

import { mediaFolder, mediaPath, MediaError } from "./files";

/**
 * The local models Seelie's photo tools run on the CPU through onnxruntime-node, each
 * downloaded once into the media folder's models/ and checked against its sha256:
 *
 *   birefnet   background removal (BiRefNet lite, MIT), 115 MB
 *   lama       inpainting: removing things and healing (LaMa, Apache-2.0; Carve's ONNX export), 208 MB
 *   slimsam    pointing at a thing to select it (SlimSAM-77, Apache-2.0; Xenova's export), 40 MB
 *   esrgan     4x upscaling of low-res photos (Real-ESRGAN x4plus, BSD-3; Qualcomm AI Hub's export), 62 MB
 */

interface ModelFile {
  /** Where it lands, inside models/. */
  file: string;
  url: string;
  sha256: string;
  /** The download is a zip: these entries are taken out of it (name in the zip → file in models/). */
  unzip?: Record<string, string>;
}

export interface ModelSpec {
  label: string;
  files: ModelFile[];
}

export const MODELS = {
  birefnet: {
    label: "the cut-out model",
    files: [
      {
        file: "birefnet-lite-fp16.onnx",
        url: "https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model_fp16.onnx",
        sha256: "d39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402",
      },
    ],
  },
  lama: {
    label: "the retouching model (LaMa)",
    files: [
      {
        file: "lama-fp32.onnx",
        url: "https://huggingface.co/Carve/LaMa-ONNX/resolve/main/lama_fp32.onnx",
        sha256: "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6",
      },
    ],
  },
  slimsam: {
    label: "the selection model (SlimSAM)",
    files: [
      {
        file: "slimsam-vision-encoder.onnx",
        url: "https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/vision_encoder.onnx",
        sha256: "9f8433273a6750b587779baa0cf5508111001bf7e7acfcf585d370139fd366d0",
      },
      {
        file: "slimsam-decoder.onnx",
        url: "https://huggingface.co/Xenova/slimsam-77-uniform/resolve/main/onnx/prompt_encoder_mask_decoder.onnx",
        sha256: "f4514391764fbd56e08e119060d874ecd7d52994bfb1968af159e12d4943b5bb",
      },
    ],
  },
  esrgan: {
    label: "the upscaling model (Real-ESRGAN)",
    files: [
      {
        file: "real-esrgan-x4plus.zip",
        url: "https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/models/real_esrgan_x4plus/releases/v0.63.0/real_esrgan_x4plus-onnx-float.zip",
        sha256: "ba463a04c206eb8576dbd65093144a5302deff8331e25920ec95f71e3163c43f",
        // The graph names its weights file; onnxruntime finds it beside the graph.
        unzip: {
          "real_esrgan_x4plus-onnx-float/real_esrgan_x4plus.onnx": "esrgan/real_esrgan_x4plus.onnx",
          "real_esrgan_x4plus-onnx-float/real_esrgan_x4plus.data": "esrgan/real_esrgan_x4plus.data",
        },
      },
    ],
  },
} satisfies Record<string, ModelSpec>;

export type ModelName = keyof typeof MODELS;

const downloads = new Map<string, Promise<void>>();

async function exists(file: string) {
  return (await stat(file).catch(() => null))?.isFile() ?? false;
}

/** The files a model is used from (a zip's are what it unpacks to). */
function finalFiles(m: ModelFile) {
  return m.unzip ? Object.values(m.unzip).map((f) => mediaPath("models", f)) : [mediaPath("models", m.file)];
}

async function download(spec: ModelSpec, m: ModelFile, progress: (text: string) => void, signal: AbortSignal) {
  await mediaFolder("models");
  const target = mediaPath("models", m.file);
  const part = `${target}.${randomBytes(4).toString("hex")}.part`;
  try {
    const res = await fetch(m.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]) });
    if (!res.ok || !res.body) throw new MediaError(`${spec.label} couldn't be downloaded (HTTP ${res.status}).`);
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
        progress(`Downloading ${spec.label} (once): ${pct}%`);
      }
    }
    await new Promise<void>((ok, fail) => out.end((err?: Error | null) => (err ? fail(err) : ok())));
    if (hash.digest("hex") !== m.sha256) throw new MediaError(`${spec.label} downloaded wrong (its hash doesn't match). Try again.`);
    if (m.unzip) {
      for (const [entry, to] of Object.entries(m.unzip)) {
        const dest = mediaPath("models", to);
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, await unzipEntry(part, entry));
      }
    } else {
      await rename(part, target);
    }
  } finally {
    await rm(part, { force: true });
  }
}

/** The model's files on disk, downloading what's missing (once, even when asked twice at the same time). */
export async function ensureModel(name: ModelName, progress: (text: string) => void, signal: AbortSignal): Promise<string[]> {
  const spec: ModelSpec = MODELS[name];
  const out: string[] = [];
  for (const m of spec.files) {
    const files = finalFiles(m);
    if (!(await Promise.all(files.map(exists))).every(Boolean)) {
      let job = downloads.get(m.file);
      if (!job) {
        job = download(spec, m, progress, signal).finally(() => downloads.delete(m.file));
        downloads.set(m.file, job);
      }
      await job;
    }
    out.push(...files);
  }
  return out;
}

const sessions = new Map<string, Promise<InferenceSession>>();

/** An onnxruntime session for a model file, kept for the life of the process. */
export async function modelSession(file: string, label: string, progress: (text: string) => void): Promise<InferenceSession> {
  let s = sessions.get(file);
  if (!s) {
    s = (async () => {
      progress(`Loading ${label}…`);
      const ort = await import("onnxruntime-node");
      return ort.InferenceSession.create(file, {
        graphOptimizationLevel: "all",
        intraOpNumThreads: Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2))),
        logSeverityLevel: 3,
      });
    })();
    s.catch(() => sessions.delete(file));
    sessions.set(file, s);
  }
  return s;
}

/** One model run at a time: each uses several cores. */
let queue: Promise<unknown> = Promise.resolve();
export function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

/* -------------------------------------------------------------------------- */
/* A zip entry, without a zip library                                         */
/* -------------------------------------------------------------------------- */

/** One file out of a zip (stored or deflated; no zip64, no encryption). */
export async function unzipEntry(zipFile: string, name: string): Promise<Buffer> {
  const fh = await open(zipFile, "r");
  try {
    const { size } = await fh.stat();
    // The end-of-central-directory record is in the last 64 KB + 22 bytes.
    const tailLen = Math.min(size, 65_557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new MediaError("That download isn't a zip.");
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    for (let p = 0; p < cdSize && cd.readUInt32LE(p) === 0x02014b50; ) {
      const method = cd.readUInt16LE(p + 10);
      const compressed = cd.readUInt32LE(p + 20);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const local = cd.readUInt32LE(p + 42);
      const entry = cd.toString("utf8", p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (entry !== name) continue;
      const lh = Buffer.alloc(30);
      await fh.read(lh, 0, 30, local);
      const start = local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const data = Buffer.alloc(compressed);
      await fh.read(data, 0, compressed, start);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new MediaError(`${name} is packed in a way Seelie can't read.`);
    }
    throw new MediaError(`${name} isn't in the download.`);
  } finally {
    await fh.close();
  }
}
