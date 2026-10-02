import "server-only";

import { subjectMask } from "../media/cutout";
import { compareColours, palette, type ColourMatch } from "./colour";
import { alphaMask, blank, coverage, crop, hasAlpha, over, preview, resize, toCanvas, type Mask, type Raster } from "./raster";
import { select } from "./select";

/**
 * Checking a shoot's result against the real garment: a compare sheet (our photo and the
 * result side by side at the same height, then zoomed pairs of the details that matter)
 * for Seelie to judge by eye, and the garment's colours measured in each (ΔE00).
 */

export interface FracBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Progress = (text: string) => void;

const pxBox = (r: Raster, b: FracBox) => ({ x: b.x * r.w, y: b.y * r.h, w: b.w * r.w, h: b.h * r.h });

/**
 * The garment in a picture: inside a box Seelie gives (SlimSAM), else the subject
 * (a cut-out's own transparency, or BiRefNet: with a person in it, skin and hair count too).
 */
export async function garmentMask(r: Raster, box: FracBox | undefined, opts: { progress: Progress; signal: AbortSignal }): Promise<Mask> {
  if (box) return (await select(r, { box: pxBox(r, box) }, opts)).mask;
  if (hasAlpha(r)) {
    const a = alphaMask(r);
    if (coverage(a) < 0.98) return a;
  }
  return { w: r.w, h: r.h, a: await subjectMask(await toCanvas(r), r.w, r.h, opts) };
}

export interface ColourCheck {
  matches: ColourMatch[];
  /** The main colour's ΔE00 (the base fabric), null when nothing could be compared. */
  main: number | null;
  /** Share-weighted over the original's colours. */
  weighted: number | null;
  note: string;
}

export function colourCheck(original: Raster, originalMask: Mask, result: Raster, resultMask: Mask): ColourCheck {
  const matches = compareColours(palette(original, originalMask), palette(result, resultMask));
  if (!matches.length) return { matches, main: null, weighted: null, note: "no colours to compare" };
  const share = matches.reduce((s, m) => s + m.original.share, 0) || 1;
  const weighted = Math.round((matches.reduce((s, m) => s + (m.deltaE ?? 0) * m.original.share, 0) / share) * 10) / 10;
  const main = matches[0];
  return {
    matches,
    main: main.deltaE,
    weighted,
    note: [
      `main colour ${main.original.hex} (${Math.round(main.original.share * 100)}%) ΔE00 ${main.deltaE ?? "?"} (${main.verdict})`,
      `share-weighted ΔE00 ${weighted}`,
      `each: ${matches.map((m) => `${m.original.hex} ${Math.round(m.original.share * 100)}% -> ${m.result?.hex ?? "none"} ΔE ${m.deltaE ?? "?"}`).join(", ")}`,
    ].join("; "),
  };
}

export interface DetailPair {
  name: string;
  original: Raster;
  result: Raster;
}

/** Pairs of crops: the same detail in our photo and in the result. */
export function detailCrop(r: Raster, b: FracBox): Raster {
  const p = pxBox(r, b);
  return crop(r, p.x, p.y, Math.max(8, p.w), Math.max(8, p.h));
}

const TOP = 1100;
const ROW = 520;
const GAP = 16;
const BG: [number, number, number, number] = [236, 236, 236, 255];

async function toHeight(r: Raster, h: number): Promise<Raster> {
  const w = Math.max(1, Math.round((r.w / r.h) * h));
  return resize(r, w, h);
}

/**
 * The compare sheet as a JPEG (long edge `edge`): row 1 is our photo (left) and the
 * result (right) at the same height; each row after it is one detail pair, ours left.
 */
export async function compareSheet(original: Raster, result: Raster, details: DetailPair[], edge = 1536): Promise<Buffer> {
  const rows: Raster[][] = [[await toHeight(original, TOP), await toHeight(result, TOP)]];
  for (const d of details) rows.push([await toHeight(d.original, ROW), await toHeight(d.result, ROW)]);
  const widths = rows.map((row) => row.reduce((s, r) => s + r.w, 0) + GAP * (row.length + 1));
  const w = Math.max(...widths);
  const h = rows.reduce((s, row) => s + row[0].h, 0) + GAP * (rows.length + 1);
  let sheet = blank(w, h, BG);
  let y = GAP;
  for (const [i, row] of rows.entries()) {
    let x = Math.round((w - widths[i]) / 2) + GAP;
    for (const r of row) {
      sheet = over(sheet, r, x, y);
      x += r.w + GAP;
    }
    y += row[0].h + GAP;
  }
  return preview(sheet, edge, 88);
}
