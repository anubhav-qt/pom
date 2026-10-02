import "server-only";

import { Type } from "@paribelle/pi-ai";

import { createJob, getJob, isWorking, jobView, queueJob, runJob, saveFile, songLibrary } from "@/lib/reels/jobs";
import { MAX_PHOTOS, PHOTO_LONG_EDGE, THUMB_LONG_EDGE } from "@/lib/reels/types";
import { withBasePath } from "@/lib/base-path";

import { toJpeg } from "./images";
import { defineTool, ToolError } from "./types";
import { StringEnum } from "./util";

async function finished(jobId: number) {
  const view = await jobView(jobId);
  if (!view) throw new ToolError(`Reel ${jobId} is gone (reels are kept for two days).`);
  return {
    reelId: view.id,
    status: view.status,
    error: view.error,
    aiFailed: view.aiFailed || undefined,
    seconds: view.duration,
    layout: view.layout,
    song: view.song ? `${view.song.title} — ${view.song.artist} (start Instagram's music at ${Math.floor(view.song.cue / 60)}:${String(Math.round(view.song.cue % 60)).padStart(2, "0")})` : null,
    order: view.order,
    picks: view.picks?.map((p) => ({ photo: p.index + 1, keep: p.keep, shot: p.shot, look: p.look, quality: p.quality, reason: p.reason })),
    mood: view.direction?.mood,
    video: view.status === "done" ? withBasePath(`/api/reels/${view.id}/video?v=${view.version}`) : null,
    download: view.status === "done" ? withBasePath(`/api/reels/${view.id}/video?download=1&v=${view.version}`) : null,
    songsLeft: view.library.length,
  };
}

export const reels = defineTool({
  name: "reels",
  label: "Reels",
  description: [
    "Make an Instagram reel from photos attached in this chat, the way the Reels screen does: Gemini picks the best shots, orders them,",
    "chooses a song from the library and times every cut to its beat, then it renders an MP4 with the brand's end card.",
    "make: from `photos` (1-based positions among this chat's images, oldest first; default all). Options: layout (portrait 9:16 default, or landscape),",
    "useAi=false keeps every photo in order with no Gemini, song (a library song id, or 'next').",
    "remake: change an existing reel (reelId) with another song, layout, `keep` (photo positions to use) or repick.",
    "status: where a reel is. songs: the songs still unused (each song makes one reel). A finished reel's video link shows in the chat.",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["make", "remake", "status", "songs"]),
    photos: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }), { maxItems: MAX_PHOTOS })),
    reelId: Type.Optional(Type.Integer()),
    layout: Type.Optional(StringEnum(["portrait", "landscape"])),
    useAi: Type.Optional(Type.Boolean()),
    song: Type.Optional(Type.String({ description: "A library song id, or 'next'." })),
    keep: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
    repick: Type.Optional(Type.Boolean()),
  }),
  kind: (a) => (a.action === "status" || a.action === "songs" ? "read" : "write"),
  summary: (a) =>
    a.action === "songs"
      ? "Songs left"
      : a.action === "status"
        ? `Reel ${a.reelId}`
        : a.action === "make"
          ? `Make a ${a.layout ?? "portrait"} reel from ${a.photos?.length ? `${a.photos.length} photos` : "every photo in the chat"}${a.useAi === false ? " (no AI)" : ""}`
          : `Remake reel ${a.reelId}${a.song ? ` with song ${a.song}` : ""}${a.layout ? ` as ${a.layout}` : ""}`,
  async execute(a, ctx) {
    if (a.action === "songs") return { data: await songLibrary() };
    if (a.action === "status") {
      if (!a.reelId) throw new ToolError("Which reel (reelId)?");
      return { data: await finished(a.reelId) };
    }

    let jobId: number;
    if (a.action === "make") {
      const images = await ctx.chatImages();
      if (images.length === 0) throw new ToolError("No photos are attached in this chat. Ask for them to be attached.");
      const picks = a.photos?.length ? a.photos : images.map((_, i) => i + 1);
      const bad = picks.filter((p) => p > images.length);
      if (bad.length) throw new ToolError(`This chat has ${images.length} images; there's no photo ${bad.join(", ")}.`);
      if (picks.length < 3 && a.useAi !== false) throw new ToolError("A reel needs at least 3 photos.");
      jobId = await createJob("photos", ctx.user.id);
      for (const [idx, position] of picks.entries()) {
        ctx.progress(`Preparing photo ${idx + 1} of ${picks.length}…`);
        const image = images[position - 1];
        await saveFile(jobId, "photo", idx, `chat-${position}.jpg`, await toJpeg(Buffer.from(image.data, "base64"), PHOTO_LONG_EDGE, 90));
        await saveFile(jobId, "thumb", idx, `chat-${position}.jpg`, await toJpeg(Buffer.from(image.data, "base64"), THUMB_LONG_EDGE, 80));
      }
    } else {
      if (!a.reelId) throw new ToolError("Which reel (reelId)?");
      const job = await getJob(a.reelId);
      if (!job) throw new ToolError(`Reel ${a.reelId} is gone (reels are kept for two days).`);
      if (isWorking(job)) throw new ToolError("That reel is still being made.");
      jobId = a.reelId;
    }

    await queueJob(jobId);
    const run = runJob(jobId, {
      useAi: a.useAi !== false,
      keep: a.keep?.map((k) => k - 1),
      track: a.song === undefined ? undefined : a.song === "next" ? "next" : Number(a.song),
      layout: a.layout ?? "portrait",
      repick: a.repick === true,
    });
    // runJob never throws; report its progress while it works.
    let done = false;
    void run.finally(() => (done = true));
    while (!done) {
      await Promise.race([run, new Promise((r) => setTimeout(r, 1500))]);
      const view = await jobView(jobId);
      if (view && !done) ctx.progress(`${view.status} ${Math.round(view.progress * 100)}%`);
    }
    return { data: await finished(jobId) };
  },
});
