import { isDownbeat, type TrackAnalysis } from "./beats";
import type { TransitionId } from "./transitions";
import type { PhotoPick, ReelDirection, ReelScene, Shot } from "./types";

/**
 * Everything between "these photos, this song" and a frame-exact timeline.
 * No randomness: the same inputs give the same reel.
 *
 * A photo reel is planned one of two ways. With AI on, Gemini directs it
 * (select.ts): the order, how long each photo holds, the song and the
 * transitions; this file only fits that onto the song's beats. Without AI,
 * every choice is a rule below that can be read and changed.
 *
 * Time 0 of a reel is `segStart` seconds into the song's stored stretch, and
 * that is always a beat, so every cut can sit exactly on one.
 */

export interface PlannedShot {
  photo: number;
  start: number;
  end: number;
  /** How this photo comes in, centred on its first beat (for the first photo: out of the transition). */
  transition: TransitionId;
}

export interface PhotoPlan {
  kind: "photos";
  trackId: number;
  segStart: number;
  total: number;
  /** Gemini's direction was followed (else the rules were). */
  directed: boolean;
  shots: PlannedShot[];
  outro: { start: number; end: number; transition: TransitionId };
}

export interface VideoPlan {
  kind: "video";
  trackId: number;
  segStart: number;
  /** Where the supplier's footage is cut: on a beat, at or just before their end card. */
  contentEnd: number;
  total: number;
  /** Share of the footage's own cuts that land on a beat of the song. */
  aligned: number;
}

export interface PlanTrack {
  id: number;
  bpm: number;
  analysis: TrackAnalysis;
  useCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
const round3 = (x: number) => Math.round(x * 1000) / 1000;
const clampTo = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** The time of beat `i`, extrapolated past the end of the stretch at the song's tempo. */
function beatAt(a: TrackAnalysis, i: number): number {
  const n = a.beats.length;
  if (i < n) return a.beats[i];
  return a.beats[n - 1] + (i - (n - 1)) * (60 / a.bpm);
}

/**
 * Beats the end card holds for: about 3.6 s, long enough to read the handle
 * and the platforms, never less than one bar. It starts on a bar line; where
 * it ends does not matter, because the video (and the song, faded) ends there.
 */
function outroBeats(bpm: number): number {
  const P = 60 / bpm;
  return Math.max(4, Math.min(8, Math.round(3.6 / P)));
}

/* -------------------------------------------------------------------------- */
/* Shot order                                                                 */
/* -------------------------------------------------------------------------- */

const WIDE_RANK: Record<Shot, number> = { full_front: 0, full_side: 1, half: 2, full_back: 3, other: 4, detail: 5 };

/**
 * The order the kept photos play in. One outfit at a time, best outfit first;
 * within an outfit it opens on its best full-length shot and then alternates
 * wide and close-up, so the eye gets the whole look, then a detail, then the
 * look again. It ends on a wide shot where it can, going into the end card.
 */
export function orderShots(picks: PhotoPick[]): number[] {
  const kept = picks.filter((p) => p.keep);
  // No labels (Gemini was skipped): keep the order the photos were shot in.
  if (kept.every((p) => p.shot === "other" && p.look === "look")) return kept.map((p) => p.index);

  const looks = new Map<string, PhotoPick[]>();
  for (const p of kept) looks.set(p.look, [...(looks.get(p.look) ?? []), p]);
  const lookOrder = [...looks.entries()].sort(
    (x, y) => Math.max(...y[1].map((p) => p.quality)) - Math.max(...x[1].map((p) => p.quality)) || x[1][0].index - y[1][0].index,
  );

  const byWide = (x: PhotoPick, y: PhotoPick) => y.quality - x.quality || WIDE_RANK[x.shot] - WIDE_RANK[y.shot] || x.index - y.index;
  const byQuality = (x: PhotoPick, y: PhotoPick) => y.quality - x.quality || x.index - y.index;

  const out: PhotoPick[] = [];
  for (const [, group] of lookOrder) {
    const wides = group.filter((p) => p.shot !== "detail").sort(byWide);
    const details = group.filter((p) => p.shot === "detail").sort(byQuality);
    // Open the outfit on its best front view when it has one.
    const front = wides.findIndex((p) => p.shot === "full_front");
    if (front > 0) wides.unshift(...wides.splice(front, 1));
    while (wides.length || details.length) {
      if (wides.length) out.push(wides.shift()!);
      if (details.length) out.push(details.shift()!);
    }
  }

  // Into the end card on a wide shot.
  if (out.length > 2 && out[out.length - 1].shot === "detail") {
    const lastLook = out[out.length - 1].look;
    for (let i = out.length - 2; i > 0; i--) {
      if (out[i].shot !== "detail" && out[i].look === lastLook) {
        out.push(...out.splice(i, 1));
        break;
      }
    }
  }
  return out.map((p) => p.index);
}

/* -------------------------------------------------------------------------- */
/* Song choice                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Which song to use. Songs not used lately and songs added recently (trends
 * fade) come first; a tempo people can pose to wins ties. A song this job has
 * already been rendered with is skipped until every song has had a turn.
 */
export function chooseTrack<T extends PlanTrack>(
  tracks: T[],
  opts: { tried: number[]; now: Date; fits: (t: T) => boolean; requested?: number | null },
): T | null {
  if (opts.requested != null) {
    const t = tracks.find((x) => x.id === opts.requested);
    return t && opts.fits(t) ? t : null;
  }
  const day = 86_400_000;
  const score = (t: T) => {
    const idle = t.lastUsedAt ? Math.min(1, (opts.now.getTime() - t.lastUsedAt.getTime()) / (10 * day)) : 1;
    const fresh = Math.exp(-(opts.now.getTime() - t.createdAt.getTime()) / (60 * day));
    const tempo = t.bpm >= 85 && t.bpm <= 135 ? 1 : t.bpm >= 70 && t.bpm <= 150 ? 0.7 : 0.4;
    return (0.45 * idle + 0.35 * fresh + 0.2 * tempo) / (1 + 0.1 * t.useCount);
  };
  const fitting = tracks.filter(opts.fits);
  const fresh = fitting.filter((t) => !opts.tried.includes(t.id));
  const pool = fresh.length ? fresh : fitting.filter((t) => t.id !== opts.tried[opts.tried.length - 1]);
  const list = pool.length ? pool : fitting;
  return list.sort((x, y) => score(y) - score(x) || x.id - y.id)[0] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Photo reel                                                                 */
/* -------------------------------------------------------------------------- */

/** At most this many seconds of photos: past that a reel loses people. */
const MAX_CONTENT = 21;
/** A directed reel may run a little longer, when Gemini asks for it. */
const MAX_DIRECTED = 24;

/**
 * Beats per photo: the whole number of beats closest to ~1.25 s, which reads
 * as a confident pace for outfit shots. Even counts are preferred because they
 * keep cuts on the strong beats.
 */
function beatsPerShot(P: number): number {
  const cost = (b: number) => Math.abs(b * P - 1.25) + (b === 3 ? 0.25 : 0) + (b === 1 ? 0.15 : 0);
  return [1, 2, 3, 4].reduce((best, b) => (cost(b) < cost(best) ? b : best), 2);
}

/** Where in the song to start: loud, at a phrase, ideally where it lifts or on the hook. */
function scoreStart(a: TrackAnalysis, i: number, span: number, content: number): number {
  const e = a.energy;
  const seg = e.slice(i, i + span);
  const body = e.slice(i, i + Math.max(4, content - 2));
  const before = i >= 8 ? mean(e.slice(i - 8, i)) : mean(e.slice(0, i)) || seg[0];
  const rise = Math.max(0, mean(e.slice(i, i + 8)) - before);
  const hook = a.hook != null ? Math.exp(-Math.abs(a.beats[i] - a.hook) / 4) : 0;
  return (
    0.45 * mean(seg) +
    0.15 * (a.phrases.includes(i) ? 1 : 0) +
    0.15 * (a.lifts.includes(i) ? 1 : 0) +
    0.25 * Math.min(1, rise * 2) +
    0.35 * hook -
    (Math.min(...body) < 0.12 ? 0.3 : 0)
  );
}

/** The end card starts a bar: spread the missing beats over the last shots. */
function padToBar(lengths: number[]): number[] {
  const out = [...lengths];
  let pad = (4 - (out.reduce((s, v) => s + v, 0) % 4)) % 4;
  for (let k = out.length - 1; pad > 0; k = k > 0 ? k - 1 : out.length - 1, pad--) out[k] += 1;
  return out;
}

/**
 * Lay photos of the given lengths (in beats) on the song, starting at its
 * best downbeat. `transition` picks each photo's way in once its beat is
 * known. Null when the song's stored stretch is too short.
 */
function layOnSong(
  track: PlanTrack,
  photos: number[],
  lengths: number[],
  transition: (k: number, startBeat: number) => TransitionId,
  outroTransition: TransitionId,
  directed: boolean,
): PhotoPlan | null {
  const a = track.analysis;
  const content = lengths.reduce((s, v) => s + v, 0);
  const outro = outroBeats(a.bpm);
  const span = content + outro;

  // Every downbeat that leaves room for the whole reel (the end card may run
  // a beat or two past the stretch; its time is extrapolated).
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i + content + 1 < a.beats.length && i + span <= a.beats.length + 1; i++) {
    if (!isDownbeat(a, i)) continue;
    const s = scoreStart(a, i, span, content);
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  if (best < 0) return null;

  const s0 = a.beats[best];
  const shots: PlannedShot[] = [];
  let j = best;
  for (const [k, photo] of photos.entries()) {
    const startBeat = j;
    j += lengths[k];
    shots.push({
      photo,
      start: round3(beatAt(a, startBeat) - s0),
      end: round3(beatAt(a, j) - s0),
      transition: transition(k, startBeat),
    });
  }
  const outroStart = beatAt(a, j) - s0;
  const outroEnd = beatAt(a, j + outro) - s0;
  return {
    kind: "photos",
    trackId: track.id,
    segStart: round3(s0),
    total: round3(outroEnd),
    directed,
    shots,
    outro: { start: round3(outroStart), end: round3(outroEnd), transition: outroTransition },
  };
}

/**
 * The rules' transitions, when Gemini is not directing. Mostly clean cuts on
 * the beat; the music and the photos earn the rest:
 *
 *  - the reel fades up out of black;
 *  - where the music lifts (a drop, a chorus), a light leak, then a glow the next time;
 *  - a new outfit gets a dip to black when the music is quiet, a silk wipe when it is not;
 *  - into a close-up, a focus pull (three at most);
 *  - a hard downbeat, now and then, a chroma split;
 *  - quiet music, a dissolve;
 *  - and never the same one twice running, but for cuts.
 */
function ruleTransitions(a: TrackAnalysis, photos: number[], picks: PhotoPick[]) {
  const pickOf = new Map(picks.map((p) => [p.index, p]));
  let accentAt = -Infinity;
  let accents = 0;
  let chromaAt = -Infinity;
  let chromas = 0;
  let focuses = 0;
  let last: TransitionId = "cut";
  const choose = (k: number, startBeat: number): TransitionId => {
    if (k === 0) return "dip_black";
    const here = pickOf.get(photos[k]);
    const prev = pickOf.get(photos[k - 1]);
    const energy = mean(a.energy.slice(Math.max(0, startBeat - 2), startBeat + 2));
    const strength = a.strength[startBeat] ?? 0;
    const lifts = a.lifts.includes(startBeat) || (a.phrases.includes(startBeat) && strength >= 0.6);
    if (lifts && startBeat - accentAt >= 16) {
      accentAt = startBeat;
      return accents++ % 2 === 0 ? "light_leak" : "glow";
    }
    if (here && prev && here.look !== prev.look) return energy < 0.45 ? "dip_black" : "silk_wipe";
    if (here?.shot === "detail" && prev && prev.shot !== "detail" && focuses < 3) {
      focuses++;
      return "focus";
    }
    if (energy < 0.35) return "dissolve";
    if (isDownbeat(a, startBeat) && strength >= 0.7 && chromas < 2 && startBeat - chromaAt >= 8) {
      chromaAt = startBeat;
      chromas++;
      return "chroma";
    }
    return "cut";
  };
  return (k: number, startBeat: number): TransitionId => {
    const t = choose(k, startBeat);
    last = t !== "cut" && t === last ? "cut" : t;
    return last;
  };
}

/**
 * The rules' reel: photos (already in playing order) on the song, a steady
 * number of beats each. Null when the song's stored stretch is too short.
 */
export function planPhotoReel(order: number[], picks: PhotoPick[], track: PlanTrack): PhotoPlan | null {
  const a = track.analysis;
  const P = 60 / a.bpm;
  const quality = new Map(picks.map((p) => [p.index, p.quality]));

  let b = beatsPerShot(P);
  const photos = [...order];
  if (photos.length === 0) return null;
  const heroLen = () => (b * P < 1.6 ? 2 * b : b);
  const contentBeats = () => heroLen() + (photos.length - 1) * b;

  // Too long: drop the weakest photos (never the first).
  while (contentBeats() * P > MAX_CONTENT && photos.length > 4) {
    let worst = photos.length - 1;
    for (let k = photos.length - 1; k >= 1; k--) {
      if ((quality.get(photos[k]) ?? 5) < (quality.get(photos[worst]) ?? 5)) worst = k;
    }
    photos.splice(worst, 1);
  }
  // At least ~7 s: with only a few photos, hold each one longer.
  while (contentBeats() * P < 7 && b < 4) b *= 2;

  const lengths = padToBar([heroLen(), ...Array.from({ length: photos.length - 1 }, () => b)]);
  return layOnSong(track, photos, lengths, ruleTransitions(a, photos, picks), "dissolve", false);
}

/**
 * Gemini's direction on the song: each scene held for the whole number of
 * beats nearest the seconds it asked for (at least one), scaled so the photos
 * add up to its total, with its transitions. Null when the song is too short.
 */
export function planDirectedReel(direction: ReelDirection, track: PlanTrack): PhotoPlan | null {
  const scenes = direction.scenes;
  if (scenes.length === 0) return null;
  const P = 60 / track.analysis.bpm;
  const asked = scenes.reduce((s, x) => s + x.seconds, 0);
  // Its total and its scenes should agree; when they don't, the total wins, within reason.
  const scale = direction.total > 0 && asked > 0 ? Math.max(0.67, Math.min(1.5, direction.total / asked)) : 1;
  const lengths = scenes.map((s) => Math.max(1, Math.round((s.seconds * scale) / P)));
  // Never past the ceiling: shorten the longest scenes a beat at a time.
  while (lengths.reduce((s, v) => s + v, 0) * P > MAX_DIRECTED) {
    const k = lengths.indexOf(Math.max(...lengths));
    if (lengths[k] <= 1) break;
    lengths[k]--;
  }
  return layOnSong(
    track,
    scenes.map((s) => s.photo),
    padToBar(lengths),
    (k) => scenes[k].transition,
    direction.outro,
    true,
  );
}

/**
 * Make a direction's scenes match the kept photos: scenes of photos no longer
 * kept go (the person took them out), and a kept photo with no scene goes in
 * after the last scene of its outfit (the person put it in), held as long as
 * its kind of shot usually is. The total moves with the scenes. No transition
 * but cut plays twice in a row.
 */
export function reconcile(direction: ReelDirection, picks: PhotoPick[]): ReelDirection {
  const byIndex = new Map(picks.map((p) => [p.index, p]));
  const before = direction.scenes.reduce((s, x) => s + x.seconds, 0);
  const scenes = direction.scenes.filter((s) => byIndex.get(s.photo)?.keep).map((s) => ({ ...s }));
  const seen = new Set(scenes.map((s) => s.photo));
  for (const p of picks) {
    if (!p.keep || seen.has(p.index)) continue;
    let at = -1;
    scenes.forEach((s, k) => {
      if (byIndex.get(s.photo)?.look === p.look) at = k;
    });
    const scene: ReelScene = { photo: p.index, seconds: p.shot === "detail" ? 0.8 : 1.2, transition: "cut" };
    if (at < 0) scenes.push(scene);
    else scenes.splice(at + 1, 0, scene);
    seen.add(p.index);
  }
  for (let k = 1; k < scenes.length; k++) {
    if (scenes[k].transition !== "cut" && scenes[k].transition === scenes[k - 1].transition) scenes[k].transition = "cut";
  }
  const after = scenes.reduce((s, x) => s + x.seconds, 0);
  const total = before > 0 ? Math.round(clampTo((direction.total * after) / before, 4, 24) * 100) / 100 : direction.total;
  return { ...direction, scenes, total };
}

/** Enough song for this reel at all? Used to skip songs before planning in earnest. */
export const photoReelFits = (order: number[], picks: PhotoPick[], track: PlanTrack, direction?: ReelDirection | null) =>
  (direction ? planDirectedReel(direction, track) : planPhotoReel(order, picks, track)) !== null;

/* -------------------------------------------------------------------------- */
/* Supplier video                                                             */
/* -------------------------------------------------------------------------- */

/** Index of the beat nearest to `t`. */
function nearestBeat(beats: number[], t: number): number {
  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && Math.abs(beats[lo - 1] - t) < Math.abs(beats[lo] - t) ? lo - 1 : lo;
}

/**
 * Put a song under footage that already has its own cuts. The footage cannot
 * move, so the song does: every start beat is tried, and the one that puts
 * the most of the footage's cuts on a beat wins, with loudness and the hook as
 * tie-breakers. The footage is then trimmed back to a beat (a bar line when
 * one is close) so the end card arrives on it.
 */
export function planVideoReel(input: { contentEnd: number; cuts: number[] }, track: PlanTrack): VideoPlan | null {
  const a = track.analysis;
  const E = input.contentEnd;
  const outro = outroBeats(a.bpm);
  const beats = a.beats;
  const last = beats[beats.length - 1];

  let best: VideoPlan | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < beats.length; i++) {
    const s0 = beats[i];
    if (s0 + E > last + 60 / a.bpm) break;

    let jEnd = -1;
    let jDown = -1;
    for (let j = i; j < beats.length && beats[j] - s0 <= E + 1e-6; j++) {
      jEnd = j;
      if (isDownbeat(a, j)) jDown = j;
    }
    if (jEnd <= i) continue;
    const onBar = jDown > i && E - (beats[jDown] - s0) <= 1.3;
    const j = onBar ? jDown : jEnd;
    if (j + outro > beats.length + 1) continue;
    const endT = beats[j] - s0;

    const inside = input.cuts.filter((c) => c > 0.2 && c < endT - 0.1);
    let hits = 0;
    for (const c of inside) {
      const d = Math.abs(beats[nearestBeat(beats, s0 + c)] - (s0 + c));
      hits += Math.max(0, 1 - d / 0.09);
    }
    const aligned = inside.length ? hits / inside.length : 0;
    const e = a.energy.slice(i, Math.min(beats.length, j + outro));
    const hook = a.hook != null ? Math.exp(-Math.abs(s0 - a.hook) / 5) : 0;
    const score =
      0.5 * aligned +
      0.3 * mean(e) +
      0.15 * (onBar ? 1 : 0) +
      0.3 * hook -
      0.2 * ((E - endT) / Math.max(1, E)) -
      (Math.min(...e.slice(0, Math.max(1, e.length - 3))) < 0.12 ? 0.2 : 0);

    if (score > bestScore) {
      bestScore = score;
      best = {
        kind: "video",
        trackId: track.id,
        segStart: round3(s0),
        contentEnd: round3(endT),
        total: round3(beatAt(a, j + outro) - s0),
        aligned: Math.round(aligned * 100) / 100,
      };
    }
  }
  return best;
}

export const videoReelFits = (input: { contentEnd: number; cuts: number[] }, track: PlanTrack) =>
  planVideoReel(input, track) !== null;
