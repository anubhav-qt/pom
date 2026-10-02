import "server-only";

import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, open, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ffmpegPath, runFfmpeg } from "@/lib/reels/ffmpeg";

import { mediaFolder, mediaPath, MediaError, READABLE_FORMATS, SAFE_NAME } from "./files";
import { checkGraph, GraphError, localizeGraph, type CheckedGraph } from "./graph";
import { resolveRef, type RefContext, type Resolved } from "./refs";

/**
 * Renders Seelie's filter graphs on the ThinkPad.
 *
 * What the model controls is the graph (checked by graph.ts) and which media go in.
 * Everything around it is fixed here: the inputs are files the OMS resolved (only the
 * file protocol, only plain media containers), the output is H.264/AAC MP4 at no more
 * than 1080p and 35 s, and ffmpeg runs with low CPU priority, a clean environment, its
 * own folder as working directory and a time limit. One render at a time across every
 * OMS process (a lock file in the media folder); the others wait their turn.
 */

export const MAX_SECONDS = 35;
export const MAX_LONG_EDGE = 1920;
export const MAX_SHORT_EDGE = 1080;
const DRAFT_LONG_EDGE = 960;
const TIME_LIMIT_MS = 10 * 60_000;
const MAX_OUTPUT = "300M";
const LOCK_STALE_MS = TIME_LIMIT_MS + 60_000;

export interface RenderInput {
  ref: string;
  /** Seconds into the media to start from (video and sound). */
  start?: number;
  /** Seconds to read. An image is shown this long (default: the whole video). */
  duration?: number;
  /** Repeat a clip or sound until the video ends. */
  loop?: boolean;
}

export interface RenderSpec {
  inputs: RenderInput[];
  graph: string;
  /** Text files the graph reads ($file/<name>): subtitles, sendcmd scripts. */
  files?: Record<string, string>;
  width: number;
  height: number;
  fps: number;
  duration: number;
  quality: "draft" | "final";
}

export interface RenderOutcome {
  width: number;
  height: number;
  seconds: number;
  bytes: number;
  /** The graph gave the video its own sound ([aout]); else it is silent. */
  sound: boolean;
  /** The inputs as resolved, for the library record. */
  resolved: Resolved[];
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** The output size for a quality: drafts at most 960 px on the long edge. */
export function outputSize(spec: Pick<RenderSpec, "width" | "height" | "quality">) {
  if (spec.quality === "final") return { width: spec.width, height: spec.height };
  const scale = Math.min(1, DRAFT_LONG_EDGE / Math.max(spec.width, spec.height));
  return { width: even(spec.width * scale), height: even(spec.height * scale) };
}

/** The size, length and frame rate a render may have. Throws MediaError with what to change. */
export function checkSpec(spec: Pick<RenderSpec, "width" | "height" | "fps" | "duration">) {
  const { width, height, fps, duration } = spec;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 64 || height < 64) throw new MediaError("width and height are whole pixels, at least 64.");
  if (width % 2 || height % 2) throw new MediaError("width and height must be even (H.264).");
  if (Math.max(width, height) > MAX_LONG_EDGE || Math.min(width, height) > MAX_SHORT_EDGE) {
    throw new MediaError(`At most 1080p: the long side up to ${MAX_LONG_EDGE} px and the short side up to ${MAX_SHORT_EDGE} px.`);
  }
  if (!(fps >= 12 && fps <= 60)) throw new MediaError("fps is between 12 and 60.");
  if (!(duration > 0 && duration <= MAX_SECONDS)) throw new MediaError(`A video is at most ${MAX_SECONDS} seconds.`);
}

/* -------------------------------------------------------------------------- */
/* One render at a time                                                       */
/* -------------------------------------------------------------------------- */

async function takeLock(signal: AbortSignal, onWait: () => void): Promise<() => Promise<void>> {
  await mediaFolder();
  const lock = mediaPath("render.lock");
  let waited = false;
  for (;;) {
    if (signal.aborted) throw new MediaError("Stopped.");
    try {
      const handle = await open(lock, "wx");
      await handle.writeFile(`${os.hostname()}:${process.pid} ${new Date().toISOString()}`);
      await handle.close();
      return () => unlink(lock).catch(() => {});
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs).catch(() => 0);
      if (age > LOCK_STALE_MS) {
        await unlink(lock).catch(() => {});
        continue;
      }
      if (!waited) {
        waited = true;
        onWait();
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Running ffmpeg on a graph                                                  */
/* -------------------------------------------------------------------------- */

/** Only what ffmpeg needs to run: none of the OMS's secrets. */
function cleanEnv() {
  const keep = ["PATH", "Path", "SystemRoot", "windir", "TEMP", "TMP", "TZ", "LANG", "HOME", "FONTCONFIG_PATH", "FONTCONFIG_FILE"];
  const env = { NODE_ENV: "production" } as NodeJS.ProcessEnv;
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  return env;
}

const lastLines = (s: string, n = 8) => s.trim().split("\n").slice(-n).join("\n");

function runSandboxed(args: string[], cwd: string, seconds: number, signal: AbortSignal, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-hide_banner", "-nostdin", "-y", ...args], { cwd, env: cleanEnv(), windowsHide: true });
    try {
      if (child.pid) os.setPriority(child.pid, 10);
    } catch {
      // Not allowed here; it still runs.
    }
    let err = "";
    let timedOut = false;
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      err = (err + s).slice(-60_000);
      const m = /time=(\d+):(\d+):([\d.]+)/g;
      let last: RegExpExecArray | null = null;
      for (let x = m.exec(s); x; x = m.exec(s)) last = x;
      if (last) onProgress(Math.min(1, (Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])) / seconds));
    });
    child.stdout.resume();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIME_LIMIT_MS);
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", (e) => reject(new MediaError(`ffmpeg could not start: ${e.message}`)));
    child.on("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (code === 0) resolve();
      else if (signal.aborted) reject(new MediaError("Stopped."));
      else if (timedOut) reject(new MediaError(`The render took longer than ${TIME_LIMIT_MS / 60_000} minutes and was stopped. Simplify the graph or render a shorter draft.`));
      else reject(new MediaError(`ffmpeg refused the graph:\n${lastLines(err)}`));
    });
  });
}

/** The arguments that open one input: only the file protocol, only plain media containers. */
function inputArgs(input: RenderInput, media: Resolved, fps: number, total: number): string[] {
  const args = ["-protocol_whitelist", "file", "-format_whitelist", READABLE_FORMATS.join(",")];
  if (media.kind === "image") {
    args.push("-loop", "1", "-framerate", String(fps), "-t", (input.duration ?? total).toFixed(3));
  } else {
    if (input.loop) args.push("-stream_loop", "-1");
    if (input.start) args.push("-ss", input.start.toFixed(3));
    if (input.duration) args.push("-t", input.duration.toFixed(3));
    else if (input.loop) args.push("-t", total.toFixed(3));
  }
  args.push("-i", media.file);
  return args;
}

/** The files the graph names, copied into its folder under the plain names localizeGraph gives them. */
async function stageFiles(checked: CheckedGraph, files: Record<string, string>, work: string, ctx: Pick<RefContext, "chatImages">) {
  const assetNames = new Map<number, string>();
  for (const id of checked.uses.assets) {
    const media = await resolveRef(`asset:${id}`, { chatImages: ctx.chatImages, workDir: work });
    if (media.kind !== "subtitles") throw new MediaError(`$asset/${id} isn't subtitles.`);
    const name = `asset-${id}${path.extname(media.file)}`;
    await copyFile(media.file, path.join(work, name));
    assetNames.set(id, name);
  }
  for (const font of checked.uses.fonts) {
    await copyFile(mediaPath("fonts", font), path.join(work, `font-${font}`)).catch(() => {
      throw new MediaError(`There's no font ${font}. video_assets fonts lists them; add_font adds a Google font.`);
    });
  }
  for (const lut of checked.uses.luts) {
    await copyFile(mediaPath("luts", lut), path.join(work, `lut-${lut}`)).catch(() => {
      throw new MediaError(`There's no look ${lut}. video_assets fonts lists the looks too.`);
    });
  }
  for (const name of checked.uses.files) await writeFile(path.join(work, `file-${name}`), files[name]);
  if (checked.uses.fontsDir) {
    await mkdir(path.join(work, "fonts"));
    const fontsDir = await mediaFolder("fonts");
    for (const f of await readdir(fontsDir)) await copyFile(path.join(fontsDir, f), path.join(work, "fonts", f));
  }
  return assetNames;
}

/**
 * Render `spec` to `outFile`. The graph is checked first (GraphError says what to fix);
 * inputs are resolved through refs.ts. Throws MediaError when ffmpeg refuses it.
 */
export async function renderGraph(
  spec: RenderSpec,
  outFile: string,
  ctx: Omit<RefContext, "workDir"> & { signal: AbortSignal; progress: (text: string) => void },
): Promise<RenderOutcome> {
  checkSpec(spec);
  if (spec.inputs.length === 0) throw new MediaError("A render needs at least one input (or a graph that makes its own picture, with one input it ignores).");
  if (spec.inputs.length > 40) throw new MediaError("At most 40 inputs.");
  const files = spec.files ?? {};
  for (const [name, content] of Object.entries(files)) {
    if (!SAFE_NAME.test(name)) throw new MediaError(`"${name}" isn't a plain file name (letters, digits, . _ -).`);
    if (content.length > 200_000) throw new MediaError(`${name} is longer than 200,000 characters.`);
  }
  const checked = checkGraph(spec.graph, spec.inputs.length, files);

  const work = await mkdtemp(path.join(os.tmpdir(), "seelie-render-"));
  try {
    const resolved: Resolved[] = [];
    for (const input of spec.inputs) {
      const media = await resolveRef(input.ref, { chatImages: ctx.chatImages, workDir: work });
      if (media.kind === "subtitles") throw new MediaError(`${input.ref} is subtitles: use it in the graph as $asset/<id>, not as an input.`);
      if (input.start !== undefined && (input.start < 0 || (media.duration && input.start >= media.duration))) {
        throw new MediaError(`${input.ref}: start ${input.start} s is outside its ${media.duration ?? 0} s.`);
      }
      resolved.push(media);
    }

    const assetNames = await stageFiles(checked, files, work, ctx);

    const { width, height } = outputSize(spec);
    const { fps, duration } = spec;
    const tail = [
      `[vout]scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p[__v]`,
      checked.hasAudio
        ? "[aout]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad[__a]"
        : "anullsrc=r=48000:cl=stereo[__a]",
    ];
    const graph = `${localizeGraph(spec.graph, (id) => assetNames.get(id) ?? `asset-${id}`)};\n${tail.join(";\n")}`;
    await writeFile(path.join(work, "graph.txt"), graph);

    const encode =
      spec.quality === "final"
        ? ["-c:v", "libx264", "-preset", "medium", "-crf", "19", "-profile:v", "high", "-b:a", "192k"]
        : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-b:a", "128k"];
    const args = [
      ...spec.inputs.flatMap((input, i) => inputArgs(input, resolved[i], fps, duration)),
      "-filter_complex_script", "graph.txt",
      "-map", "[__v]", "-map", "[__a]",
      "-t", duration.toFixed(3),
      ...encode,
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000",
      "-movflags", "+faststart", "-fs", MAX_OUTPUT,
      "out.mp4",
    ];

    const release = await takeLock(ctx.signal, () => ctx.progress("Waiting for another render to finish…"));
    try {
      let shown = -1;
      await runSandboxed(args, work, duration, ctx.signal, (p) => {
        const pct = Math.floor(p * 100);
        if (pct !== shown) {
          shown = pct;
          ctx.progress(`Rendering ${spec.quality} ${pct}%`);
        }
      });
    } finally {
      await release();
    }

    await mkdir(path.dirname(outFile), { recursive: true });
    await copyFile(path.join(work, "out.mp4"), outFile);
    const { size } = await stat(outFile);
    return { width, height, seconds: duration, bytes: size, sound: checked.hasAudio, resolved };
  } catch (err) {
    if (err instanceof GraphError) throw new MediaError(`The graph: ${err.message}`);
    throw err;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* A still from a graph (photo_edit)                                          */
/* -------------------------------------------------------------------------- */

/** Stills are bigger than videos: a 4K photo is 3584x4800. */
const MAX_STILL_SIDE = 8192;

/**
 * One picture from a graph: the same sandbox as videos, with images read as a single
 * frame (a clip from `start`), and [vout]'s first frame written as a PNG.
 */
export async function renderStill(
  spec: { graph: string; inputs: ({ ref: string; start?: number } | { file: string })[]; files?: Record<string, string> },
  ctx: Pick<RefContext, "chatImages"> & { signal: AbortSignal; progress: (text: string) => void },
): Promise<Buffer> {
  if (spec.inputs.length === 0 || spec.inputs.length > 40) throw new MediaError("A graph takes 1 to 40 inputs.");
  const files = spec.files ?? {};
  for (const [name, content] of Object.entries(files)) {
    if (!SAFE_NAME.test(name)) throw new MediaError(`"${name}" isn't a plain file name (letters, digits, . _ -).`);
    if (content.length > 200_000) throw new MediaError(`${name} is longer than 200,000 characters.`);
  }
  let checked: CheckedGraph;
  try {
    checked = checkGraph(spec.graph, spec.inputs.length, files);
  } catch (err) {
    if (err instanceof GraphError) throw new MediaError(`The graph: ${err.message}`);
    throw err;
  }
  const work = await mkdtemp(path.join(os.tmpdir(), "seelie-still-"));
  try {
    const args: string[] = [];
    for (const input of spec.inputs) {
      // A picture the server made itself (photo_edit's current image), by path.
      if ("file" in input) {
        args.push("-protocol_whitelist", "file", "-format_whitelist", READABLE_FORMATS.join(","), "-i", input.file);
        continue;
      }
      const media = await resolveRef(input.ref, { chatImages: ctx.chatImages, workDir: work });
      if (media.kind !== "image" && media.kind !== "video") throw new MediaError(`${input.ref} isn't a picture or a clip.`);
      args.push("-protocol_whitelist", "file", "-format_whitelist", READABLE_FORMATS.join(","));
      if (media.kind === "video" && input.start) args.push("-ss", input.start.toFixed(3));
      args.push("-i", media.file);
    }
    const assetNames = await stageFiles(checked, files, work, ctx);
    const graph = `${localizeGraph(spec.graph, (id) => assetNames.get(id) ?? `asset-${id}`)};
[vout]scale=w='min(iw,${MAX_STILL_SIDE})':h='min(ih,${MAX_STILL_SIDE})':force_original_aspect_ratio=decrease,format=rgba[__v]`;
    await writeFile(path.join(work, "graph.txt"), graph);
    ctx.progress("Rendering the still…");
    await runSandboxed([...args, "-filter_complex_script", "graph.txt", "-map", "[__v]", "-frames:v", "1", "-update", "1", "out.png"], work, 1, ctx.signal, () => {});
    return await readFile(path.join(work, "out.png"));
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* Looking at a video                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A small copy for the model to watch: 640 px on the long edge, 24 fps, mono sound,
 * at most `maxSeconds`. Gemini samples about a frame a second, so this loses nothing it
 * would see, and keeps half a minute near 1.5 MB.
 */
export async function makeWatchCopy(src: string, out: string, opts: { from?: number; maxSeconds: number; hasAudio: boolean }) {
  await mkdir(path.dirname(out), { recursive: true });
  await runFfmpeg([
    "-y",
    ...(opts.from ? ["-ss", opts.from.toFixed(3)] : []),
    "-t", opts.maxSeconds.toFixed(3),
    "-i", src,
    "-vf", "scale='if(gt(iw,ih),640,-2)':'if(gt(iw,ih),-2,640)',fps=24,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "32",
    ...(opts.hasAudio ? ["-c:a", "aac", "-ac", "1", "-b:a", "64k"] : ["-an"]),
    "-movflags", "+faststart",
    out,
  ]);
}

/** Stills from a video at the given seconds, as JPEGs no longer than `edge` on the long side. */
export async function stillsAt(src: string, times: number[], edge = 768): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const t of times) {
    const { stdout } = await runFfmpeg([
      "-ss", Math.max(0, t).toFixed(3), "-i", src, "-frames:v", "1",
      "-vf", `scale='if(gt(iw,ih),min(${edge},iw),-2)':'if(gt(iw,ih),-2,min(${edge},ih))'`,
      "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "4", "pipe:1",
    ]);
    if (!stdout.length) throw new MediaError(`There's no frame at ${t} s.`);
    out.push(stdout);
  }
  return out;
}
