import "server-only";

import { writeFile } from "node:fs/promises";
import path from "node:path";

import type { ImageContent } from "@paribelle/pi-ai";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { reelTracks, seelieVideos } from "@/db/schema";

import { getAsset, mediaPath, MediaError, videoFile, type MediaKind } from "./files";

/**
 * What the video tools take as media, by name rather than by path:
 *
 *   chat:<n>         the n-th image attached in this chat (oldest first)
 *   asset:<id>       a clip, image or sound in Seelie's media (video_assets lists them)
 *   song:<id>        a library song: the ~70 s stretch around its hook
 *   video:<id>       a library video's latest render; video:<id>@<v> a given version
 *   brand:endcard    PariBelle's end card (1080x1920 PNG)
 */

export interface Resolved {
  ref: string;
  kind: MediaKind;
  file: string;
  name: string;
  duration: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  /** A library song (its id), so the render can claim it. */
  trackId?: number;
}

export interface RefContext {
  chatImages: () => Promise<ImageContent[]>;
  /** Where copies are written (chat images, songs): the render's own folder. */
  workDir: string;
}

/** The brand's end card, the one reels close on (shipped with the server; see next.config's tracing list). */
const END_CARD = path.join(process.cwd(), "src/lib/reels/assets/last-page.png");

const MIME_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

export const REF_PATTERN = /^(chat:\d{1,4}|asset:\d{1,9}|song:\d{1,9}|video:\d{1,9}(@\d{1,5})?|brand:endcard)$/;

export async function resolveRef(ref: string, ctx: RefContext): Promise<Resolved> {
  const r = ref.trim();
  if (!REF_PATTERN.test(r)) {
    throw new MediaError(`"${ref}" isn't media Seelie knows: use chat:<n>, asset:<id>, song:<id>, video:<id>[@<version>] or brand:endcard.`);
  }
  const [kind, rest] = r.split(":") as [string, string];

  if (kind === "chat") {
    const n = Number(rest);
    const images = await ctx.chatImages();
    const image = images[n - 1];
    if (!image) throw new MediaError(`This chat has ${images.length} image${images.length === 1 ? "" : "s"}; there's no chat:${n}.`);
    const file = path.join(ctx.workDir, `chat-${n}.${MIME_EXT[image.mimeType] ?? "jpg"}`);
    await writeFile(file, Buffer.from(image.data, "base64"));
    return { ref: r, kind: "image", file, name: `chat image ${n}`, duration: null, width: null, height: null, hasAudio: false };
  }

  if (kind === "asset") {
    const asset = await getAsset(Number(rest));
    if (!asset) throw new MediaError(`There's no ${r}.`);
    return {
      ref: r,
      kind: asset.kind as MediaKind,
      file: mediaPath(asset.file),
      name: asset.name,
      duration: asset.duration,
      width: asset.width,
      height: asset.height,
      hasAudio: asset.kind === "audio" || !!asset.hasAudio,
    };
  }

  if (kind === "song") {
    const id = Number(rest);
    const [song] = await db
      .select({ title: reelTracks.title, artist: reelTracks.artist, audio: reelTracks.audio, duration: reelTracks.duration, active: reelTracks.active })
      .from(reelTracks)
      .where(eq(reelTracks.id, id))
      .limit(1);
    if (!song) throw new MediaError(`There's no ${r} in the song library.`);
    const file = path.join(ctx.workDir, `song-${id}.m4a`);
    await writeFile(file, song.audio);
    return { ref: r, kind: "audio", file, name: `${song.title} — ${song.artist}`, duration: song.duration, width: null, height: null, hasAudio: true, trackId: id };
  }

  if (kind === "video") {
    const [idText, versionText] = rest.split("@");
    const id = Number(idText);
    const [video] = await db.select({ title: seelieVideos.title, version: seelieVideos.version, versions: seelieVideos.versions }).from(seelieVideos).where(eq(seelieVideos.id, id)).limit(1);
    if (!video || video.version === 0) throw new MediaError(`There's no rendered video:${id}.`);
    const version = versionText ? Number(versionText) : video.version;
    const v = (video.versions as { version: number; seconds: number; width: number; height: number; pruned?: boolean }[]).find((x) => x.version === version);
    if (!v || v.pruned) throw new MediaError(`video:${id} has no version ${version} on file.`);
    return { ref: r, kind: "video", file: videoFile(id, version), name: `${video.title} v${version}`, duration: v.seconds, width: v.width, height: v.height, hasAudio: true };
  }

  return { ref: r, kind: "image", file: END_CARD, name: "PariBelle end card", duration: null, width: 1080, height: 1920, hasAudio: false };
}
