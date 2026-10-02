import "server-only";

import { randomBytes } from "node:crypto";
import { copyFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { seelieAssets } from "@/db/schema";
import { FfmpegError, runFfmpeg } from "@/lib/reels/ffmpeg";

/**
 * Seelie's media folder: the ThinkPad's `seelie-media` volume (SEELIE_MEDIA_DIR), or
 * .seelie-media in the project on a dev machine. What lives there:
 *
 *   assets/   clips, images and sounds the tools work with (indexed in seelie_assets)
 *   videos/   the library's renders: videos/<id>/v<version>.mp4, its poster and watch copy
 *   fonts/    fonts the graphs may use ($font/<file>), added by name from Google Fonts
 *   luts/     colour looks the graphs may use ($lut/<file>.cube)
 *   cache/    copies made on demand (songs as files, watch copies of clips); safe to empty
 *   models/   the cut-out model, downloaded once
 */

export type MediaKind = "image" | "video" | "audio" | "subtitles";

export function mediaDir() {
  return path.resolve(process.env.SEELIE_MEDIA_DIR?.trim() || path.join(process.cwd(), ".seelie-media"));
}

/** A path inside the media folder; never outside it, whatever `parts` hold. */
export function mediaPath(...parts: string[]) {
  const root = mediaDir();
  const full = path.resolve(root, ...parts);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`${parts.join("/")} is outside the media folder.`);
  return full;
}

export async function mediaFolder(...parts: string[]) {
  const dir = mediaPath(...parts);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Only these names are ever written under fonts/, luts/ and a render's own files. */
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "text/x-ssa": "ass",
  "application/x-subrip": "srt",
};

export function kindOfMime(mime: string): MediaKind | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "text/x-ssa" || mime === "application/x-subrip") return "subtitles";
  return null;
}

export const extOf = (mime: string) => EXT[mime] ?? null;

/* -------------------------------------------------------------------------- */
/* Reading what a file is                                                     */
/* -------------------------------------------------------------------------- */

export interface MediaFacts {
  /** ffmpeg's demuxer for it ("mov,mp4,m4a,3gp,3g2,mj2", "matroska,webm", "image2", ...). */
  format: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

/** What ffmpeg's banner says a file holds. Never throws for a readable file. */
export async function inspect(file: string): Promise<MediaFacts> {
  let stderr = "";
  try {
    ({ stderr } = await runFfmpeg(["-i", file]));
  } catch (e) {
    // `ffmpeg -i` with no output always exits non-zero; the banner is still there.
    stderr = e instanceof FfmpegError ? e.stderr : "";
  }
  const format = /Input #0, (.+?), from /.exec(stderr)?.[1] ?? null;
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null;
  const v = /Stream #[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})[^\n]*/.exec(stderr);
  const rotated = /rotation of -?90/.test(stderr) || /rotate\s*:\s*-?90/.test(stderr);
  const w = v ? Number(v[1]) : null;
  const h = v ? Number(v[2]) : null;
  const fps = v ? Number(/([\d.]+) fps/.exec(v[0])?.[1] ?? NaN) : NaN;
  return {
    format,
    duration: duration && Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : null,
    width: rotated ? h : w,
    height: rotated ? w : h,
    fps: Number.isFinite(fps) ? fps : null,
    hasVideo: !!v,
    hasAudio: /Stream #[^\n]*Audio:/.test(stderr),
  };
}

/**
 * Containers a file the graphs read may be in. Anything else (a playlist, a concat list)
 * could point ffmpeg at other files, so it is refused on the way in and at render time.
 */
export const READABLE_FORMATS = [
  "mov",
  "mp4",
  "matroska",
  "webm",
  "avi",
  "image2",
  "png_pipe",
  "jpeg_pipe",
  "webp_pipe",
  "gif",
  "aac",
  "mp3",
  "wav",
  "ogg",
  "flac",
  "ass",
  "srt",
] as const;

export function readableFormat(format: string | null) {
  if (!format) return false;
  const names = format.split(",").map((n) => n.trim());
  return names.some((n) => (READABLE_FORMATS as readonly string[]).includes(n));
}

/* -------------------------------------------------------------------------- */
/* Assets                                                                     */
/* -------------------------------------------------------------------------- */

export type AssetRow = typeof seelieAssets.$inferSelect;

export interface NewAsset {
  /** The bytes, or a file to move in (it is renamed or copied). */
  bytes?: Buffer;
  fromFile?: string;
  mime: string;
  name: string;
  source: "upload" | "url" | "cutout" | "generated" | "frame" | "photoshoot" | "edited" | "mask";
  chatId: string | null;
  userId: number | null;
  meta?: Record<string, unknown>;
}

export class MediaError extends Error {}

/** Save a file to assets/ and index it. Media that ffmpeg can't read safely is refused. */
export async function saveAsset(input: NewAsset): Promise<AssetRow> {
  const kind = kindOfMime(input.mime);
  const ext = extOf(input.mime);
  if (!kind || !ext) throw new MediaError(`${input.mime} isn't a kind of file Seelie keeps.`);
  const month = new Date().toISOString().slice(0, 7);
  const rel = `assets/${month}/${randomBytes(9).toString("base64url")}.${ext}`;
  await mediaFolder("assets", month);
  const file = mediaPath(rel);
  if (input.bytes) await writeFile(file, input.bytes);
  else if (input.fromFile) await rename(input.fromFile, file).catch(() => copyFile(input.fromFile!, file));
  else throw new MediaError("Nothing to save.");

  let facts: MediaFacts | null = null;
  if (kind !== "subtitles") {
    facts = await inspect(file);
    if (!readableFormat(facts.format) || (kind === "video" && !facts.hasVideo) || (kind === "audio" && !facts.hasAudio)) {
      await rm(file, { force: true });
      throw new MediaError(`${input.name} isn't a ${kind} ffmpeg can read.`);
    }
  }
  const { size } = await stat(file);
  const [row] = await db
    .insert(seelieAssets)
    .values({
      chatId: input.chatId,
      userId: input.userId,
      kind,
      source: input.source,
      name: input.name.slice(0, 200),
      mime: input.mime,
      file: rel,
      bytes: size,
      width: facts?.width ?? null,
      height: facts?.height ?? null,
      duration: kind === "image" ? null : (facts?.duration ?? null),
      hasAudio: kind === "video" ? (facts?.hasAudio ?? false) : null,
      meta: input.meta ?? null,
    })
    .returning();
  return row;
}

/** The long edges an image asset's small JPEG copies are made at (media/thumbs.ts). */
export const THUMB_EDGES = [480, 1280] as const;
export type ThumbEdge = (typeof THUMB_EDGES)[number];
export const thumbFile = (id: number, edge: ThumbEdge) => mediaPath("cache", "thumbs", `${id}-${edge}.jpg`);

/** An asset's file, its small copies and its row, gone for good. */
export async function removeAsset(id: number): Promise<boolean> {
  const [row] = await db.delete(seelieAssets).where(eq(seelieAssets.id, id)).returning({ file: seelieAssets.file });
  if (row) await Promise.all([mediaPath(row.file), ...THUMB_EDGES.map((e) => thumbFile(id, e))].map((f) => rm(f, { force: true })));
  return !!row;
}

export async function getAsset(id: number): Promise<AssetRow | null> {
  const [row] = await db.select().from(seelieAssets).where(eq(seelieAssets.id, id)).limit(1);
  return row ?? null;
}

/** How a tool result names an asset. */
export function assetSummary(a: AssetRow) {
  return {
    ref: `asset:${a.id}`,
    kind: a.kind,
    name: a.name,
    source: a.source,
    ...(a.width ? { size: `${a.width}x${a.height}` } : {}),
    ...(a.duration ? { seconds: Math.round(a.duration * 10) / 10 } : {}),
    ...(a.kind === "video" ? { sound: a.hasAudio } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* The library's files                                                        */
/* -------------------------------------------------------------------------- */

/** A library video's render: videos/<id>/v<version>.mp4, and beside it its poster and watch copy. */
export const videoFile = (id: number, version: number, part: "mp4" | "poster" | "watch" = "mp4") =>
  mediaPath("videos", String(id), part === "mp4" ? `v${version}.mp4` : part === "poster" ? `v${version}.jpg` : `v${version}-watch.mp4`);
