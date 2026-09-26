import "server-only";

import { geminiJson } from "@/lib/gemini-pool";

import type { PhotoPick, Shot } from "./types";

/**
 * The one decision the reel pipeline hands to a model: which photos from a
 * shoot are worth keeping. Gemini sees small previews and labels each photo
 * (keep, shot type, which outfit, how good). Everything after — order, timing,
 * song, transitions — is plain code in plan.ts.
 */

const SHOTS: Shot[] = ["full_front", "full_back", "full_side", "half", "detail", "other"];

const SYSTEM = `You choose photos for short vertical Instagram reels for Paribelle, an Indian women's ethnic wear brand (kurtis, kurta sets, co-ord sets, suits with dupatta). The reel cuts from photo to photo on the beat of a song and ends on the brand's card, so every photo you keep must sell the outfit on its own.`;

function prompt(n: number, min: number, max: number) {
  return `Here are ${n} photos from one product photoshoot, numbered 0 to ${n - 1}.

Keep the photos that sell the outfit:
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
- reason: at most 6 words.`;
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
  },
  required: ["photos"],
};

/**
 * Ask Gemini which photos to keep. `thumbs` are JPEG previews in upload order.
 * Returns one pick per photo, in upload order, with at least three kept.
 */
export async function pickPhotos(
  thumbs: Buffer[],
  opts: { log?: (line: string) => void } = {},
): Promise<{ picks: PhotoPick[]; model: string }> {
  const n = thumbs.length;
  const min = Math.min(n, 5);
  const max = Math.min(n, 14);

  const parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] = [
    { text: prompt(n, min, max) },
  ];
  thumbs.forEach((t, i) => {
    parts.push({ text: `Photo ${i}` });
    parts.push({ inlineData: { mimeType: "image/jpeg", data: t.toString("base64") } });
  });

  const { data, model } = await geminiJson<{ photos?: Partial<PhotoPick>[] }>(
    {
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts }],
      generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.2 },
    },
    { log: opts.log },
  );

  // Normalise: one entry per photo, whatever the model skipped or repeated.
  const byIndex = new Map<number, Partial<PhotoPick>>();
  for (const p of data.photos ?? []) {
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
  return { picks, model };
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
