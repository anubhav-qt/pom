import "server-only";

import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { fetchPublic } from "../tools/images";

import { mediaFolder, MediaError, SAFE_NAME } from "./files";

/**
 * Seelie's fonts: Google fonts as static TTFs per weight in the media folder's fonts/
 * (Family-400.ttf, Family-700-italic.ttf, Family-400-devanagari.ttf), from Fontsource
 * (every Google font is OFL or Apache). families.json there keeps each file stem's real
 * family name ("CormorantGaramond" → "Cormorant Garamond") for compositions' @font-face.
 */

const INDEX = "families.json";

/** paribelle.in's own fonts (marketplace-web's layout): headlines, text, the logo. */
export const BRAND_FONTS = [
  { family: "Cormorant Garamond", weights: [300, 400, 500, 600, 700], italic: [400, 500] },
  { family: "Jost", weights: [300, 400, 500, 600], italic: [] },
  { family: "Italiana", weights: [400], italic: [] },
] as const;

const stem = (family: string) => family.replace(/[^A-Za-z0-9]+/g, "");

async function readIndex(dir: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(path.join(dir, INDEX), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Download a Google font by family; the files written, as $font/<file>. */
export async function addGoogleFont(family: string, weights: number[] | undefined, subset: string | undefined, italic: boolean, signal: AbortSignal) {
  const id = family.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!id) throw new MediaError("Which font family?");
  const meta = await fetchPublic(`https://api.fontsource.org/v1/fonts/${id}`, signal, { maxBytes: 2_000_000 }).catch(() => {
    throw new MediaError(`There's no Google font "${family}" (fonts.google.com lists them).`);
  });
  const info = JSON.parse(meta.bytes.toString("utf8")) as { family: string; subsets: string[]; weights: number[]; styles: string[]; license: string; type: string };
  if (info.type !== "google") throw new MediaError(`${info.family} isn't a Google font.`);
  const sub = subset ?? "latin";
  if (!info.subsets.includes(sub)) throw new MediaError(`${info.family} has no ${sub} characters; it has ${info.subsets.join(", ")}.`);
  if (italic && !info.styles.includes("italic")) throw new MediaError(`${info.family} has no italic.`);
  const want = (weights?.length ? weights : [400, 700]).filter((w) => info.weights.includes(w));
  if (!want.length) throw new MediaError(`${info.family} comes in weights ${info.weights.join(", ")}.`);

  const dir = await mediaFolder("fonts");
  const saved: string[] = [];
  for (const w of want.slice(0, 6)) {
    const style = italic ? "italic" : "normal";
    const name = `${stem(info.family)}-${w}${italic ? "-italic" : ""}${sub === "latin" ? "" : `-${sub}`}.ttf`;
    if (!SAFE_NAME.test(name)) continue;
    const { bytes } = await fetchPublic(`https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/${sub}-${w}-${style}.ttf`, signal, { maxBytes: 5_000_000 });
    await writeFile(path.join(dir, name), bytes);
    saved.push(`$font/${name}`);
  }
  const index = await readIndex(dir);
  if (index[stem(info.family)] !== info.family) await writeFile(path.join(dir, INDEX), JSON.stringify({ ...index, [stem(info.family)]: info.family }, null, 1));
  return { family: info.family, license: info.license, added: saved, otherSubsets: info.subsets.filter((s) => s !== sub) };
}

/** The brand's fonts, downloaded the first time a composition needs them. */
export async function ensureBrandFonts(signal: AbortSignal) {
  const dir = await mediaFolder("fonts");
  for (const f of BRAND_FONTS) {
    const missing = f.weights.filter((w) => !existsSync(path.join(dir, `${stem(f.family)}-${w}.ttf`)));
    if (missing.length) await addGoogleFont(f.family, [...missing], "latin", false, signal);
    const missingItalic = f.italic.filter((w) => !existsSync(path.join(dir, `${stem(f.family)}-${w}-italic.ttf`)));
    if (missingItalic.length) await addGoogleFont(f.family, [...missingItalic], "latin", true, signal);
  }
}

export interface FontFace {
  file: string;
  family: string;
  weight: number;
  style: "normal" | "italic";
}

/** Every font in the folder as a CSS family, weight and style ("Arial-Bold.ttf" style names guessed). */
export async function fontFaces(): Promise<FontFace[]> {
  const dir = await mediaFolder("fonts");
  const index = await readIndex(dir);
  const out: FontFace[] = [];
  for (const file of (await readdir(dir)).filter((f) => /\.(ttf|otf|woff2?)$/i.test(f)).sort()) {
    const m = /^([A-Za-z0-9]+)-(\d{3})(-italic)?(?:-[a-z-]+)?\.\w+$/.exec(file);
    const named = /^([A-Za-z0-9]+)-(Regular|Bold|Italic|BoldItalic)\.\w+$/.exec(file);
    const fam = m?.[1] ?? named?.[1];
    if (!fam) continue;
    const family = index[fam] ?? fam.replace(/([a-z])([A-Z])/g, "$1 $2");
    const weight = m ? Number(m[2]) : /Bold/.test(named![2]) ? 700 : 400;
    const style = (m ? !!m[3] : /Italic/.test(named![2])) ? "italic" : "normal";
    out.push({ file, family, weight, style });
  }
  return out;
}
