import "server-only";

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { reelTracks } from "@/db/schema";
import type { TrackAnalysis } from "@/lib/reels/beats";
import { runFfmpeg } from "@/lib/reels/ffmpeg";

import {
  buildProject,
  checkTimes,
  checkZones,
  CROSSING_CODES,
  crossings,
  IGNORED_CHECKS,
  refsIn,
  softMedia,
  summarizeCheck,
  type BeatMap,
  type Composition,
  type Finding,
  type MediaSize,
} from "./composition";
import { mediaFolder, MediaError } from "./files";
import { ensureBrandFonts, fontFaces } from "./fonts";
import { resolveRef, type RefContext } from "./refs";
import { runRenderJob, type JobInfo } from "./renderer";
import { contactSheet } from "./sheet";

/**
 * Turning a composition into stills and videos: its media and fonts staged into a
 * HyperFrames project (photos fitted to 2400 px, clips re-encoded with a keyframe every
 * second so the renderer can seek them), handed to the renderer (renderer.ts), and what
 * comes back read: the check's findings, a contact sheet, the MP4, and checks on the
 * MP4 itself (loudness, black, frozen stretches).
 */

const IMAGE_EDGE = 2400;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

type Ctx = Pick<RefContext, "chatImages"> & { signal: AbortSignal; progress: (text: string) => void };

/** The library song's beat map (its own seconds), for beat checks and beats scenes. */
export async function songMap(c: Pick<Composition, "song">): Promise<BeatMap | null> {
  const id = Number(/^song:(\d+)$/.exec(c.song?.ref ?? "")?.[1]);
  if (!Number.isInteger(id)) return null;
  const [row] = await db.select({ analysis: reelTracks.analysis }).from(reelTracks).where(eq(reelTracks.id, id)).limit(1);
  const a = row?.analysis as TrackAnalysis | undefined;
  if (!a?.beats?.length) return null;
  return { beats: a.beats, bars: a.beats.filter((_, i) => i >= a.downbeat && (i - a.downbeat) % 4 === 0) };
}

/** Each scene's best moment in video seconds, with a label for the sheet. */
export function heroMoments(c: Composition) {
  return [...c.scenes]
    .sort((a, b) => a.start - b.start)
    .map((s) => {
      const at = r3(Math.min(s.start + s.duration - 0.04, s.start + (s.hero ?? s.duration * 0.6)));
      return { at, label: `${s.id} · ${at} s` };
    });
}

/* -------------------------------------------------------------------------- */
/* Staging                                                                    */
/* -------------------------------------------------------------------------- */

async function fitImage(bytes: Buffer, alpha: boolean): Promise<{ bytes: Buffer; ext: string; width: number; height: number }> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const img = await loadImage(bytes);
  const size = { width: img.width, height: img.height };
  const scale = Math.min(1, IMAGE_EDGE / Math.max(img.width, img.height));
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (scale === 1 && (isJpeg || alpha)) return { bytes, ext: isJpeg ? "jpg" : "png", ...size };
  const canvas = createCanvas(Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return { ...(alpha ? { bytes: await canvas.encode("png"), ext: "png" } : { bytes: await canvas.encode("jpeg", 90), ext: "jpg" }), ...size };
}

/** A clip the renderer can seek: H.264, a keyframe a second, at most 1920 px long. Cached by file. */
async function seekableClip(file: string, signal: AbortSignal): Promise<string> {
  const s = await stat(file);
  const key = createHash("sha1").update(`${file}|${s.size}|${s.mtimeMs}|v1`).digest("hex").slice(0, 20);
  const out = path.join(await mediaFolder("cache", "compose"), `${key}.mp4`);
  if (existsSync(out)) return out;
  const temp = `${out}.${process.pid}.tmp.mp4`;
  await runFfmpeg(
    [
      "-y", "-i", file, "-map", "0:v:0", "-map", "0:a:0?",
      "-vf", "scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))',fps=30,format=yuv420p",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "17", "-g", "30", "-keyint_min", "30",
      "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", temp,
    ],
    { signal },
  );
  await copyFile(temp, out);
  await rm(temp, { force: true });
  return out;
}

/** CSS unicode ranges for a font file's subset ("Mukta-400-devanagari.ttf"), so subsets of one family stack. */
const SUBSET_RANGES: Record<string, string> = {
  devanagari: "U+0900-097F, U+1CD0-1CF9, U+200C-200D, U+20A8, U+20B9, U+25CC, U+A830-A839, U+A8E0-A8FF",
  bengali: "U+0980-09FE, U+200C-200D, U+25CC",
  gurmukhi: "U+0A01-0A76, U+200C-200D, U+25CC",
  gujarati: "U+0A81-0AFF, U+200C-200D, U+25CC",
  oriya: "U+0B01-0B77, U+200C-200D, U+25CC",
  tamil: "U+0B82-0BFA, U+200C-200D, U+25CC",
  telugu: "U+0C00-0C7F, U+200C-200D, U+25CC",
  kannada: "U+0C80-0CF3, U+200C-200D, U+25CC",
  malayalam: "U+0D00-0D7F, U+200C-200D, U+25CC",
  "latin-ext": "U+0100-02AF, U+1E00-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF",
};

/** Lay `c` out in `projectDir`: index.html, its scenes, fonts and media. The scene element ids. */
async function stage(c: Composition, projectDir: string, map: BeatMap | null, ctx: Ctx, sizes?: Map<string, MediaSize>): Promise<Record<string, string>> {
  const assets = path.join(projectDir, "assets");
  const fonts = path.join(projectDir, "fonts");
  const scratch = path.join(path.dirname(projectDir), "in");
  await Promise.all([mkdir(assets, { recursive: true }), mkdir(fonts, { recursive: true }), mkdir(scratch, { recursive: true })]);

  ctx.progress("Getting the fonts and media ready…");
  await ensureBrandFonts(ctx.signal).catch((err: unknown) => {
    // Without the network the brand fonts may be missing; the page falls back to Noto, and the stills show it.
    console.error("[seelie] brand fonts", err);
  });
  const faces: string[] = [];
  const fontDir = await mediaFolder("fonts");
  for (const f of await fontFaces()) {
    await copyFile(path.join(fontDir, f.file), path.join(fonts, f.file));
    const subset = /-(devanagari|bengali|gurmukhi|gujarati|oriya|tamil|telugu|kannada|malayalam|latin-ext)\.\w+$/.exec(f.file)?.[1];
    faces.push(
      `@font-face { font-family: "${f.family}"; src: url("fonts/${f.file}"); font-weight: ${f.weight}; font-style: ${f.style}; font-display: block;${subset ? ` unicode-range: ${SUBSET_RANGES[subset]};` : ""} }`,
    );
  }

  const files = new Map<string, string>();
  for (const ref of refsIn(c)) {
    if (ctx.signal.aborted) throw new MediaError("Stopped.");
    const m = await resolveRef(ref, { chatImages: ctx.chatImages, workDir: scratch });
    const slug = ref.replace(/[^a-z0-9]+/gi, "-");
    if (m.kind === "image") {
      const bytes = await readFile(m.file);
      const alpha = bytes[0] === 0x89 && bytes[1] === 0x50; // PNG: may hold a cut-out's transparency
      const fitted = await fitImage(bytes, alpha);
      sizes?.set(ref, { width: fitted.width, height: fitted.height });
      await writeFile(path.join(assets, `${slug}.${fitted.ext}`), fitted.bytes);
      files.set(ref, `assets/${slug}.${fitted.ext}`);
    } else if (m.kind === "video") {
      if (m.width && m.height) sizes?.set(ref, { width: m.width, height: m.height });
      ctx.progress(`Preparing ${ref}…`);
      await copyFile(await seekableClip(m.file, ctx.signal), path.join(assets, `${slug}.mp4`));
      files.set(ref, `assets/${slug}.mp4`);
    } else if (m.kind === "audio") {
      const ext = path.extname(m.file) || ".m4a";
      await copyFile(m.file, path.join(assets, `${slug}${ext}`));
      files.set(ref, `assets/${slug}${ext}`);
    } else {
      throw new MediaError(`${ref} is ${m.kind === "document" ? "a PDF (pdf_edit as png makes pictures of its pages)" : "subtitles"}: a composition takes pictures, clips and sounds.`);
    }
  }

  const { files: project, ids } = buildProject(c, {
    file: (ref) => {
      const f = files.get(ref);
      if (!f) throw new MediaError(`${ref} isn't staged.`);
      return f;
    },
    fontFaces: faces.join("\n"),
    map,
  });
  for (const [name, text] of Object.entries(project)) {
    await mkdir(path.dirname(path.join(projectDir, name)), { recursive: true });
    await writeFile(path.join(projectDir, name), text);
  }
  return ids;
}

/* -------------------------------------------------------------------------- */
/* Sketching and rendering                                                    */
/* -------------------------------------------------------------------------- */

export interface Sketch {
  findings: Finding[];
  /** One JPEG: every scene at its best moment. */
  sheet: Buffer | null;
}

/** Check `c` and take a still of every scene (no video yet): what the owner approves. */
export async function sketchComposition(c: Composition, info: JobInfo, ctx: Ctx): Promise<Sketch> {
  const map = await songMap(c);
  const moments = heroMoments(c);
  let ids: Record<string, string> = {};
  const sizes = new Map<string, MediaSize>();
  const job = await runRenderJob(
    info,
    [
      { do: "check", at: checkTimes(c), zones: checkZones(c), ignore: IGNORED_CHECKS, gate: false },
      { do: "snapshot", at: moments.map((m) => m.at) },
    ],
    async (dir) => {
      ids = await stage(c, dir, map, ctx, sizes);
    },
    ctx,
  );
  try {
    const findings = [...summarizeCheck(job.result.steps.check, c, ids), ...softMedia(c, sizes)];
    const shots = job.result.steps.snapshot ?? [];
    const frames = await Promise.all(shots.map(async (rel, i) => ({ image: await readFile(job.file(rel)), label: moments[i]?.label ?? rel })));
    const sheet = frames.length ? await contactSheet(frames, { columns: Math.min(6, frames.length) }) : null;
    return { findings, sheet };
  } finally {
    await job.clear();
  }
}

export interface Rendered {
  /** Errors from the check that stopped it before the render (nothing rendered). */
  blocked: Finding[] | null;
  findings: Finding[];
  /** The MP4 (inside the job's folder until clear()). */
  file: string | null;
  clear(): Promise<void>;
}

/** Check `c`, and render it unless the check found errors (other than those in `ignore`). */
export async function renderComposition(c: Composition, quality: "draft" | "final", info: JobInfo, ctx: Ctx, ignore: string[] = []): Promise<Rendered> {
  const map = await songMap(c);
  let ids: Record<string, string> = {};
  const sizes = new Map<string, MediaSize>();
  const job = await runRenderJob(
    info,
    [
      {
        do: "check",
        at: checkTimes(c),
        zones: checkZones(c),
        ignore: [...IGNORED_CHECKS, ...ignore],
        gate: true,
        allow: { codes: CROSSING_CODES, windows: crossings(c) },
      },
      { do: "render", quality, fps: c.fps },
    ],
    async (dir) => {
      ids = await stage(c, dir, map, ctx, sizes);
    },
    ctx,
  );
  const findings = [...summarizeCheck(job.result.steps.check, c, ids), ...softMedia(c, sizes)].filter((f) => !ignore.includes(f.code));
  if (job.result.blocked?.length) {
    await job.clear();
    const errors = findings.filter((f) => f.severity === "error");
    // A refusal always says what it refused (the renderer's codes when the summary has none).
    const blocked = errors.length
      ? errors
      : [...new Set(job.result.blocked)].map((code) => ({ severity: "error" as const, code, scene: null, at: null, what: "the renderer's check flagged this", fix: null }));
    return { blocked, findings, file: null, clear: async () => {} };
  }
  const file = job.result.steps.render ? job.file(job.result.steps.render) : null;
  if (!file || !existsSync(file)) {
    await job.clear();
    throw new MediaError("The renderer finished without a video.");
  }
  return { blocked: null, findings, file, clear: job.clear };
}

/* -------------------------------------------------------------------------- */
/* Checks on the MP4                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What's wrong with the rendered file itself (black or frozen stretches), and its loudness
 * evened to Instagram's ~-14 LUFS in place: the sound is re-encoded with the gain, the
 * picture copied. `volume` is the song volume that gives the same result next time.
 */
export async function postChecks(file: string, c: Composition): Promise<{ notes: string[]; volume: number | null }> {
  const sound = !!c.song || !!c.sounds?.length;
  const { stderr } = await runFfmpeg([
    "-i", file,
    "-vf", "blackdetect=d=0.25:pix_th=0.08,freezedetect=n=0.002:d=1.2",
    ...(sound ? ["-af", "ebur128"] : ["-an"]),
    "-f", "null", "-",
  ]).catch(() => ({ stderr: "" }));
  const out: string[] = [];
  const sceneAt = (t: number) => c.scenes.find((s) => t >= s.start && t < s.start + s.duration)?.id;
  for (const m of stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)) {
    out.push(`Black from ${r3(+m[1])} to ${r3(+m[2])} s${sceneAt(+m[1]) ? ` (in "${sceneAt(+m[1])}")` : ""}: something there failed to show.`);
  }
  const starts = [...stderr.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => +m[1]);
  const ends = [...stderr.matchAll(/freeze_end: ([\d.]+)/g)].map((m) => +m[1]);
  starts.forEach((s, i) => {
    const e = ends[i] ?? c.duration;
    out.push(`Nothing moves from ${r3(s)} to ${r3(e)} s${sceneAt(s) ? ` (in "${sceneAt(s)}")` : ""}: keep every scene moving (a slow push, a drift, the next element coming in).`);
  });
  let volume: number | null = null;
  if (sound) {
    const loud = /Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(stderr);
    const lufs = loud ? Number(loud[1]) : null;
    if (lufs !== null && Number.isFinite(lufs) && lufs > -70 && (lufs < -15 || lufs > -13)) {
      const gain = Math.round((-14 - lufs) * 100) / 100;
      const now = c.song?.volume ?? 1;
      const want = Math.min(3.98, Math.round(now * 10 ** (gain / 20) * 100) / 100);
      const evened = `${file}.even.mp4`;
      try {
        // A boost goes through a limiter so peaks stay under -1 dB.
        await runFfmpeg(["-y", "-i", file, "-map", "0:v", "-map", "0:a", "-c:v", "copy", "-af", `volume=${gain}dB${gain > 0 ? ",alimiter=limit=0.89:level=0" : ""}`, "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", evened]);
        await rename(evened, file);
        if (c.song) volume = want;
        out.push(`Loudness was ${lufs} LUFS; evened to about -14 for Instagram${c.song ? ` (song.volume is now ${want}, so later renders come out the same)` : ""}.`);
      } catch {
        await rm(evened, { force: true });
        out.push(`Loudness ${lufs} LUFS; Instagram plays reels at about -14. Set song.volume to ${want} (now ${now}).`);
      }
    }
  }
  return { notes: out, volume };
}
