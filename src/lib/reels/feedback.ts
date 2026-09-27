import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/db";
import { reelFeedback } from "@/db/schema";

import { jobView } from "./jobs";
import type { PhotoPick, ReelDirection, ReelLayout, ReelScene, ReelSong } from "./types";

/**
 * "Do you like this reel?" One answer per finished render, changed in place
 * if the person taps the other button. Jobs are deleted after two days, so
 * each answer keeps a copy of what the reel was; docs/reels/feedback.md
 * reads them (`npm run reels:feedback`) to improve the directing prompt.
 */

/** What a reel was, as the person saw it when they answered. */
export interface ReelFeedbackSnapshot {
  song: ReelSong | null;
  duration: number | null;
  layout: ReelLayout | null;
  /** Photos uploaded, and how many of them went in. Null for a video reel. */
  photos: number | null;
  kept: number | null;
  /** As rendered: each photo, its seconds on the beat and its transition. */
  scenes: ReelScene[] | null;
  /** Gemini's direction as it answered (with the person's taps applied). */
  direction: ReelDirection | null;
  /** Gemini's verdict on every photo: shot, look, quality, reason. */
  picks: PhotoPick[] | null;
  videoCut: { at: number; endCard: boolean } | null;
}

export class FeedbackError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/**
 * Record the answer for `version` of the job's reel. Throws `FeedbackError`
 * when there is no finished reel, or the reel on the server has moved on to
 * another render since the person watched it.
 */
export async function saveFeedback(jobId: number, version: number, liked: boolean, userId: number) {
  const view = await jobView(jobId);
  if (!view) throw new FeedbackError("That reel is gone (reels are kept for two days).", 404);
  if (view.status !== "done") throw new FeedbackError("The reel isn't finished yet.", 409);
  if (view.version !== version) throw new FeedbackError("The reel has been remade since. Watch the new one, then answer.", 409);

  const directed = view.directed;
  const reel: ReelFeedbackSnapshot = {
    song: view.song,
    duration: view.duration,
    layout: view.layout,
    photos: view.kind === "photos" ? (view.picks?.length ?? null) : null,
    kept: view.kind === "photos" && view.picks ? view.picks.filter((p) => p.keep).length : null,
    scenes: view.scenes,
    direction: view.direction,
    picks: view.picks,
    videoCut: view.videoCut,
  };
  const values = {
    jobId,
    version,
    liked,
    kind: view.kind,
    directed,
    // A reel the rules made (AI off) says nothing about the prompt, even if an older direction is on the job.
    promptVersion: directed ? (view.direction?.prompt ?? null) : null,
    model: directed ? (view.direction?.model ?? null) : null,
    trackId: view.song?.id ?? null,
    reel,
    createdBy: userId,
  };
  await db
    .insert(reelFeedback)
    .values(values)
    .onConflictDoUpdate({
      target: [reelFeedback.jobId, reelFeedback.version],
      set: { liked, reel, updatedAt: sql`now()` },
    });
}
