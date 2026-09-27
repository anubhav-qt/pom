import "server-only";

import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { db } from "@/db";
import { reelFeedback, reelJobFiles, reelJobs, reelTracks } from "@/db/schema";
import { GeminiRequestError, GeminiUnavailableError } from "@/lib/gemini-pool";

import type { TrackAnalysis } from "./beats";
import { runFfmpeg } from "./ffmpeg";
import {
  chooseTrack,
  orderShots,
  photoReelFits,
  planDirectedReel,
  planPhotoReel,
  planVideoReel,
  reconcile,
  videoReelFits,
  type PhotoPlan,
  type VideoPlan,
} from "./plan";
import { directReel, isKeepAll, keepAll } from "./select";
import type { PhotoPick, ReelDirection, ReelJobView, ReelKind, ReelLayout, ReelSong, ReelStatus } from "./types";

/**
 * A reel job from upload to finished MP4. The routes in app/api/reels only
 * validate and hand over; this file owns the state machine:
 *
 *   uploading → queued → (selecting | analyzing) → rendering → done
 *                                  ↘ error (any step)
 *
 * The work runs after the HTTP response (`after()` in the start route), so
 * the phone can lock or leave the screen; the screen just polls `jobView`.
 */

/** The brand's end card, shipped with the server (see next.config's tracing list). */
export const LAST_PAGE_FILE = path.join(process.cwd(), "src/lib/reels/assets/last-page.png");

/** A job still "working" after this long died with its server (a timeout, a deploy). */
const STALE_MS = 6 * 60_000;
const KEEP_JOBS_MS = 48 * 3600_000;

/** A problem worth showing the person as is. */
class ReelError extends Error {}

type StoredPlan = (PhotoPlan | VideoPlan) & { song: ReelSong; layout?: ReelLayout; endCard?: boolean };

export async function createJob(kind: ReelKind, userId: number): Promise<number> {
  // Housekeeping first: the uploads and videos of old jobs are dead weight.
  await db.delete(reelJobs).where(lt(reelJobs.createdAt, new Date(Date.now() - KEEP_JOBS_MS)));
  const [row] = await db.insert(reelJobs).values({ kind, createdBy: userId }).returning({ id: reelJobs.id });
  return row.id;
}

export async function saveFile(jobId: number, kind: "photo" | "thumb" | "video", idx: number, name: string, bytes: Buffer) {
  await db
    .insert(reelJobFiles)
    .values({ jobId, kind, idx, name, bytes })
    .onConflictDoUpdate({ target: [reelJobFiles.jobId, reelJobFiles.kind, reelJobFiles.idx], set: { bytes, name } });
}

/** Take a photo (and its preview) out of a reel. */
export async function removePhoto(jobId: number, idx: number) {
  await db
    .delete(reelJobFiles)
    .where(and(eq(reelJobFiles.jobId, jobId), inArray(reelJobFiles.kind, ["photo", "thumb"]), eq(reelJobFiles.idx, idx)));
}

/**
 * The songs a reel may use: in the library, and not already in another reel.
 * Each song makes one reel. The job that used a song keeps it (a remake is the
 * same reel), and gives it back when it moves on to another song.
 */
const usable = (jobId?: number) =>
  and(
    eq(reelTracks.active, true),
    jobId === undefined ? isNull(reelTracks.usedAt) : or(isNull(reelTracks.usedAt), eq(reelTracks.usedByJob, jobId)),
  );

/** The songs left, for the song picker. */
export async function songLibrary(jobId?: number) {
  return db
    .select({ id: reelTracks.id, title: reelTracks.title, artist: reelTracks.artist })
    .from(reelTracks)
    .where(usable(jobId))
    .orderBy(asc(reelTracks.title));
}

/** Take a song for this job, unless another reel got to it first. */
async function claimSong(trackId: number, jobId: number): Promise<boolean> {
  const rows = await db
    .update(reelTracks)
    .set({ usedAt: new Date(), usedByJob: jobId })
    .where(and(eq(reelTracks.id, trackId), usable(jobId)))
    .returning({ id: reelTracks.id });
  return rows.length > 0;
}

/** Give back every song this job holds except `keep` (the song of its finished reel, if any). */
async function releaseSongs(jobId: number, keep: number | null) {
  await db
    .update(reelTracks)
    .set({ usedAt: null, usedByJob: null })
    .where(and(eq(reelTracks.usedByJob, jobId), keep === null ? undefined : ne(reelTracks.id, keep)));
}

export async function getJob(id: number) {
  const [job] = await db
    .select({
      id: reelJobs.id,
      kind: reelJobs.kind,
      status: reelJobs.status,
      updatedAt: reelJobs.updatedAt,
    })
    .from(reelJobs)
    .where(eq(reelJobs.id, id))
    .limit(1);
  return job ?? null;
}

const WORKING: ReelStatus[] = ["queued", "selecting", "analyzing", "rendering"];

export function isWorking(job: { status: string; updatedAt: Date }) {
  return WORKING.includes(job.status as ReelStatus) && Date.now() - job.updatedAt.getTime() < STALE_MS;
}

/** Mark a job queued before its work is scheduled, so the first poll already sees it moving. */
export async function queueJob(id: number) {
  await db
    .update(reelJobs)
    .set({ status: "queued", progress: 0, error: null, aiFailed: false, updatedAt: new Date() })
    .where(eq(reelJobs.id, id));
}

export async function jobView(id: number): Promise<ReelJobView | null> {
  const [job] = await db
    .select({
      id: reelJobs.id,
      kind: reelJobs.kind,
      status: reelJobs.status,
      progress: reelJobs.progress,
      error: reelJobs.error,
      aiFailed: reelJobs.aiFailed,
      picks: reelJobs.picks,
      direction: reelJobs.direction,
      plan: reelJobs.plan,
      version: reelJobs.version,
      updatedAt: reelJobs.updatedAt,
    })
    .from(reelJobs)
    .where(eq(reelJobs.id, id))
    .limit(1);
  if (!job) return null;

  const [library, [answer]] = await Promise.all([
    songLibrary(id),
    db
      .select({ liked: reelFeedback.liked })
      .from(reelFeedback)
      .where(and(eq(reelFeedback.jobId, id), eq(reelFeedback.version, job.version)))
      .limit(1),
  ]);

  let status = job.status as ReelStatus;
  let error = job.error;
  if (WORKING.includes(status) && !isWorking(job)) {
    status = "error";
    error = "The render stopped before it finished (the server timed out). Try again.";
  }

  const plan = job.plan as StoredPlan | null;
  return {
    id: job.id,
    kind: job.kind as ReelKind,
    status,
    progress: job.progress,
    error,
    aiFailed: job.aiFailed,
    picks: (job.picks as PhotoPick[] | null) ?? null,
    order: plan?.kind === "photos" ? plan.shots.map((s) => s.photo) : null,
    scenes:
      plan?.kind === "photos"
        ? plan.shots.map((s) => ({
            photo: s.photo,
            seconds: Math.round((s.end - s.start) * 100) / 100,
            // Reels made before transitions existed.
            transition: s.transition ?? "cut",
          }))
        : null,
    directed: plan?.kind === "photos" ? (plan.directed ?? false) : false,
    direction: (job.direction as ReelDirection | null) ?? null,
    song: plan?.song ?? null,
    duration: plan?.total ?? null,
    layout: plan ? (plan.layout ?? "portrait") : null,
    videoCut: plan?.kind === "video" ? { at: plan.contentEnd, endCard: plan.endCard ?? false } : null,
    version: job.version,
    library,
    feedback: answer?.liked ?? null,
  };
}

export interface RunOptions {
  /** Let Gemini choose the photos. False keeps every photo. */
  useAi: boolean;
  /** The person's own picks (upload indices), replacing the kept set. */
  keep?: number[];
  /** A specific song, or "next" for the next best one. */
  track?: number | "next";
  /** The reel's shape. Portrait unless asked. */
  layout: ReelLayout;
  /** Throw away the last picks and ask Gemini again. */
  repick?: boolean;
}

/** Do the work. Never throws: failures land on the job row for the screen to show. */
export async function runJob(id: number, opts: RunOptions): Promise<void> {
  let lastWrite = 0;
  const setStatus = async (status: ReelStatus, progress: number, force = false) => {
    const now = Date.now();
    if (!force && now - lastWrite < 700) return;
    lastWrite = now;
    await db.update(reelJobs).set({ status, progress, updatedAt: new Date() }).where(eq(reelJobs.id, id));
  };

  const tmp = await mkdtemp(path.join(os.tmpdir(), `reel-${id}-`));
  /** The song of the job's finished reel, which a failed remake must not give back. */
  let keepSong: number | null = null;
  try {
    // Loaded here, not at the top: the renderers pull in the canvas library's
    // native build, which only the run route ships (see next.config). The
    // routes that poll, upload and stream never need it.
    const { cardFrame, renderPhotoReel } = await import("./render-photos");
    const { analyseVideo, renderVideoReel } = await import("./render-video");

    const [job] = await db
      .select({
        kind: reelJobs.kind,
        picks: reelJobs.picks,
        direction: reelJobs.direction,
        triedTracks: reelJobs.triedTracks,
        trackId: reelJobs.trackId,
      })
      .from(reelJobs)
      .where(eq(reelJobs.id, id))
      .limit(1);
    if (!job) return;
    keepSong = job.trackId;

    const tracks = await db
      .select({
        id: reelTracks.id,
        title: reelTracks.title,
        artist: reelTracks.artist,
        language: reelTracks.language,
        tags: reelTracks.tags,
        bpm: reelTracks.bpm,
        windowStart: reelTracks.windowStart,
        analysis: reelTracks.analysis,
        useCount: reelTracks.useCount,
        lastUsedAt: reelTracks.lastUsedAt,
        createdAt: reelTracks.createdAt,
      })
      .from(reelTracks)
      .where(usable(id));
    if (tracks.length === 0) {
      throw new ReelError("Every song in the library has made a reel already. Add new songs (docs/reels/procedure.md).");
    }
    let library = tracks.map((t) => ({ ...t, analysis: t.analysis as TrackAnalysis }));
    type Track = (typeof library)[number];
    // "Different song" skips every song this job has had; a picked song is
    // exactly that one; a remake with new picks keeps the song it had.
    const tried = opts.track === "next" ? job.triedTracks : [];
    let requested = typeof opts.track === "number" ? opts.track : opts.track === undefined ? job.trackId : null;
    /** The song, claimed for this job. Another reel can take a song after the query; then the next best. */
    const pick = async (fits: (t: Track) => boolean): Promise<Track | null> => {
      for (let attempt = 0; attempt < 5; attempt++) {
        const t =
          chooseTrack(library, { tried, now: new Date(), requested, fits }) ?? chooseTrack(library, { tried, now: new Date(), fits });
        if (!t || (await claimSong(t.id, id))) return t;
        library = library.filter((x) => x.id !== t.id);
      }
      return null;
    };

    let plan: PhotoPlan | VideoPlan;
    const out = path.join(tmp, "reel.mp4");
    const audio = path.join(tmp, "song.m4a");
    let track: Track | null;
    let videoFacts: { endCard: boolean } | null = null;

    if (job.kind === "photos") {
      // Picks are keyed by upload number, which has gaps once a photo is removed.
      const onFile = await db
        .select({ idx: reelJobFiles.idx })
        .from(reelJobFiles)
        .where(and(eq(reelJobFiles.jobId, id), eq(reelJobFiles.kind, "thumb")))
        .orderBy(asc(reelJobFiles.idx));
      const idxs = onFile.map((t) => t.idx);
      if (idxs.length === 0) throw new ReelError("No photos were uploaded.");
      let picks = job.picks as PhotoPick[] | null;
      let direction = job.direction as ReelDirection | null;
      // Photos added or removed since the last pick, or Gemini asked for after
      // a run without it: ask again.
      const changed = picks && (picks.length !== idxs.length || picks.some((p) => !idxs.includes(p.index)));
      if (changed || opts.repick || (picks && opts.useAi && isKeepAll(picks))) {
        picks = null;
        direction = null;
      }
      if (!picks) {
        if (opts.useAi) {
          await setStatus("selecting", 0, true);
          const thumbs = await db
            .select({ bytes: reelJobFiles.bytes })
            .from(reelJobFiles)
            .where(and(eq(reelJobFiles.jobId, id), eq(reelJobFiles.kind, "thumb")))
            .orderBy(asc(reelJobFiles.idx));
          // Gemini sees positions 0..n-1; the job knows photos by upload number.
          const fixed = typeof opts.track === "number" && library.some((t) => t.id === opts.track) ? opts.track : null;
          const answer = await directReel(
            thumbs.map((t) => t.bytes),
            {
              songs: library.map((t) => ({ id: t.id, title: t.title, artist: t.artist, language: t.language, bpm: t.bpm, tags: t.tags })),
              fixedSong: fixed,
            },
          );
          picks = answer.picks.map((p) => ({ ...p, index: idxs[p.index] }));
          direction = answer.direction && {
            ...answer.direction,
            scenes: answer.direction.scenes.map((sc) => ({ ...sc, photo: idxs[sc.photo] })),
          };
        } else {
          picks = keepAll(idxs.length).map((p, i) => ({ ...p, index: idxs[i] }));
        }
      }
      if (opts.keep) {
        const keep = new Set(opts.keep);
        picks = picks.map((p) => ({ ...p, keep: keep.has(p.index) }));
      }
      // The person's taps win over the direction: their photos in, the rest out.
      if (direction) direction = reconcile(direction, picks);
      await db.update(reelJobs).set({ picks, direction }).where(eq(reelJobs.id, id));

      // Directed by Gemini when AI is on and it answered with scenes; else the rules.
      const directed = opts.useAi && direction && direction.scenes.length > 0 ? direction : null;
      const order = directed ? directed.scenes.map((sc) => sc.photo) : orderShots(picks);
      if (order.length === 0) throw new ReelError("Keep at least one photo.");
      // Gemini's song for a first make, unless the person chose one or asked for a different one.
      if (directed?.song != null && requested === null && opts.track === undefined) requested = directed.song;
      const finalPicks = picks;
      track = await pick((t) => photoReelFits(order, finalPicks, t, directed));
      if (!track) throw new ReelError("No song left in the library is long enough for these photos.");
      plan = (directed ? planDirectedReel(directed, track) : planPhotoReel(order, picks, track))!;

      await setStatus("rendering", 0, true);
      const used = [...new Set(plan.shots.map((s) => s.photo))];
      const rows = await db
        .select({ idx: reelJobFiles.idx, bytes: reelJobFiles.bytes })
        .from(reelJobFiles)
        .where(and(eq(reelJobFiles.jobId, id), eq(reelJobFiles.kind, "photo"), inArray(reelJobFiles.idx, used)));
      const photos = new Map(rows.map((r) => [r.idx, r.bytes]));
      if (photos.size !== used.length) throw new ReelError("Some photos did not finish uploading. Start again.");

      await writeFile(audio, await trackAudio(track.id));
      await renderPhotoReel({
        plan,
        layout: opts.layout,
        photos,
        lastPage: await readFile(LAST_PAGE_FILE),
        audioFile: audio,
        outFile: out,
        onProgress: (p) => void setStatus("rendering", p * 0.97),
      });
    } else {
      await setStatus("analyzing", 0, true);
      const chunks = await db
        .select({ bytes: reelJobFiles.bytes })
        .from(reelJobFiles)
        .where(and(eq(reelJobFiles.jobId, id), eq(reelJobFiles.kind, "video")))
        .orderBy(asc(reelJobFiles.idx));
      if (chunks.length === 0) throw new ReelError("No video was uploaded.");
      const input = path.join(tmp, "input.mp4");
      await writeFile(input, Buffer.concat(chunks.map((c) => c.bytes)));

      const facts = await analyseVideo(input);
      videoFacts = facts;
      if (facts.contentEnd > 58) {
        throw new ReelError("That video is too long for a reel. Trim it to under a minute and try again.");
      }
      track = await pick((t) => videoReelFits(facts, t));
      if (!track) throw new ReelError("No song left in the library is long enough for this video.");
      plan = planVideoReel(facts, track)!;

      await setStatus("rendering", 0, true);
      await writeFile(audio, await trackAudio(track.id));
      const card = path.join(tmp, "card.png");
      await writeFile(card, await cardFrame(await readFile(LAST_PAGE_FILE), opts.layout));
      await renderVideoReel({
        plan,
        facts,
        layout: opts.layout,
        videoFile: input,
        cardFile: card,
        audioFile: audio,
        outFile: out,
        onProgress: (p) => void setStatus("rendering", p * 0.97),
      });
    }

    // The same reel without music, for Instagram and Meta ads: add the song
    // there, from the cue, and the cuts still land on its beats.
    const silent = path.join(tmp, "reel-silent.mp4");
    await runFfmpeg(["-y", "-i", out, "-map", "0:v", "-c", "copy", "-movflags", "+faststart", silent]);

    const song: ReelSong = {
      id: track.id,
      title: track.title,
      artist: track.artist,
      bpm: track.bpm,
      cue: Math.round((track.windowStart + plan.segStart) * 10) / 10,
    };
    await db
      .update(reelJobs)
      .set({
        status: "done",
        progress: 1,
        error: null,
        plan: { ...plan, song, layout: opts.layout, ...(videoFacts ? { endCard: videoFacts.endCard } : {}) },
        trackId: track.id,
        triedTracks: [...new Set([...job.triedTracks, track.id])],
        output: await readFile(out),
        outputSilent: await readFile(silent),
        version: sql`${reelJobs.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(reelJobs.id, id));
    await db
      .update(reelTracks)
      .set({ useCount: sql`${reelTracks.useCount} + 1`, lastUsedAt: new Date() })
      .where(eq(reelTracks.id, track.id));
    // The reel now has this song: any other it held (the song before "Different song") goes back.
    await releaseSongs(id, track.id);
  } catch (e) {
    const aiFailed = e instanceof GeminiUnavailableError || e instanceof GeminiRequestError;
    const message =
      e instanceof ReelError
        ? e.message
        : aiFailed
          ? `Gemini could not direct the reel. ${e.message}`
          : `Something went wrong while making the reel: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`;
    console.error(`reel ${id} failed:`, e);
    // A song claimed for this render goes back; the finished reel keeps its own.
    await releaseSongs(id, keepSong).catch(() => {});
    await db
      .update(reelJobs)
      .set({ status: "error", error: message, aiFailed, updatedAt: new Date() })
      .where(eq(reelJobs.id, id))
      .catch(() => {});
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function trackAudio(trackId: number): Promise<Buffer> {
  const [row] = await db.select({ audio: reelTracks.audio }).from(reelTracks).where(eq(reelTracks.id, trackId)).limit(1);
  if (!row) throw new ReelError("That song is no longer in the library.");
  return row.audio;
}

/** One slice of a finished MP4 for the player or a download. */
export async function videoSlice(id: number, silent: boolean, start: number, length: number) {
  const col = silent ? sql.raw(`"output_silent"`) : sql.raw(`"output"`);
  const result = await db.execute(sql`
    SELECT octet_length(${col}) AS size,
           substring(${col} FROM ${start + 1} FOR ${length}) AS chunk,
           version
    FROM reel_jobs WHERE id = ${id}
  `);
  const row = (result as unknown as { rows: { size: number | null; chunk: Buffer | null; version: number }[] }).rows[0];
  if (!row || row.size == null || row.chunk == null) return null;
  return { size: Number(row.size), chunk: row.chunk, version: row.version };
}
