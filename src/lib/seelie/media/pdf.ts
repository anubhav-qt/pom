import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import type * as Mupdf from "mupdf";

import { mediaFolder, mediaPath } from "./files";

/**
 * MuPDF, the engine PyMuPDF wraps, as WebAssembly (mupdf.js). It is loaded on first use:
 * 10 MB of wasm that only PDFs need.
 *
 * Fonts for HTML laid out on a page: the base 14 (Helvetica, Times, Courier, as
 * sans-serif, serif and monospace) are built in; a family added with video_assets
 * add_font is taken from fonts/ (Family-400.ttf, -700 for bold); what those don't
 * have (₹, Hindi, other Indian scripts) comes from Noto Sans, fetched from Fontsource
 * the first time a page needs it (`fallbackFonts`).
 */

type MupdfModule = typeof Mupdf;

let loading: Promise<MupdfModule> | null = null;

export function mupdf(): Promise<MupdfModule> {
  loading ??= import("mupdf")
    .then((m) => {
      m.installLoadFontFunction(fontLoader(m));
      return m;
    })
    .catch((err) => {
      loading = null;
      throw err;
    });
  return loading;
}

/** Fontsource family and subset for each script MuPDF asks a fallback for. */
const NOTO: Record<string, { id: string; subset: string; file: string; test: RegExp }> = {
  Latin: { id: "noto-sans", subset: "latin-ext", file: "NotoSans", test: /[Ā-ɏ₠-⃀]/ },
  Devanagari: { id: "noto-sans", subset: "devanagari", file: "NotoSans", test: /[ऀ-ॿ]/ },
  Greek: { id: "noto-sans", subset: "greek", file: "NotoSans", test: /[Ͱ-Ͽ]/ },
  Cyrillic: { id: "noto-sans", subset: "cyrillic", file: "NotoSans", test: /[Ѐ-ӿ]/ },
  Bengali: { id: "noto-sans-bengali", subset: "bengali", file: "NotoSansBengali", test: /[ঀ-৿]/ },
  Gurmukhi: { id: "noto-sans-gurmukhi", subset: "gurmukhi", file: "NotoSansGurmukhi", test: /[਀-੿]/ },
  Gujarati: { id: "noto-sans-gujarati", subset: "gujarati", file: "NotoSansGujarati", test: /[઀-૿]/ },
  Oriya: { id: "noto-sans-oriya", subset: "oriya", file: "NotoSansOriya", test: /[଀-୿]/ },
  Tamil: { id: "noto-sans-tamil", subset: "tamil", file: "NotoSansTamil", test: /[஀-௿]/ },
  Telugu: { id: "noto-sans-telugu", subset: "telugu", file: "NotoSansTelugu", test: /[ఀ-౿]/ },
  Kannada: { id: "noto-sans-kannada", subset: "kannada", file: "NotoSansKannada", test: /[ಀ-೿]/ },
  Malayalam: { id: "noto-sans-malayalam", subset: "malayalam", file: "NotoSansMalayalam", test: /[ഀ-ൿ]/ },
};

// Named the way video_assets add_font names its files, so either can use the other's.
const notoFile = (n: (typeof NOTO)[string], weight: 400 | 700) => `${n.file}-${weight}-${n.subset}.ttf`;

/**
 * The Noto fonts `texts` need, downloaded once (both weights). A font that can't be
 * fetched is skipped: those characters then show as boxes, which the page preview shows.
 */
export async function fallbackFonts(texts: string[], signal: AbortSignal): Promise<string[]> {
  const all = texts.join("\n");
  const missing: string[] = [];
  const dir = await mediaFolder("fonts");
  for (const [script, n] of Object.entries(NOTO)) {
    if (script !== "Latin" && !n.test.test(all)) continue;
    for (const weight of [400, 700] as const) {
      const file = path.join(dir, notoFile(n, weight));
      if (existsSync(file)) continue;
      try {
        const res = await fetch(`https://cdn.jsdelivr.net/fontsource/fonts/${n.id}@latest/${n.subset}-${weight}-normal.ttf`, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        });
        if (!res.ok) throw new Error(String(res.status));
        await writeFile(file, Buffer.from(await res.arrayBuffer()));
      } catch {
        if (script !== "Latin") missing.push(script);
      }
    }
  }
  return [...new Set(missing)];
}

function fontLoader(m: MupdfModule) {
  const cache = new Map<string, Mupdf.Font>();
  const open = (file: string) => {
    let font = cache.get(file);
    if (!font) {
      font = new m.Font(path.basename(file, ".ttf"), readFileSync(file));
      cache.set(file, font);
    }
    return font;
  };
  const find = (names: string[]) => {
    const dir = mediaPath("fonts");
    for (const n of names) {
      const file = path.join(dir, n);
      if (existsSync(file)) return file;
    }
    return null;
  };
  // mupdf.js passes the string "undefined" for whichever of name and script it isn't asking by.
  const given = (s: unknown) => typeof s === "string" && s !== "undefined" && s !== "";
  return (name: string, script: string, bold: boolean, italic: boolean): Mupdf.Font | null => {
    try {
      if (given(name)) {
        const family = name.replace(/[^A-Za-z0-9]+/g, "");
        if (!family) return null;
        const weights = bold ? [700, 600, 800, 500, 900] : [400, 500, 300];
        const styles = italic ? ["-italic", ""] : [""];
        const file = find(styles.flatMap((s) => weights.map((w) => `${family}-${w}${s}.ttf`)));
        return file ? open(file) : null;
      }
      if (given(script)) {
        const n = NOTO[script];
        if (!n) return null;
        const file = find(bold ? [notoFile(n, 700), notoFile(n, 400)] : [notoFile(n, 400)]);
        return file ? open(file) : null;
      }
    } catch {
      // A broken font file: MuPDF goes on with its own.
    }
    return null;
  };
}

/** How many pages a PDF has; null when it's locked or can't be read. */
export async function pdfPageCount(bytes: Uint8Array): Promise<number | null> {
  const m = await mupdf();
  try {
    const doc = m.Document.openDocument(bytes, "application/pdf");
    try {
      return doc.needsPassword() ? null : doc.countPages();
    } finally {
      doc.destroy();
    }
  } catch {
    return null;
  }
}
