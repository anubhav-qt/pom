import "server-only";

import { geminiJson } from "@/lib/gemini-pool";

import { reconcile } from "./plan";
import { TRANSITIONS, TRANSITION_IDS, isTransition, type TransitionId } from "./transitions";
import type { PhotoPick, ReelDirection, ReelScene, Shot } from "./types";

/**
 * What the reel pipeline hands to a model: directing a photo reel. Gemini sees
 * small previews of the shoot, the songs still in the library and the list of
 * transitions, and answers in JSON: which photos to keep (with a label each),
 * the scenes in order with how long each holds and how it comes in, the song,
 * and the total length. plan.ts then fits that onto the song's beats and
 * render-photos.ts draws it.
 */

const SHOTS: Shot[] = ["full_front", "full_back", "full_side", "half", "detail", "other"];

const SYSTEM = `You are the editor of short vertical Instagram reels for Paribelle, an Indian women's ethnic wear brand (kurtis, kurta sets, co-ord sets, suits with dupatta). A reel shows one product shoot, photo after photo, cut to a song, and ends on the brand's card. The look is classy and premium, like a fashion label's edit, never amateur: the photos stand still in the frame (nothing zooms or pans) and the transitions are chosen with restraint.`;

/** A song Gemini may choose. */
export interface SongChoice {
  id: number;
  title: string;
  artist: string;
  language: string;
  bpm: number;
  tags: string[];
}

function prompt(n: number, min: number, max: number, songs: SongChoice[], fixedSong: number | null) {
  const songLines = songs
    .map((s) => `- ${s.id}: "${s.title}" by ${s.artist} (${s.language}, ${Math.round(s.bpm)} BPM${s.tags.length ? `, ${s.tags.join(", ")}` : ""})`)
    .join("\n");
  const transitionLines = TRANSITIONS.map((t) => `- ${t.id}: ${t.about}`).join("\n");
  return `Here are ${n} photos from one product photoshoot, numbered 0 to ${n - 1}.

1. Choose the photos. Keep the ones that sell the outfit:
- sharp, well lit, the outfit clearly visible and not awkwardly cut off;
- one of each distinct pose or angle; from a burst of near-identical shots keep only the best one;
- close-ups that show the print, embroidery, fabric, neckline, sleeves or dupatta.
Drop: blurry or dark shots, closed eyes or mid-blink, awkward expressions or poses, near-duplicates of a photo you keep, shots where the outfit is mostly hidden, anything with another brand's logo, a watermark, a price or text overlay, and screenshots.
Keep between ${min} and ${max} photos. Prefer variety: full-length front, back or side, and a few close-ups.

For every photo return:
- index: its number;
- keep: true or false;
- shot: full_front, full_back, full_side, half (waist up), detail (close-up of the garment) or other;
- look: 1 to 3 words naming the outfit by colour or print, identical for every photo of the same outfit (for example "navy print", "red print");
- quality: 1 to 10, how well the photo sells the outfit;
- reason: at most 6 words.

2. Direct the reel from the photos you keep.
- scenes: every kept photo exactly once, in the order they play. One outfit at a time, its best full-length front view first, then alternate wide shots and close-ups so the eye gets the whole look, then a detail, then the look again. Open on the strongest photo of all and end on a wide shot.
- seconds: how long each scene holds, 0.5 to 3. The opening scene holds longest (1.5 to 2.5); wide shots about 1 to 1.6; close-ups shorter (0.6 to 1). Keep the pace lively but let each outfit breathe.
- total_seconds: the sum of the scenes' seconds, between 8 and 20. The brand's end card is added after it.
- song: ${
    fixedSong != null
      ? `use song ${fixedSong}; it has been chosen already.`
      : `the id of the song below that best suits these outfits and this pace: festive, bridal and bright looks suit energetic songs; pastels, cottons and everyday looks suit softer, slower ones.`
  }
${songLines}
- transition: how each scene comes in, from this list (the photo never moves; the transition happens on the picture itself, exactly on the beat):
${transitionLines}
  Taste rules: cut is the backbone, use it for about half the scenes or more. Save light_leak, glow, dip_black and dip_ivory for moments (a new outfit, the opening, the last look): three at most in a reel. Never use the same transition other than cut twice in a row. grain at most once, and only if the looks suit a textured, analogue feel. focus suits going into or out of a close-up. The first scene's transition is how the reel opens: dip_black, glow, light_leak or dissolve.
- outro_transition: into the brand's end card: dissolve, dip_ivory, dip_black or glow.
- mood: 2 to 5 words on the feel of the edit.`;
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    photos: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          index: { type: "INTEGER" },
          keep: { type: "BOOLEAN" },
          shot: { type: "STRING", enum: SHOTS },
          look: { type: "STRING" },
          quality: { type: "INTEGER" },
          reason: { type: "STRING" },
        },
        required: ["index", "keep", "shot", "look", "quality", "reason"],
      },
    },
    reel: {
      type: "OBJECT",
      properties: {
        song: { type: "INTEGER" },
        mood: { type: "STRING" },
        total_seconds: { type: "NUMBER" },
        scenes: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              photo: { type: "INTEGER" },
              seconds: { type: "NUMBER" },
              transition: { type: "STRING", enum: TRANSITION_IDS },
            },
            required: ["photo", "seconds", "transition"],
          },
        },
        outro_transition: { type: "STRING", enum: TRANSITION_IDS },
      },
      required: ["song", "mood", "total_seconds", "scenes", "outro_transition"],
    },
  },
  required: ["photos", "reel"],
};

type Answer = {
  photos?: Partial<PhotoPick>[];
  reel?: {
    song?: number;
    mood?: string;
    total_seconds?: number;
    scenes?: { photo?: number; seconds?: number; transition?: string }[];
    outro_transition?: string;
  };
};

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/**
 * Ask Gemini to choose the photos and direct the reel. `thumbs` are JPEG
 * previews in upload order; indices in the answer are positions in `thumbs`.
 * `fixedSong` is a song the person picked. Returns one pick per photo, and a
 * direction whose scenes are exactly the kept photos, or null when the answer
 * had no usable scenes (the rules then lay out the kept photos).
 */
export async function directReel(
  thumbs: Buffer[],
  opts: { songs: SongChoice[]; fixedSong?: number | null; log?: (line: string) => void },
): Promise<{ picks: PhotoPick[]; direction: ReelDirection | null; model: string }> {
  const n = thumbs.length;
  const min = Math.min(n, 5);
  const max = Math.min(n, 14);
  const fixedSong = opts.fixedSong ?? null;

  const parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] = [
    { text: prompt(n, min, max, opts.songs, fixedSong) },
  ];
  thumbs.forEach((t, i) => {
    parts.push({ text: `Photo ${i}` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: t.toString("base64") } });
  });

  const { data, model } = await geminiJson<Answer>(
    {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.35 },
    },
    { log: opts.log },
  );

  const picks = normalisePicks(data.photos ?? [], n);
  const direction = normaliseDirection(data.reel, picks, opts.songs, fixedSong);
  return { picks, direction, model };
}

/** One entry per photo, whatever the model skipped or repeated, with at least three kept. */
function normalisePicks(raw: Partial<PhotoPick>[], n: number): PhotoPick[] {
  const byIndex = new Map<number, Partial<PhotoPick>>();
  for (const p of raw) {
    if (typeof p.index === "number" && p.index >= 0 && p.index < n && !byIndex.has(p.index)) byIndex.set(p.index, p);
  }
  const picks: PhotoPick[] = Array.from({ length: n }, (_, i) => {
    const p = byIndex.get(i) ?? {};
    return {
      index: i,
      keep: p.keep === true,
      shot: SHOTS.includes(p.shot as Shot) ? (p.shot as Shot) : "other",
      look: (p.look ?? "").toString().trim().toLowerCase().slice(0, 40) || "look",
      quality: Math.max(1, Math.min(10, Math.round(Number(p.quality) || 5))),
      reason: (p.reason ?? "").toString().trim().slice(0, 60),
    };
  });

  // A reel needs a few photos; top up from the best of the rest if it kept too few.
  const floor = Math.min(n, 3);
  const kept = picks.filter((p) => p.keep).length;
  if (kept < floor) {
    picks
      .filter((p) => !p.keep)
      .sort((a, b) => b.quality - a.quality)
      .slice(0, floor - kept)
      .forEach((p) => (p.keep = true));
  }
  return picks;
}

/**
 * The direction, checked: scenes on real photos, each once; seconds and total
 * in range; transitions from the list, and not the same one twice running
 * (cut aside); the song one that was offered. The scenes and the kept photos
 * are made to agree: a scene's photo is kept, and a kept photo the scenes left
 * out goes in after the last scene of its outfit. `picks` is updated in place.
 */
function normaliseDirection(
  raw: Answer["reel"],
  picks: PhotoPick[],
  songs: SongChoice[],
  fixedSong: number | null,
): ReelDirection | null {
  if (!raw || !Array.isArray(raw.scenes)) return null;
  const n = picks.length;
  const seen = new Set<number>();
  const scenes: ReelScene[] = [];
  for (const s of raw.scenes) {
    const photo = Number(s.photo);
    if (!Number.isInteger(photo) || photo < 0 || photo >= n || seen.has(photo)) continue;
    seen.add(photo);
    const seconds = Number(s.seconds);
    scenes.push({
      photo,
      seconds: Math.round(clamp(Number.isFinite(seconds) ? seconds : 1.2, 0.4, 4) * 100) / 100,
      transition: isTransition(s.transition) ? s.transition : "cut",
    });
  }
  if (scenes.length === 0) return null;
  // A photo in a scene is in the reel.
  for (const s of scenes) picks[s.photo].keep = true;

  const sum = scenes.reduce((s, x) => s + x.seconds, 0);
  const total = Number(raw.total_seconds);
  const song = fixedSong ?? (songs.some((s) => s.id === Number(raw.song)) ? Number(raw.song) : null);
  const outro: TransitionId = isTransition(raw.outro_transition) ? raw.outro_transition : "dissolve";
  return reconcile(
    {
      song,
      total: Math.round(clamp(Number.isFinite(total) && total > 0 ? total : sum, 4, 24) * 100) / 100,
      scenes,
      outro,
      mood: (raw.mood ?? "").toString().trim().slice(0, 60),
    },
    picks,
  );
}

/** Picks that came from `keepAll`, not from Gemini. */
export const isKeepAll = (picks: PhotoPick[]) =>
  picks.every((p) => p.keep && p.shot === "other" && p.look === "look" && p.reason === "");

/** Without Gemini: keep every photo, in upload order. */
export function keepAll(n: number): PhotoPick[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i,
    keep: true,
    shot: "other" as Shot,
    look: "look",
    quality: 5,
    reason: "",
  }));
}
