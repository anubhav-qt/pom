import "server-only";

import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { reelTracks, seelieVideos } from "@/db/schema";
import { withBasePath } from "@/lib/base-path";

import { mediaFolder, mediaPath, MediaError, videoFile } from "./files";
import { makeWatchCopy, renderGraph, stillsAt, type RenderInput, type RenderSpec } from "./render";
import type { RefContext } from "./refs";

/**
 * Seelie's video library. A video is a title, what was asked for, and every render of
 * it: the graph and inputs that made each version are kept, so any version can be
 * rendered again or changed. Files: videos/<id>/v<n>.mp4, v<n>.jpg (poster) and
 * v<n>-watch.mp4 (the small copy the model watches). Drafts beyond the latest five
 * lose their files; finals keep theirs.
 *
 * Songs: each library song makes one reel or video. A final render that uses `song:<id>`
 * claims it (reel_tracks.used_at, with used_by_job left empty, which keeps the Reels
 * screen off it) and the video holds it in track_id, so later versions may use it again.
 * Drafts may use a song only this video could claim. Moving a video to another song
 * gives the old one back, unless a published version used it.
 */

export interface VideoVersion {
  version: number;
  quality: "draft" | "final";
  /** What made it: enough to render it again. */
  inputs: RenderInput[];
  graph: string;
  files?: Record<string, string>;
  /** The size asked for; a draft's file is smaller (width/height below). */
  canvas: { width: number; height: number };
  fps: number;
  /** The file's. */
  width: number;
  height: number;
  seconds: number;
  bytes: number;
  sound: boolean;
  /** The library song it used. */
  song?: number;
  renderedAt: string;
  /** A draft whose files were removed to save space; its recipe stays. */
  pruned?: boolean;
}

export type Published =
  | {
      to: "paribelle";
      version: number;
      productId: string;
      product: string;
      /** The video's address on the store (Cloudinary). */
      url: string;
      /** The colours it was added to; empty for the product's own gallery only. */
      colours: string[];
      at: string;
      by: number | null;
    }
  | {
      to: "instagram";
      version: number;
      /** How it went up (a reel when missing: the first posts were all reels). */
      as?: "reel" | "carousel" | "story";
      mediaId: string;
      permalink: string | null;
      caption: string;
      at: string;
      by: number | null;
    };

export type VideoRow = typeof seelieVideos.$inferSelect;

const KEEP_DRAFTS = 5;

export const versionsOf = (v: Pick<VideoRow, "versions">) => v.versions as VideoVersion[];
export const publishedOf = (v: Pick<VideoRow, "published">) => v.published as Published[];

export function versionOf(video: VideoRow, version?: number): VideoVersion {
  const n = version ?? video.version;
  const v = versionsOf(video).find((x) => x.version === n);
  if (!v) throw new MediaError(`video:${video.id} has no version ${n}.`);
  return v;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

export async function getVideo(id: number): Promise<VideoRow | null> {
  const [row] = await db.select().from(seelieVideos).where(eq(seelieVideos.id, id)).limit(1);
  return row ?? null;
}

export async function listVideos(opts: { limit: number; chatId?: string }) {
  return db
    .select()
    .from(seelieVideos)
    .where(opts.chatId ? eq(seelieVideos.chatId, opts.chatId) : undefined)
    .orderBy(desc(seelieVideos.updatedAt))
    .limit(opts.limit);
}

/** Where the app plays, downloads and shows a version. */
export function videoLinks(id: number, version: number) {
  const base = `/api/seelie/videos/${id}?v=${version}`;
  return {
    video: withBasePath(base),
    download: withBasePath(`${base}&download=1`),
    poster: withBasePath(`${base}&part=poster`),
  };
}

/** How a tool result shows a video: its latest version, or the one given. */
export function videoSummary(video: VideoRow, version?: number) {
  const out: Record<string, unknown> = { ref: `video:${video.id}`, title: video.title };
  if (video.version === 0) return { ...out, version: 0, note: "not rendered yet" };
  const v = versionOf(video, version);
  return {
    ...out,
    version: v.version,
    latest: video.version,
    quality: v.quality,
    size: `${v.width}x${v.height}`,
    seconds: v.seconds,
    sound: v.sound,
    ...(v.song ? { song: `song:${v.song}` } : {}),
    ...(v.pruned ? { pruned: true } : videoLinks(video.id, v.version)),
    ...(video.liked !== null ? { liked: video.liked } : {}),
    ...(video.notes ? { notes: video.notes } : {}),
    ...(publishedOf(video).length ? { published: publishedOf(video).map((p) => ({ to: p.to, version: p.version, at: p.at, ...(p.to === "paribelle" ? { product: p.product } : { link: p.permalink }) })) } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Songs                                                                      */
/* -------------------------------------------------------------------------- */

const songsIn = (inputs: RenderInput[]) => [...new Set(inputs.map((i) => /^song:(\d+)$/.exec(i.ref.trim())?.[1]).filter(Boolean).map(Number))];

/** The library songs `video` may use (all the unused ones for a new video), its own first. */
export async function songsFor(video: Pick<VideoRow, "trackId"> | null) {
  const own = video?.trackId ?? null;
  return db
    .select({
      id: reelTracks.id,
      title: reelTracks.title,
      artist: reelTracks.artist,
      language: reelTracks.language,
      tags: reelTracks.tags,
      bpm: reelTracks.bpm,
      seconds: reelTracks.duration,
    })
    .from(reelTracks)
    .where(
      and(
        eq(reelTracks.active, true),
        own === null ? isNull(reelTracks.usedAt) : sql`(${reelTracks.usedAt} is null or (${reelTracks.usedByJob} is null and ${reelTracks.id} = ${own}))`,
      ),
    )
    .orderBy(sql`${reelTracks.id} = ${own ?? -1} desc`, reelTracks.title);
}

/** Throws unless every library song in `inputs` is one this video may use. */
async function checkSongs(video: VideoRow, inputs: RenderInput[]): Promise<number | null> {
  const songs = songsIn(inputs);
  if (songs.length > 1) throw new MediaError("A video uses one library song (each song makes one video). Mix other sounds from assets.");
  if (!songs.length) return null;
  const id = songs[0];
  const [song] = await db
    .select({ active: reelTracks.active, usedAt: reelTracks.usedAt, usedByJob: reelTracks.usedByJob })
    .from(reelTracks)
    .where(eq(reelTracks.id, id))
    .limit(1);
  if (!song) throw new MediaError(`There's no song:${id} in the library.`);
  if (!song.active) throw new MediaError(`song:${id} is switched off in the library.`);
  const mine = song.usedByJob === null && video.trackId === id;
  if (song.usedAt && !mine) throw new MediaError(`song:${id} already went into another reel or video (each song makes one). video_assets songs lists the ones left.`);
  return id;
}

/** Claim `id` for the video. False when someone else took it in the meantime. */
async function claimSong(id: number, videoId: number) {
  const rows = await db
    .update(reelTracks)
    .set({ usedAt: new Date(), usedByJob: null, useCount: sql`${reelTracks.useCount} + 1`, lastUsedAt: new Date() })
    .where(
      and(
        eq(reelTracks.id, id),
        eq(reelTracks.active, true),
        sql`(${reelTracks.usedAt} is null or (${reelTracks.usedByJob} is null and exists (select 1 from ${seelieVideos} where ${seelieVideos.id} = ${videoId} and ${seelieVideos.trackId} = ${id})))`,
      ),
    )
    .returning({ id: reelTracks.id });
  return rows.length > 0;
}

/** Give a song back unless a video still holds it or one of `video`'s published versions used it. */
async function releaseSong(id: number, video: VideoRow) {
  const published = new Set(publishedOf(video).map((p) => p.version));
  if (versionsOf(video).some((v) => v.song === id && published.has(v.version))) return;
  await db
    .update(reelTracks)
    .set({ usedAt: null })
    .where(
      and(
        eq(reelTracks.id, id),
        isNull(reelTracks.usedByJob),
        sql`not exists (select 1 from ${seelieVideos} where ${seelieVideos.trackId} = ${id})`,
      ),
    );
}

/* -------------------------------------------------------------------------- */
/* Rendering a version                                                        */
/* -------------------------------------------------------------------------- */

export async function createVideo(input: { chatId: string | null; userId: number | null; title: string; prompt: string | null }) {
  const [row] = await db
    .insert(seelieVideos)
    .values({ chatId: input.chatId, userId: input.userId, title: input.title.slice(0, 200), prompt: input.prompt?.slice(0, 4000) ?? null })
    .returning();
  return row;
}

/**
 * Render `spec` as the video's next version: the MP4, its poster and its watch copy.
 * A final that uses a library song claims it. Returns the updated row and the version.
 */
export async function renderVersion(
  videoId: number,
  spec: RenderSpec,
  ctx: Omit<RefContext, "workDir"> & { signal: AbortSignal; progress: (text: string) => void },
): Promise<{ video: VideoRow; version: VideoVersion }> {
  const before = await getVideo(videoId);
  if (!before) throw new MediaError(`There's no video:${videoId}.`);
  const song = await checkSongs(before, spec.inputs);

  await mediaFolder("videos", String(videoId));
  const temp = `render-${randomBytes(6).toString("hex")}`;
  const tempFile = (ext: string) => mediaPath("videos", String(videoId), `${temp}${ext}`);
  try {
    const out = await renderGraph(spec, tempFile(".mp4"), ctx);
    ctx.progress("Making the poster and the watch copy…");
    await makeWatchCopy(tempFile(".mp4"), tempFile("-watch.mp4"), { maxSeconds: out.seconds, hasAudio: true });
    const [poster] = await stillsAt(tempFile(".mp4"), [Math.min(out.seconds * 0.3, 3)], 720);
    await writeFile(tempFile(".jpg"), poster);

    if (spec.quality === "final" && song !== null && !(await claimSong(song, videoId))) {
      throw new MediaError(`song:${song} went into another reel or video while this rendered. Pick another song.`);
    }

    const item: Omit<VideoVersion, "version"> = {
      quality: spec.quality,
      inputs: spec.inputs,
      graph: spec.graph,
      ...(spec.files && Object.keys(spec.files).length ? { files: spec.files } : {}),
      canvas: { width: spec.width, height: spec.height },
      fps: spec.fps,
      width: out.width,
      height: out.height,
      seconds: out.seconds,
      bytes: out.bytes,
      sound: out.sound,
      ...(song !== null ? { song } : {}),
      renderedAt: new Date().toISOString(),
    };
    // The version number is taken in the same statement that records it.
    const [row] = await db
      .update(seelieVideos)
      .set({
        version: sql`${seelieVideos.version} + 1`,
        versions: sql`${seelieVideos.versions} || jsonb_build_array(${JSON.stringify(item)}::jsonb || jsonb_build_object('version', ${seelieVideos.version} + 1))`,
        ...(spec.quality === "final" ? { trackId: song } : {}),
        updatedAt: new Date(),
      })
      .where(eq(seelieVideos.id, videoId))
      .returning();
    const n = row.version;
    await rename(tempFile(".mp4"), videoFile(videoId, n));
    await rename(tempFile("-watch.mp4"), videoFile(videoId, n, "watch"));
    await rename(tempFile(".jpg"), videoFile(videoId, n, "poster"));

    if (spec.quality === "final" && before.trackId !== null && before.trackId !== song) await releaseSong(before.trackId, row);
    const video = await pruneDrafts(row);
    return { video, version: versionOf(video, n) };
  } finally {
    for (const ext of [".mp4", "-watch.mp4", ".jpg"]) await rm(tempFile(ext), { force: true }).catch(() => {});
  }
}

/** Remove the files of drafts older than the latest five. Their recipes stay. */
async function pruneDrafts(video: VideoRow): Promise<VideoRow> {
  const drafts = versionsOf(video)
    .filter((v) => v.quality === "draft" && !v.pruned)
    .sort((a, b) => b.version - a.version);
  const old = drafts.slice(KEEP_DRAFTS).filter((v) => v.version !== video.version);
  if (!old.length) return video;
  for (const v of old) {
    for (const part of ["mp4", "poster", "watch"] as const) await rm(videoFile(video.id, v.version, part), { force: true }).catch(() => {});
  }
  const gone = new Set(old.map((v) => v.version));
  const versions = versionsOf(video).map((v) => (gone.has(v.version) ? { ...v, pruned: true } : v));
  // Only the flags change; a version recorded meanwhile is kept by merging on the server.
  const [row] = await db
    .update(seelieVideos)
    .set({
      versions: sql`(select coalesce(jsonb_agg(case when (e->>'version')::int = any(${`{${[...gone].join(",")}}`}::int[]) then e || '{"pruned":true}'::jsonb else e end order by (e->>'version')::int), '[]'::jsonb) from jsonb_array_elements(${seelieVideos.versions}) e)`,
    })
    .where(eq(seelieVideos.id, video.id))
    .returning();
  return row ?? { ...video, versions };
}

/* -------------------------------------------------------------------------- */
/* Changing a video                                                           */
/* -------------------------------------------------------------------------- */

export async function updateVideo(id: number, patch: { title?: string; liked?: boolean | null; notes?: string | null }) {
  const [row] = await db
    .update(seelieVideos)
    .set({
      ...(patch.title !== undefined ? { title: patch.title.slice(0, 200) } : {}),
      ...(patch.liked !== undefined ? { liked: patch.liked } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes?.slice(0, 4000) ?? null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(seelieVideos.id, id))
    .returning();
  if (!row) throw new MediaError(`There's no video:${id}.`);
  return row;
}

export async function addPublished(id: number, entry: Published) {
  const [row] = await db
    .update(seelieVideos)
    .set({ published: sql`${seelieVideos.published} || jsonb_build_array(${JSON.stringify(entry)}::jsonb)`, updatedAt: new Date() })
    .where(eq(seelieVideos.id, id))
    .returning();
  return row;
}

/**
 * Delete a video and its files. Its song stays used (it went into a video, as a reel's
 * does when the reel is cleared); `npm run songs -- free <id>` puts one back.
 */
export async function deleteVideo(id: number) {
  const rows = await db.delete(seelieVideos).where(eq(seelieVideos.id, id)).returning({ id: seelieVideos.id });
  if (!rows.length) throw new MediaError(`There's no video:${id}.`);
  await rm(mediaPath("videos", String(id)), { recursive: true, force: true });
}

