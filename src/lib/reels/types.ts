/**
 * Shapes shared by the reel routes and the Reels screen. Nothing server-side
 * is imported, so a client component can use them without pulling server code
 * into the bundle.
 */
import type { TransitionId } from "./transitions";

export type ReelKind = "photos" | "video";

/** Portrait (9:16) is what Reels, Stories and WhatsApp status show full screen; landscape is for YouTube and feeds. */
export type ReelLayout = "portrait" | "landscape";

export const FRAME_SIZE: Record<ReelLayout, { width: number; height: number }> = {
  portrait: { width: 1080, height: 1920 },
  landscape: { width: 1920, height: 1080 },
};

export type ReelStatus = "uploading" | "queued" | "selecting" | "analyzing" | "rendering" | "done" | "error";

export type Shot = "full_front" | "full_back" | "full_side" | "half" | "detail" | "other";

/** Gemini's verdict on one uploaded photo. `index` is the upload order. */
export interface PhotoPick {
  index: number;
  keep: boolean;
  shot: Shot;
  look: string;
  quality: number;
  reason: string;
}

/** One photo in a directed reel: which, for how long, and how it comes in. */
export interface ReelScene {
  photo: number;
  seconds: number;
  /** A `TransitionId` from transitions.ts. */
  transition: TransitionId;
}

/**
 * Gemini's direction for a photo reel, as it answered (checked and cleaned):
 * the song from the library, the total length of the photos, each scene, and
 * the transition into the end card. The code fits it onto the song's beats.
 */
export interface ReelDirection {
  song: number | null;
  /** Seconds of photos, before the end card. */
  total: number;
  scenes: ReelScene[];
  outro: TransitionId;
  /** A few words on the feel Gemini went for. */
  mood: string;
  /** The Gemini model that answered, and the prompt's `PROMPT_VERSION`: kept with feedback. */
  model?: string;
  prompt?: string;
}

export interface ReelSong {
  id: number;
  title: string;
  artist: string;
  bpm: number;
  /** Seconds into the full song where the reel's music starts: what to pick in Instagram's music. */
  cue: number;
}

/** What `GET /api/reels/[id]` answers: everything the screen shows, no bytes. */
export interface ReelJobView {
  id: number;
  kind: ReelKind;
  status: ReelStatus;
  /** 0..1 within the current status. */
  progress: number;
  error: string | null;
  /** Set when the failure was Gemini, so the screen can offer to go on without it. */
  aiFailed: boolean;
  picks: PhotoPick[] | null;
  /** Upload indices in the order they appear in the reel. */
  order: number[] | null;
  /** The finished reel's scenes, as rendered: seconds on the beat, and each transition. */
  scenes: ReelScene[] | null;
  /** Gemini directed the finished reel (else the rules did). */
  directed: boolean;
  /** Gemini's direction as it answered, before it was fitted to the beat. */
  direction: ReelDirection | null;
  song: ReelSong | null;
  duration: number | null;
  /** The shape of the finished reel. */
  layout: ReelLayout | null;
  /** A supplier video: where their footage was cut, and whether that was their end card. */
  videoCut: { at: number; endCard: boolean } | null;
  /** Bumped on every finished render; part of the video URL so nothing stale is shown. */
  version: number;
  /** The songs this reel can still use: each song makes one reel, then leaves the library. */
  library: { id: number; title: string; artist: string }[];
  /** "Do you like this reel?" for the finished render (`version`): true, false, or not answered. */
  feedback: boolean | null;
}

/** Photos are resized in the browser before upload, to fit under Vercel's 4.5 MB body limit. */
export const PHOTO_LONG_EDGE = 2400;
export const THUMB_LONG_EDGE = 512;
export const MAX_PHOTOS = 60;
export const VIDEO_CHUNK_BYTES = 3.5 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 120 * 1024 * 1024;
/** A slice of the finished MP4 per response, under the same limit. */
export const VIDEO_SLICE_BYTES = 3 * 1024 * 1024;
