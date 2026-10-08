import "server-only";

import { readFile, stat } from "node:fs/promises";

import type { AgentMessage } from "@paribelle/pi-agent";
import type { VideoContent } from "@paribelle/pi-ai";

import { runFfmpeg } from "@/lib/reels/ffmpeg";

import { mediaFolder, mediaPath, MediaError, videoFile } from "./files";
import { resolveRef } from "./refs";
import { makeWatchCopy } from "./render";

/**
 * What the model watches and listens to. Video blocks in the transcript carry only a
 * ref; the bytes are made here when a turn needs them (small watch copies, kept in
 * cache/) and are never stored with the chat.
 *
 *   asset:<id>[#<from>-<to>]      a clip or sound in Seelie's media, or a stretch of it
 *   video:<id>@<v>[#<from>-<to>]  a library version
 *   song:<id>[#<from>-<to>]       a library song's stretch
 */

export const WATCH_MAX_SECONDS = 120;
/** Videos sent with each turn: the latest few, within a budget the request can carry. */
const KEEP_WATCHING = 3;
const BUDGET_BYTES = 14 * 1024 * 1024;

export const WATCH_REF = /^(asset:\d{1,9}|video:\d{1,9}@\d{1,5}|song:\d{1,9})(?:#(\d{1,5}(?:\.\d{1,3})?)-(\d{1,5}(?:\.\d{1,3})?))?$/;

/** The watch copy (or listening copy) of a ref, as a block the model can take. */
export async function watchBlock(ref: string): Promise<VideoContent> {
  const m = WATCH_REF.exec(ref.trim());
  if (!m) throw new MediaError(`"${ref}" can't be watched: use asset:<id>, video:<id>@<version> or song:<id>, optionally #<from>-<to> in seconds.`);
  const [, base, fromText, toText] = m;
  const from = fromText ? Number(fromText) : 0;
  const to = toText ? Number(toText) : null;
  if (to !== null && to <= from) throw new MediaError(`${ref}: the stretch ends before it starts.`);

  const cache = await mediaFolder("cache");
  const media = await resolveRef(base, { chatImages: async () => [], workDir: cache });
  if (media.kind !== "video" && media.kind !== "audio") throw new MediaError(`${base} is ${media.kind === "image" ? "an image: look at it with video_assets info" : media.kind === "document" ? "a PDF: read it with pdf_read" : "subtitles"}, not something to watch.`);
  const length = Math.min(WATCH_MAX_SECONDS, (to ?? media.duration ?? WATCH_MAX_SECONDS) - from);
  if (media.duration && from >= media.duration) throw new MediaError(`${base} is ${media.duration} s long; ${from} s is past its end.`);

  const key = ref.trim().replace(/[^A-Za-z0-9]+/g, "-");
  let file: string;
  let mimeType: string;
  if (media.kind === "video") {
    mimeType = "video/mp4";
    const [, id, v] = /^video:(\d+)@(\d+)$/.exec(base) ?? [];
    if (id && !fromText) file = videoFile(Number(id), Number(v), "watch");
    else {
      file = mediaPath("cache", `watch960-${key}.mp4`);
      if (!(await exists(file))) await makeWatchCopy(media.file, file, { from, maxSeconds: length, hasAudio: media.hasAudio });
    }
  } else {
    mimeType = "audio/mpeg";
    file = mediaPath("cache", `listen-${key}.mp3`);
    if (!(await exists(file))) {
      await runFfmpeg(["-y", ...(from ? ["-ss", from.toFixed(3)] : []), "-t", length.toFixed(3), "-i", media.file, "-vn", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "64k", file]);
    }
  }
  const data = await readFile(file).catch(() => {
    throw new MediaError(`${ref}'s watch copy is gone (an old draft whose files were cleared).`);
  });
  return { type: "video", data: data.toString("base64"), mimeType, ref: ref.trim() };
}

const exists = (file: string) => stat(file).then(() => true, () => false);

/**
 * The transcript as one turn sends it: the latest few video blocks carry their bytes
 * (made from their refs when the transcript only kept the ref), older ones go empty,
 * which pi-ai turns into a line naming the ref. `cache` keeps bytes across the turns of
 * one run.
 */
export async function hydrateVideos(messages: AgentMessage[], cache: Map<string, string>): Promise<AgentMessage[]> {
  const spots: { m: number; b: number }[] = [];
  messages.forEach((message, m) => {
    if (!("role" in message) || (message.role !== "user" && message.role !== "toolResult") || typeof message.content === "string") return;
    message.content.forEach((block, b) => {
      if (block.type === "video") spots.push({ m, b });
    });
  });
  if (!spots.length) return messages;

  const keep = new Map<string, string>();
  let budget = BUDGET_BYTES;
  for (const { m, b } of spots.slice(-KEEP_WATCHING).reverse()) {
    const block = (messages[m] as { content: VideoContent[] }).content[b];
    let data = block.data || (block.ref ? cache.get(block.ref) : undefined);
    if (!data && block.ref && WATCH_REF.test(block.ref)) {
      data = await watchBlock(block.ref).then(
        (v) => v.data,
        () => undefined,
      );
      if (data) cache.set(block.ref, data);
    }
    if (!data || data.length > budget) continue;
    budget -= data.length;
    keep.set(`${m}:${b}`, data);
  }

  return messages.map((message, m) => {
    if (!spots.some((s) => s.m === m)) return message;
    const content = (message as { content: { type: string }[] }).content.map((block, b) =>
      block.type === "video" ? { ...block, data: keep.get(`${m}:${b}`) ?? "" } : block,
    );
    return { ...message, content } as AgentMessage;
  });
}
