import "server-only";

import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ffmpegPath, runFfmpeg } from "@/lib/reels/ffmpeg";

import { mediaFolder, mediaPath, MediaError, READABLE_FORMATS, SAFE_NAME } from "./files";
import { checkGraph, GraphError, localizeGraph, type CheckedGraph } from "./graph";
import { resolveRef, type RefContext } from "./refs";

/**
 * ffmpeg for Seelie's pictures and for looking at videos. photo_edit's still graphs run
 * here: what the model controls is the graph (checked by graph.ts) and which media go in;
 * the inputs are files the OMS resolved (only the file protocol, only plain media
 * containers), and ffmpeg runs with low CPU priority, a clean environment, its own folder
 * as working directory and a time limit, and is the first thing the kernel stops when
 * memory runs out. Videos themselves are compositions now, rendered by the renderer
 * container (renderer.ts).
 */

const TIME_LIMIT_MS = 10 * 60_000;

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
    if (signal.aborted) return reject(new MediaError("Stopped."));
    const child = spawn(ffmpegPath(), ["-hide_banner", "-nostdin", "-y", ...args], { cwd, env: cleanEnv(), windowsHide: true });
    if (child.pid) {
      try {
        os.setPriority(child.pid, 10);
      } catch {
        // Not allowed here; it still runs.
      }
      // When memory runs out, the kernel stops ffmpeg first, not the OMS (Linux only).
      if (process.platform === "linux") writeFile(`/proc/${child.pid}/oom_score_adj`, "1000").catch(() => {});
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
    child.on("close", (code, killedBy) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (code === 0) resolve();
      else if (signal.aborted) reject(new MediaError("Stopped."));
      else if (timedOut) reject(new MediaError(`ffmpeg took longer than ${TIME_LIMIT_MS / 60_000} minutes and was stopped. Simplify the graph.`));
      else if (killedBy === "SIGKILL") {
        reject(new MediaError("ffmpeg ran out of memory and was stopped: the graph holds too much at once. Scale big photos down first, or use fewer inputs at a time."));
      } else reject(new MediaError(`ffmpeg refused the graph:\n${lastLines(err)}`));
    });
  });
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
 * A small copy for the model to watch: 960 px on the long edge (a reel's text stays
 * readable at 540 px wide), 24 fps, mono sound, at most `maxSeconds`. Half a minute is
 * about 3 MB. Gemini samples about a frame a second; contact sheets cover the moments
 * between.
 */
export async function makeWatchCopy(src: string, out: string, opts: { from?: number; maxSeconds: number; hasAudio: boolean }) {
  await mkdir(path.dirname(out), { recursive: true });
  await runFfmpeg([
    "-y",
    ...(opts.from ? ["-ss", opts.from.toFixed(3)] : []),
    "-t", opts.maxSeconds.toFixed(3),
    "-i", src,
    "-vf", "scale='if(gt(iw,ih),960,-2)':'if(gt(iw,ih),-2,960)',fps=24,format=yuv420p",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
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
