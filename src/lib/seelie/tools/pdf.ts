import "server-only";

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Type, type ImageContent, type Static } from "@paribelle/pi-ai";
import type * as Mupdf from "mupdf";

import { assetSummary, getAsset, mediaPath, MediaError, saveAsset, type AssetRow } from "../media/files";
import { fallbackFonts, mupdf } from "../media/pdf";
import { fetchPublic } from "./images";
import { imageOf } from "./photo";
import { defineTool, ToolError, type ToolContext } from "./types";
import { optional, plural, StringEnum } from "./util";

/**
 * PDFs, with MuPDF (the engine PyMuPDF wraps): pdf_read reads one (text, layout, form
 * fields, outline, a look at its pages); pdf_edit makes a new one from it, or from
 * nothing, in steps. Nothing is changed in place: every result is a new asset.
 *
 * Positions are in points (1/72 inch) from the top-left corner of the page as it shows,
 * the same way pdf_read reports page sizes and text boxes.
 */

type M = typeof Mupdf;
type Rect = Mupdf.Rect;
type Matrix = Mupdf.Matrix;

/** The largest PDF taken from a URL. */
const MAX_PDF = 100 * 1024 * 1024;
/** Text pdf_read hands back in one go. */
const TEXT_BUDGET = 40_000;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const r1 = (n: number) => Math.round(n * 10) / 10;
const jpegBlock = (bytes: Uint8Array): ImageContent => ({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/jpeg" });

/* -------------------------------------------------------------------------- */
/* Opening                                                                    */
/* -------------------------------------------------------------------------- */

interface Source {
  ref: string;
  name: string;
  bytes: Buffer;
}

/** A PDF by ref (asset:<id>) or public https URL; a URL's PDF is kept as an asset so it has a ref. */
async function pdfOf(raw: string, ctx: ToolContext): Promise<Source> {
  const r = raw.trim();
  if (/^https:\/\//i.test(r)) {
    const { bytes, url } = await fetchPublic(r, ctx.signal, { maxBytes: MAX_PDF, timeoutMs: 90_000, accept: "application/pdf" });
    let name = "document";
    try {
      name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "").replace(/\.pdf$/i, "").slice(0, 120) || name;
    } catch {
      // A name that isn't valid URI encoding: "document".
    }
    const row = await saveAsset({ bytes, mime: "application/pdf", name, source: "url", chatId: ctx.chatId, userId: ctx.user.id, meta: { url } });
    return { ref: `asset:${row.id}`, name: row.name, bytes };
  }
  const id = /^asset:(\d{1,9})$/.exec(r)?.[1];
  if (!id) throw new ToolError(`"${raw}" isn't a PDF ref: give its asset:<id> (an attached PDF says its own) or a public https URL.`);
  const row = await getAsset(Number(id));
  if (!row) throw new ToolError(`There's no ${r}.`);
  if (row.kind !== "document") throw new ToolError(`${r} is ${row.kind === "image" ? "an image" : `a ${row.kind}`}, not a PDF${row.kind === "image" ? " (pdf_edit insert puts pictures on pages)" : ""}.`);
  return { ref: r, name: row.name, bytes: await readFile(mediaPath(row.file)) };
}

function openPdf(m: M, src: Source, password: string | undefined) {
  let doc: Mupdf.Document;
  try {
    doc = m.Document.openDocument(src.bytes, "application/pdf");
  } catch (e) {
    throw new ToolError(`${src.ref} can't be read as a PDF: ${msg(e)}.`);
  }
  const locked = doc.needsPassword();
  if (locked) {
    if (!password) throw new ToolError(`${src.ref} is locked with a password. Ask for it, then pass password.`);
    if (!doc.authenticatePassword(password)) throw new ToolError(`That password doesn't open ${src.ref}.`);
  }
  const pdf = doc.asPDF();
  if (!pdf) throw new ToolError(`${src.ref} isn't a PDF.`);
  return { doc: pdf, locked };
}

/* -------------------------------------------------------------------------- */
/* Pages, boxes, colours                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Pages as people write them, 1-based: all, 3, 2-5, 4- (to the end), last, odd, even, or a
 * list ("1,3-4,last"). Indexes (0-based) in the order given, repeats kept.
 */
function pagesOf(spec: string | undefined, count: number, field = "pages"): number[] {
  const s = (spec ?? "all").trim().toLowerCase();
  if (!s || s === "all") return Array.from({ length: count }, (_, i) => i);
  const out: number[] = [];
  for (const part of s.split(/\s*,\s*/).filter(Boolean)) {
    if (part === "odd" || part === "even") {
      for (let i = part === "odd" ? 0 : 1; i < count; i += 2) out.push(i);
      continue;
    }
    const m = /^(\d+|last)(\s*-\s*(\d+|last)?)?$/.exec(part);
    if (!m) throw new ToolError(`${field}: "${part}" isn't a page or a range (1, 2-5, 4-, last, odd, even).`);
    const num = (t: string) => (t === "last" ? count : Number(t));
    const a = num(m[1]);
    const b = m[2] ? (m[3] ? num(m[3]) : count) : a;
    for (const n of [a, b]) if (n < 1 || n > count) throw new ToolError(`${field}: there's no page ${n}; the PDF has ${plural(count, "page")}.`);
    if (a <= b) for (let i = a; i <= b; i++) out.push(i - 1);
    else for (let i = a; i >= b; i--) out.push(i - 1);
  }
  return out;
}

/** Page sizes by name, in points. */
const SIZES: Record<string, [number, number]> = {
  a4: [595.28, 841.89],
  a5: [419.53, 595.28],
  a3: [841.89, 1190.55],
  letter: [612, 792],
  legal: [612, 1008],
};

function sizeOf(size: string | undefined, fallback: [number, number]): [number, number] {
  if (!size || size === "same") return fallback;
  const [name, turn] = size.split("-");
  const s = SIZES[name];
  if (!s) return fallback;
  return turn === "landscape" ? [s[1], s[0]] : s;
}

function paperName(w: number, h: number) {
  const [a, b] = [Math.min(w, h), Math.max(w, h)];
  for (const [name, [x, y]] of Object.entries(SIZES)) if (Math.abs(a - x) < 3 && Math.abs(b - y) < 3) return `${name.toUpperCase()}${w > h ? " landscape" : ""}`;
  return null;
}

const NAMED: Record<string, string> = { black: "#000000", white: "#ffffff", red: "#d32f2f", green: "#2e7d32", blue: "#1565c0", grey: "#808080", gray: "#808080", yellow: "#ffeb3b", orange: "#f57c00" };

/** #rgb, #rrggbb or a basic name, as 0–1 RGB and as CSS. */
function colourOf(raw: string | undefined, fallback: string): { rgb: [number, number, number]; css: string } {
  let c = (raw ?? fallback).trim().toLowerCase();
  c = NAMED[c] ?? c;
  if (/^#[0-9a-f]{3}$/.test(c)) c = `#${[...c.slice(1)].map((x) => x + x).join("")}`;
  if (!/^#[0-9a-f]{6}$/.test(c)) throw new ToolError(`"${raw}" isn't a colour: use #rrggbb.`);
  const n = Number.parseInt(c.slice(1), 16);
  return { rgb: [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255], css: c };
}

const hex = (rgb: number[]) =>
  `#${(rgb.length === 1 ? [rgb[0], rgb[0], rgb[0]] : rgb.length === 4 ? cmykToRgb(rgb) : rgb).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("")}`;
const cmykToRgb = ([c, m, y, k]: number[]) => [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const union = (a: Rect | null, b: Rect): Rect => (a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : [...b]);
const quadRect = (q: Mupdf.Quad): Rect => [Math.min(q[0], q[4]), Math.min(q[1], q[3]), Math.max(q[2], q[6]), Math.max(q[5], q[7])];
const rectQuad = (r: Rect): Mupdf.Quad => [r[0], r[1], r[2], r[1], r[0], r[3], r[2], r[3]];

/* -------------------------------------------------------------------------- */
/* Drawing on pages                                                           */
/* -------------------------------------------------------------------------- */

const fmt = (n: number) => (Math.abs(n) < 1e-9 ? "0" : String(Math.round(n * 1e6) / 1e6));

/**
 * Draws on top of pages as part of their content (not an annotation a viewer could move
 * or leave out): `draw` paints each page as it shows, into a PDF page of its own; that
 * page then goes onto the real one as a form, placed through both pages' transforms, so
 * rotated and cropped pages come out right. `opacity` fades the form as one group (a
 * group drawn inside it instead would be nested, and redaction scrambles a nested
 * group's fonts).
 */
function overlay(m: M, doc: Mupdf.PDFDocument, indexes: number[], draw: (dev: Mupdf.Device, bounds: Rect, index: number) => void, opacity = 1) {
  if (!indexes.length) return;
  const targets = indexes.map((i) => doc.loadPage(i));
  const buf = new m.Buffer();
  const writer = new m.DocumentWriter(buf, "pdf", "compress");
  targets.forEach((page, n) => {
    const bounds = page.getBounds();
    const dev = writer.beginPage(bounds);
    draw(dev, bounds, indexes[n]);
    writer.endPage();
  });
  writer.close();
  const over = m.Document.openDocument(buf.asUint8Array(), "application/pdf").asPDF() as Mupdf.PDFDocument;
  // One map for every page: a font drawn on all of them is copied over once.
  const map = doc.newGraftMap();
  targets.forEach((page, n) => {
    const op = over.loadPage(n);
    const oo = op.getObject();
    const contents = oo.get("Contents");
    const parts: Uint8Array[] = [];
    if (contents.isArray()) contents.forEach((c) => parts.push(c.readStream().asUint8Array()));
    else parts.push(contents.readStream().asUint8Array());
    const mb = oo.get("MediaBox");
    const form = doc.addStream(Buffer.concat(parts.map((p) => Buffer.from(p))), {
      Type: "XObject",
      Subtype: "Form",
      BBox: [0, 1, 2, 3].map((k) => mb.get(k).asNumber()),
      Resources: map.graftObject(oo.get("Resources")),
      ...(opacity < 1 ? { Group: { S: "Transparency", I: true } } : {}),
    });
    const name = `Sl${randomBytes(4).toString("hex")}`;
    const po = page.getObject();
    let res = po.get("Resources");
    if (res.isNull()) {
      // Resources handed down from the page tree: this page gets its own copy to add to.
      const inherited = po.getInheritable("Resources");
      const own = doc.newDictionary();
      if (!inherited.isNull()) inherited.forEach((v, k) => own.put(k, v));
      po.put("Resources", own);
      res = po.get("Resources");
    }
    if (res.get("XObject").isNull()) res.put("XObject", doc.newDictionary());
    res.get("XObject").put(name, form);
    let fade = "";
    if (opacity < 1) {
      if (res.get("ExtGState").isNull()) res.put("ExtGState", doc.newDictionary());
      res.get("ExtGState").put(`${name}a`, { Type: "ExtGState", ca: opacity, CA: opacity });
      fade = `/${name}a gs `;
    }
    // Overlay space -> the page's own: into the view by the overlay's transform, back out by the page's.
    const ctm = m.Matrix.concat(op.getTransform(), m.Matrix.invert(page.getTransform()));
    const old = po.get("Contents");
    const list = doc.newArray();
    // The page's own drawing in q/Q, so whatever state it leaves doesn't move what goes on top.
    list.push(doc.addStream("q\n", {}));
    if (old.isArray()) old.forEach((c) => list.push(c));
    else if (!old.isNull()) list.push(old);
    list.push(doc.addStream(`\nQ\nq ${fade}${ctm.map(fmt).join(" ")} cm /${name} Do Q\n`, {}));
    po.put("Contents", list);
  });
}

type Position = "top-left" | "top" | "top-right" | "centre" | "bottom-left" | "bottom" | "bottom-right" | "diagonal";

/** Where a block goes: its box on the page, and how it sits in it. */
function region(bounds: Rect, box: Static<typeof Box> | undefined, position: Position | undefined, margin: number) {
  if (box) return { x: bounds[0] + box.x, y: bounds[1] + box.y, w: box.w, h: box.h, v: "top" as const, align: "left" as const };
  const p = position ?? "bottom";
  const [x0, y0, x1, y1] = bounds;
  const v = p.startsWith("top") ? ("top" as const) : p.startsWith("bottom") ? ("bottom" as const) : ("middle" as const);
  const align = p.endsWith("left") ? ("left" as const) : p.endsWith("right") ? ("right" as const) : ("center" as const);
  return { x: x0 + margin, y: y0 + margin, w: Math.max(1, x1 - x0 - 2 * margin), h: Math.max(1, y1 - y0 - 2 * margin), v, align };
}

/** HTML laid out at a width: its page, and where its content actually is (lines and pictures). */
function layoutHtml(m: M, html: string, width: number, css: string) {
  const doc = m.Document.openDocument(
    new TextEncoder().encode(`<!DOCTYPE html><html><head><style>@page{margin:0}body{margin:0}${css}</style></head><body>${html}</body></html>`),
    "text/html",
  );
  doc.layout(width, 20_000, 11);
  const page = doc.loadPage(0);
  let box: Rect | null = null;
  let first: Mupdf.Point | null = null;
  page.toStructuredText("preserve-images").walk({
    beginLine: (b) => void (box = union(box, b)),
    onImageBlock: (b) => void (box = union(box, b)),
    onChar: (_c, origin) => void (first ??= origin),
  });
  return { page, box: box as Rect | null, first: first as Mupdf.Point | null };
}

/* -------------------------------------------------------------------------- */
/* Pictures in HTML                                                           */
/* -------------------------------------------------------------------------- */

const sniff = (b: Buffer) => (b[0] === 0x89 ? "image/png" : b[0] === 0xff ? "image/jpeg" : b.subarray(8, 12).toString() === "WEBP" ? "image/webp" : b.subarray(0, 3).toString() === "GIF" ? "image/gif" : "image/png");

/** `src="chat:2"`, `src="asset:9"` and https pictures in HTML, as data the layout can draw. */
async function inlinePictures(html: string, ctx: ToolContext): Promise<string> {
  const SRC = /(\bsrc\s*=\s*["'])(chat:\d{1,4}|asset:\d{1,9}|https:\/\/[^"']+)(["'])/gi;
  const wanted = [...new Set([...html.matchAll(SRC)].map((x) => x[2]))];
  if (wanted.length > 30) throw new ToolError("At most 30 different pictures in one piece of HTML.");
  const data = new Map<string, string>();
  for (const ref of wanted) {
    let bytes: Buffer;
    if (/^https:/i.test(ref)) bytes = (await fetchPublic(ref, ctx.signal, { maxBytes: 20_000_000, timeoutMs: 30_000 })).bytes;
    else bytes = (await imageOf(ref, ctx)).bytes;
    data.set(ref, `data:${sniff(bytes)};base64,${bytes.toString("base64")}`);
  }
  return html.replace(SRC, (_all, a: string, ref: string, b: string) => `${a}${data.get(ref) ?? ref}${b}`);
}

/* -------------------------------------------------------------------------- */
/* pdf_read                                                                   */
/* -------------------------------------------------------------------------- */

interface Field {
  name: string;
  type: string;
  value: string;
  page: number;
  options?: string[];
  readOnly?: true;
}

/** The form's fields, one entry per field (a radio group's buttons together). */
function fieldsOf(doc: Mupdf.PDFDocument, max = 300): Field[] {
  const byName = new Map<string, Field>();
  for (let i = 0; i < doc.countPages() && byName.size < max; i++) {
    for (const w of doc.loadPage(i).getWidgets()) {
      const name = w.getName();
      const type = w.getFieldType();
      const seen = byName.get(name);
      if (type === "radiobutton" || type === "checkbox") {
        const states: string[] = [];
        const n = w.getObject().get("AP").get("N");
        if (n.isDictionary()) n.forEach((_v, k) => void (k !== "Off" && states.push(String(k))));
        if (seen) {
          seen.options = [...new Set([...(seen.options ?? []), ...states])];
          continue;
        }
        byName.set(name, { name, type, value: w.getValue(), page: i + 1, ...(type === "radiobutton" ? { options: states } : {}), ...(w.isReadOnly() ? { readOnly: true as const } : {}) });
        continue;
      }
      if (seen) continue;
      byName.set(name, {
        name,
        type,
        value: w.getValue(),
        page: i + 1,
        ...(w.isChoice() ? { options: w.getOptions().slice(0, 60) } : {}),
        ...(w.isReadOnly() ? { readOnly: true as const } : {}),
      });
    }
  }
  return [...byName.values()];
}

function outlineOf(doc: Mupdf.Document, max = 120) {
  const out: { level: number; title: string; page: number | null }[] = [];
  const walk = (items: ReturnType<Mupdf.Document["loadOutline"]>, level: number) => {
    for (const it of items ?? []) {
      if (out.length >= max) return;
      out.push({ level, title: (it.title ?? "").slice(0, 160), page: typeof it.page === "number" && it.page >= 0 ? it.page + 1 : null });
      if (it.down) walk(it.down, level + 1);
    }
  };
  try {
    walk(doc.loadOutline(), 1);
  } catch {
    // A broken outline: none.
  }
  return out;
}

/** The pages' sizes, grouped: "A4 (595x842) x12". */
function sizesOf(doc: Mupdf.PDFDocument) {
  const groups = new Map<string, { size: string; pages: number[] }>();
  for (let i = 0; i < doc.countPages(); i++) {
    const [x0, y0, x1, y1] = doc.loadPage(i).getBounds();
    const w = Math.round(x1 - x0);
    const h = Math.round(y1 - y0);
    const key = `${w}x${h}`;
    const g = groups.get(key) ?? { size: `${paperName(w, h) ?? "custom"} ${key} pt`, pages: [] };
    g.pages.push(i + 1);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ size: g.size, pages: g.pages.length > 12 ? `${g.pages.length} pages` : g.pages.join(",") }));
}

/** A page as a JPEG at most `edge` px on its long side. */
function pageJpeg(m: M, page: Mupdf.Page, edge: number, quality = 80) {
  const [x0, y0, x1, y1] = page.getBounds();
  const s = Math.min(3, edge / Math.max(1, x1 - x0, y1 - y0));
  return page.toPixmap(m.Matrix.scale(s, s), m.ColorSpace.DeviceRGB, false, true).asJPEG(quality);
}

export const pdfRead = defineTool({
  name: "pdf_read",
  label: "Read PDF",
  description: [
    "Read a PDF (pdf: asset:<id>, which an attached PDF gives, or a public https URL, which is saved as an asset first). Always: page count, page sizes, metadata, form fields (name, type, value, options), outline.",
    "text (default true): the text of pages (pages: 1-based, e.g. 1-3, 5, last, odd; default all) up to ~40k characters; ask again from where it stopped.",
    "layout: each line with its box [x0, y0, x1, y1] in points from the page's top-left, font, size and colour, for placing edits. find: where words or phrases are (page and box).",
    "look: see pages as pictures (up to 8 of pages): scans, stamps, signatures, layout. A page with almost no text is likely a scan: look at it. password opens a locked PDF.",
  ].join(" "),
  parameters: Type.Object({
    pdf: Type.String(),
    pages: optional(Type.String({ maxLength: 400 })),
    text: optional(Type.Boolean()),
    layout: optional(Type.Boolean()),
    find: optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 30 })),
    look: optional(Type.Boolean()),
    password: optional(Type.String({ maxLength: 128 })),
  }),
  kind: "read",
  summary: (a) => `Read ${a.pdf}${a.pages ? ` pages ${a.pages}` : ""}`,
  async execute(a, ctx) {
    const m = await mupdf();
    const src = await pdfOf(a.pdf, ctx);
    const { doc, locked } = openPdf(m, src, a.password);
    try {
      const count = doc.countPages();
      const pages = pagesOf(a.pages, count);
      const meta: Record<string, string> = {};
      for (const k of ["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"]) {
        const v = doc.getMetaData(`info:${k}`);
        if (v) meta[k.toLowerCase()] = v.slice(0, 300);
      }
      const notes: string[] = [];
      if (doc.wasRepaired()) notes.push("The file was damaged; MuPDF repaired it to read it.");

      const text: { page: number; text: string }[] = [];
      const lines: { page: number; text: string; box: number[]; font: string; size: number; colour: string }[] = [];
      const scans: number[] = [];
      let budget = TEXT_BUDGET;
      let stoppedAt: number | null = null;
      if (a.text !== false || a.layout) {
        for (const i of pages) {
          ctx.progress(`Reading page ${i + 1} of ${count}…`);
          const st = doc.loadPage(i).toStructuredText("preserve-whitespace,preserve-images");
          let images = 0;
          let line: { text: string; box: Rect; font: string; size: number; colour: string } | null = null;
          st.walk({
            onImageBlock: () => void images++,
            beginLine: (bbox) => void (line = { text: "", box: bbox, font: "", size: 0, colour: "" }),
            onChar: (c, _o, font, size, _q, colour) => {
              if (!line) return;
              if (!line.font) Object.assign(line, { font: font.getName().replace(/^[A-Z]{6}\+/, ""), size: r1(size), colour: hex(colour) });
              line.text += c;
            },
            endLine: () => {
              const l = line as typeof line;
              if (a.layout && l && l.text.trim() && lines.length < 800) lines.push({ page: i + 1, text: l.text.trim(), box: l.box.map(r1), font: l.font, size: l.size, colour: l.colour });
              line = null;
            },
          });
          const t = st.asText().replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
          if (t.length < 20 && images > 0) scans.push(i + 1);
          if (a.text !== false && stoppedAt === null) {
            if (t.length > budget) {
              if (budget > 2000) text.push({ page: i + 1, text: `${t.slice(0, budget)} …` });
              stoppedAt = i + 1;
            } else {
              text.push({ page: i + 1, text: t });
              budget -= t.length;
            }
          }
        }
      }
      if (stoppedAt !== null) notes.push(`Text stops at page ${stoppedAt} (about ${TEXT_BUDGET / 1000}k characters a call): read on with pages "${stoppedAt}-".`);
      if (scans.length) notes.push(`Page${scans.length === 1 ? "" : "s"} ${scans.slice(0, 20).join(", ")} ${scans.length === 1 ? "has" : "have"} almost no text but pictures: likely scans. look at them to read them.`);
      if (lines.length >= 800) notes.push("Layout stops at 800 lines: ask for fewer pages.");

      const hits: { find: string; page: number; box: number[] }[] = [];
      for (const needle of a.find ?? []) {
        let n = 0;
        for (const i of pages) {
          for (const quads of doc.loadPage(i).search(needle, null)) {
            if (hits.length >= 300) break;
            hits.push({ find: needle, page: i + 1, box: quads.map(quadRect).reduce<Rect | null>((u, r) => union(u, r), null)!.map(r1) });
            n++;
          }
        }
        if (!n) notes.push(`"${needle}" isn't in ${a.pages ? `pages ${a.pages}` : "the PDF"}${scans.length ? " (scanned pages have no text to search)" : ""}.`);
      }

      const images: ImageContent[] = [];
      if (a.look) {
        for (const i of pages.slice(0, 8)) {
          ctx.progress(`Looking at page ${i + 1}…`);
          images.push(jpegBlock(pageJpeg(m, doc.loadPage(i), 1500)));
        }
        if (pages.length > 8) notes.push(`Showing the first 8 of ${pages.length} pages.`);
      }

      const fields = fieldsOf(doc);
      const outline = outlineOf(doc);
      return {
        data: {
          ref: src.ref,
          name: src.name,
          pages: count,
          sizes: sizesOf(doc),
          ...(locked ? { locked: true } : {}),
          ...(Object.keys(meta).length ? { meta } : {}),
          ...(fields.length ? { fields } : {}),
          ...(outline.length ? { outline } : {}),
          ...(a.text !== false ? { text } : {}),
          ...(a.layout ? { lines } : {}),
          ...(a.find?.length ? { found: hits } : {}),
          ...(notes.length ? { notes } : {}),
        },
        images: images.length ? images : undefined,
      };
    } finally {
      doc.destroy();
    }
  },
});

/* -------------------------------------------------------------------------- */
/* pdf_edit                                                                   */
/* -------------------------------------------------------------------------- */

const Box = Type.Object(
  { x: Type.Number({ minimum: -5000, maximum: 20000 }), y: Type.Number({ minimum: -5000, maximum: 20000 }), w: Type.Number({ minimum: 1, maximum: 20000 }), h: Type.Number({ minimum: 1, maximum: 20000 }) },
  { description: "Points from the page's top-left corner, as pdf_read reports." },
);
const PageBox = Type.Object({ page: Type.Integer({ minimum: 1 }), x: Type.Number(), y: Type.Number(), w: Type.Number({ minimum: 1 }), h: Type.Number({ minimum: 1 }) });

const OPS = ["pages", "delete", "rotate", "crop", "insert", "html", "text", "image", "redact", "replace", "mark", "fill", "flatten", "meta"] as const;
const POSITIONS = ["top-left", "top", "top-right", "centre", "bottom-left", "bottom", "bottom-right", "diagonal"] as const;

const Step = Type.Object({
  op: StringEnum(OPS),
  pages: optional(Type.String({ maxLength: 400 })),
  degrees: optional(Type.Integer({ minimum: -270, maximum: 270 })),
  box: optional(Box),
  boxes: optional(Type.Array(PageBox, { maxItems: 300 })),
  // insert / html
  refs: optional(Type.Array(Type.String(), { maxItems: 60 })),
  at: optional(Type.Integer({ minimum: 1 })),
  count: optional(Type.Integer({ minimum: 1, maximum: 100 })),
  size: optional(StringEnum(["a4", "a4-landscape", "a5", "a5-landscape", "a3", "a3-landscape", "letter", "letter-landscape", "legal", "image", "same"])),
  margin: optional(Type.Number({ minimum: 0, maximum: 300 })),
  // html / text
  html: optional(Type.String({ maxLength: 300_000 })),
  position: optional(StringEnum(POSITIONS)),
  fontSize: optional(Type.Number({ minimum: 2, maximum: 400 })),
  font: optional(Type.String({ maxLength: 60 })),
  colour: optional(Type.String({ maxLength: 20 })),
  opacity: optional(Type.Number({ minimum: 0.02, maximum: 1 })),
  angle: optional(Type.Number({ minimum: -360, maximum: 360 })),
  // image
  ref: optional(Type.String()),
  width: optional(Type.Number({ minimum: 1, maximum: 10000 })),
  // redact / mark / replace
  find: optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 60 })),
  fill: optional(StringEnum(["black", "white"])),
  style: optional(StringEnum(["highlight", "underline", "strike"])),
  replace: optional(Type.Array(Type.Object({ find: Type.String({ minLength: 1, maxLength: 200 }), to: Type.String({ maxLength: 500 }) }), { maxItems: 60 })),
  // fill
  fields: optional(Type.Array(Type.Object({ name: Type.String({ maxLength: 300 }), value: Type.String({ maxLength: 5000 }) }), { maxItems: 400 })),
  // meta
  title: optional(Type.String({ maxLength: 300 })),
  author: optional(Type.String({ maxLength: 200 })),
  subject: optional(Type.String({ maxLength: 300 })),
  keywords: optional(Type.String({ maxLength: 500 })),
});
type StepT = Static<typeof Step>;

interface Run {
  m: M;
  doc: Mupdf.PDFDocument;
  ctx: ToolContext;
  notes: string[];
}

const need = <T>(v: T | undefined | null, what: string): T => {
  if (v === undefined || v === null || (Array.isArray(v) && !v.length) || v === "") throw new ToolError(what);
  return v;
};

/** Where new pages go, 0-based (insertPage's -1 is the end). */
const insertAt = (at: number | undefined, count: number) => (at === undefined || at > count ? count : at - 1);

function pageSize(doc: Mupdf.PDFDocument, near: number): [number, number] {
  const n = doc.countPages();
  if (!n) return SIZES.a4;
  const [x0, y0, x1, y1] = doc.loadPage(Math.max(0, Math.min(n - 1, near))).getBounds();
  return [x1 - x0, y1 - y0];
}

/** Every hit of `needles` on the page, each as its quads. */
function hitsOn(page: Mupdf.PDFPage, needles: string[]) {
  return needles.flatMap((needle) => page.search(needle, null).map((quads) => ({ needle, quads })));
}

async function runStep(step: StepT, run: Run) {
  const { m, doc, ctx } = run;
  const count = doc.countPages();
  const targets = () => {
    if (!count) throw new ToolError(`${step.op}: the PDF has no pages yet (start with insert or html).`);
    return [...new Set(pagesOf(step.pages, count))];
  };

  switch (step.op) {
    case "pages": {
      const order = pagesOf(need(step.pages, "pages: the pages to keep, in their new order (e.g. 3,1-2,4-)."), count);
      if (new Set(order).size === order.length) {
        doc.rearrangePages(order);
        return;
      }
      // Repeats: each copy must be a page of its own (rearranging would share one page between them).
      const copy = new m.PDFDocument();
      const map = copy.newGraftMap();
      for (const i of order) map.graftPage(-1, doc, i);
      // Keep the document's info; the copy holds only pages.
      for (const k of ["Title", "Author", "Subject", "Keywords"]) {
        const v = doc.getMetaData(`info:${k}`);
        if (v) copy.setMetaData(`info:${k}`, v);
      }
      run.doc = copy;
      run.notes.push("Repeated pages: the outline and form links of the original aren't carried over.");
      return;
    }

    case "delete": {
      const gone = new Set(targets());
      if (gone.size >= count) throw new ToolError("delete: that's every page; keep at least one.");
      doc.rearrangePages(Array.from({ length: count }, (_, i) => i).filter((i) => !gone.has(i)));
      return;
    }

    case "rotate": {
      const d = need(step.degrees, "rotate: degrees (90 turns clockwise, -90 back, 180 upside down).");
      if (d % 90 !== 0) throw new ToolError("rotate: pages turn in steps of 90 degrees.");
      for (const i of targets()) {
        const po = doc.loadPage(i).getObject();
        const cur = po.getInheritable("Rotate");
        const was = cur.isNumber() ? cur.asNumber() : 0;
        po.put("Rotate", (((was + d) % 360) + 360) % 360);
      }
      return;
    }

    case "crop": {
      const box = need(step.box, "crop: box, the part of the page to keep.");
      for (const i of targets()) {
        const page = doc.loadPage(i);
        const [x0, y0, x1, y1] = page.getBounds();
        const keep: Rect = [Math.max(x0, x0 + box.x), Math.max(y0, y0 + box.y), Math.min(x1, x0 + box.x + box.w), Math.min(y1, y0 + box.y + box.h)];
        if (keep[2] - keep[0] < 10 || keep[3] - keep[1] < 10) throw new ToolError(`crop: that box is off page ${i + 1} (${r1(x1 - x0)}x${r1(y1 - y0)} pt).`);
        page.setPageBox("CropBox", keep);
      }
      return;
    }

    case "insert": {
      const at = insertAt(step.at, count);
      if (!step.refs?.length) {
        const [w, h] = sizeOf(step.size, pageSize(doc, at - 1));
        for (let k = 0; k < (step.count ?? 1); k++) doc.insertPage(at + k, doc.addPage([0, 0, w, h], 0, {}, ""));
        return;
      }
      let put = at;
      for (const ref of step.refs) {
        const r = ref.trim();
        const asset = /^asset:\d+$/.test(r) ? await getAsset(Number(r.slice(6))) : null;
        if (asset?.kind === "document" || /^https:\/\/.+\.pdf(\?|$)/i.test(r)) {
          const other = openPdf(m, await pdfOf(r, ctx), undefined).doc;
          const map = doc.newGraftMap();
          for (const i of pagesOf(step.pages, other.countPages(), `pages of ${r}`)) map.graftPage(put++, other, i);
          continue;
        }
        const pic = await imageOf(r, ctx);
        let image: Mupdf.Image;
        try {
          image = new m.Image(pic.bytes);
        } catch (e) {
          throw new ToolError(`${r} can't be put on a page: ${msg(e)}.`);
        }
        const iw = image.getWidth();
        const ih = image.getHeight();
        const margin = step.margin ?? (step.size === "image" ? 0 : 18);
        const [pw, ph] = step.size === "image" ? (iw >= ih ? [842, (842 * ih) / iw] : [(842 * iw) / ih, 842]) : sizeOf(step.size ?? "a4", SIZES.a4);
        const s = Math.min((pw - 2 * margin) / iw, (ph - 2 * margin) / ih);
        const [dw, dh] = [iw * s, ih * s];
        const [dx, dy] = [(pw - dw) / 2, (ph - dh) / 2];
        const xo = doc.addImage(image);
        // PDF space has y up: the picture's bottom-left corner sits dy up from the bottom.
        doc.insertPage(put++, doc.addPage([0, 0, pw, ph], 0, { XObject: { Im0: xo } }, `q ${fmt(dw)} 0 0 ${fmt(dh)} ${fmt(dx)} ${fmt(dy)} cm /Im0 Do Q`));
      }
      return;
    }

    case "html": {
      const html = await inlinePictures(need(step.html, "html: the HTML (with its CSS) to lay out as pages."), ctx);
      const missing = await fallbackFonts([html], ctx.signal);
      if (missing.length) run.notes.push(`Couldn't fetch fonts for ${missing.join(", ")} text; it may show as boxes.`);
      const [w, h] = sizeOf(step.size ?? "a4", SIZES.a4);
      const margin = step.margin ?? 40;
      const hdoc = m.Document.openDocument(
        new TextEncoder().encode(`<!DOCTYPE html><html><head><style>@page{margin:${margin}pt}body{margin:0;font-family:sans-serif;font-size:11pt;line-height:1.4}</style></head><body>${html}</body></html>`),
        "text/html",
      );
      hdoc.layout(w, h, 11);
      const n = hdoc.countPages();
      if (n > 500) throw new ToolError(`html: that comes to ${n} pages; 500 at most.`);
      const buf = new m.Buffer();
      const writer = new m.DocumentWriter(buf, "pdf", "compress");
      for (let i = 0; i < n; i++) {
        ctx.progress(`Laying out page ${i + 1} of ${n}…`);
        const p = hdoc.loadPage(i);
        const dev = writer.beginPage(p.getBounds());
        p.run(dev, m.Matrix.identity);
        writer.endPage();
      }
      writer.close();
      const made = m.Document.openDocument(buf.asUint8Array(), "application/pdf").asPDF()!;
      const map = doc.newGraftMap();
      const at = insertAt(step.at, count);
      for (let i = 0; i < n; i++) map.graftPage(at + i, made, i);
      return;
    }

    case "text": {
      const raw = need(step.html, "text: html, the words to put on the pages (HTML: <b>, <br>, <span style>, <img src=\"asset:<id>\">; {page} and {pages} become page numbers).");
      const html = await inlinePictures(raw, ctx);
      const missing = await fallbackFonts([html], ctx.signal);
      if (missing.length) run.notes.push(`Couldn't fetch fonts for ${missing.join(", ")} text; it may show as boxes.`);
      const pages = targets();
      const diagonal = step.position === "diagonal" && !step.box;
      const colour = colourOf(step.colour, diagonal ? "#808080" : "#222222");
      const opacity = step.opacity ?? (diagonal ? 0.25 : 1);
      const margin = step.margin ?? 28;
      const numbered = /\{pages?\}/.test(html);
      const family = step.font ? `"${step.font.replace(/["\\<>;{}]/g, "")}", sans-serif` : "sans-serif";

      // Laid out once per width (and per page when it has page numbers).
      const cache = new Map<string, ReturnType<typeof layoutHtml>>();
      overlay(m, doc, pages, (dev, bounds, index) => {
        const area = region(bounds, step.box, step.position, margin);
        // A diagonal line is laid out unbroken and wide (text past the layout's edge would be
        // left out of its measured box), then scaled down to the page.
        const width = diagonal ? 5000 : area.w;
        const size = step.fontSize ?? (diagonal ? 72 : 10);
        const css = `body{font-family:${family};font-size:${size}pt;color:${colour.css};text-align:${area.align};line-height:1.25${diagonal ? ";white-space:nowrap" : ""}}`;
        const text = numbered ? html.replace(/\{page\}/g, String(index + 1)).replace(/\{pages\}/g, String(count)) : html;
        const key = `${Math.round(width)}|${numbered ? index : ""}`;
        let laid = cache.get(key);
        if (!laid) {
          laid = layoutHtml(m, text, width, css);
          cache.set(key, laid);
        }
        const cb = laid.box;
        if (!cb) return;
        const [cw, ch] = [cb[2] - cb[0], cb[3] - cb[1]];
        let ctm: Matrix;
        if (diagonal) {
          // Centred, along the diagonal, shrunk until the turned text fits the page when no size was given.
          const angle = step.angle ?? (Math.atan2(area.h, area.w) * 180) / Math.PI;
          const [cos, sin] = [Math.abs(Math.cos((angle * Math.PI) / 180)), Math.abs(Math.sin((angle * Math.PI) / 180))];
          const fit = step.fontSize ? 1 : Math.min(1, (area.w * 0.9) / Math.max(1, cw * cos + ch * sin), (area.h * 0.9) / Math.max(1, cw * sin + ch * cos));
          ctm = [m.Matrix.translate(-(cb[0] + cw / 2), -(cb[1] + ch / 2)), m.Matrix.scale(fit, fit), m.Matrix.rotate(-angle), m.Matrix.translate(area.x + area.w / 2, area.y + area.h / 2)].reduce((a, b) => m.Matrix.concat(a, b));
        } else {
          const ty = area.v === "top" ? area.y - cb[1] : area.v === "bottom" ? area.y + area.h - cb[3] : area.y + (area.h - ch) / 2 - cb[1];
          ctm = m.Matrix.translate(area.x, ty);
          if (step.angle) {
            const c: Mupdf.Point = [area.x + cb[0] + cw / 2, ty + cb[1] + ch / 2];
            ctm = [ctm, m.Matrix.translate(-c[0], -c[1]), m.Matrix.rotate(-step.angle), m.Matrix.translate(c[0], c[1])].reduce((a, b) => m.Matrix.concat(a, b));
          }
        }
        laid.page.run(dev, ctm);
      }, opacity);
      return;
    }

    case "image": {
      const pic = await imageOf(need(step.ref, "image: ref, the picture (chat:<n> or asset:<id>)."), ctx);
      let image: Mupdf.Image;
      try {
        image = new m.Image(pic.bytes);
      } catch (e) {
        throw new ToolError(`${pic.ref} can't be put on a page: ${msg(e)}.`);
      }
      const aspect = image.getHeight() / image.getWidth();
      const margin = step.margin ?? 28;
      overlay(m, doc, targets(), (dev, bounds) => {
        const area = region(bounds, step.box, step.position === "diagonal" ? "centre" : (step.position ?? "top-right"), margin);
        let w = step.box ? area.w : Math.min(step.width ?? (bounds[2] - bounds[0]) * 0.2, area.w);
        let h = w * aspect;
        if (h > area.h) [w, h] = [area.h / aspect, area.h];
        const x = step.box || area.align === "center" ? area.x + (area.w - w) / 2 : area.align === "right" ? area.x + area.w - w : area.x;
        const y = step.box || area.v === "middle" ? area.y + (area.h - h) / 2 : area.v === "bottom" ? area.y + area.h - h : area.y;
        dev.fillImage(image, [w, 0, 0, h, x, y], step.opacity ?? 1);
      });
      return;
    }

    case "redact": {
      if (!step.find?.length && !step.boxes?.length) throw new ToolError("redact: find (words to remove) and/or boxes (areas to clear).");
      const pages = step.find?.length ? targets() : [];
      const byPage = new Map<number, Rect[]>();
      for (const b of step.boxes ?? []) {
        if (b.page > count) throw new ToolError(`redact: there's no page ${b.page}.`);
        byPage.set(b.page - 1, [...(byPage.get(b.page - 1) ?? []), [b.x, b.y, b.x + b.w, b.y + b.h]]);
      }
      let found = 0;
      for (const i of new Set([...pages, ...byPage.keys()])) {
        const page = doc.loadPage(i);
        const [x0, y0] = page.getBounds();
        let any = false;
        if (pages.includes(i)) {
          for (const hit of hitsOn(page, step.find ?? [])) {
            page.createAnnotation("Redact").setQuadPoints(hit.quads);
            found++;
            any = true;
          }
        }
        for (const r of byPage.get(i) ?? []) {
          page.createAnnotation("Redact").setRect([x0 + r[0], y0 + r[1], x0 + r[2], y0 + r[3]]);
          any = true;
        }
        // The text under them is removed (not just covered), pictures blanked where covered,
        // line art fully inside them removed.
        if (any) page.applyRedactions(step.fill !== "white", m.PDFPage.REDACT_IMAGE_PIXELS, m.PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED, m.PDFPage.REDACT_TEXT_REMOVE);
      }
      if (step.find?.length) run.notes.push(found ? `redact: removed ${plural(found, "match", "matches")}.` : `redact: none of ${step.find.map((f) => `"${f}"`).join(", ")} found${step.pages ? ` on pages ${step.pages}` : ""}.`);
      return;
    }

    case "replace": {
      const pairs = need(step.replace, "replace: pairs of { find, to }.");
      const missing = await fallbackFonts(pairs.map((p) => p.to), ctx.signal);
      if (missing.length) run.notes.push(`Couldn't fetch fonts for ${missing.join(", ")} text; it may show as boxes.`);
      const placed: { index: number; at: Mupdf.Point; dir: Mupdf.Point; size: number; colour: string; font: string; to: string }[] = [];
      const counts = new Map(pairs.map((p) => [p.find, 0]));
      for (const i of targets()) {
        const page = doc.loadPage(i);
        const chars: { quad: Mupdf.Quad; origin: Mupdf.Point; dir: Mupdf.Point; size: number; colour: number[]; font: string }[] = [];
        let dir: Mupdf.Point = [1, 0];
        page.toStructuredText("preserve-whitespace").walk({
          beginLine: (_b, _w, d) => void (dir = d),
          onChar: (_c, origin, font, size, quad, colour) => void chars.push({ quad, origin, dir, size, colour, font: font.getName() }),
        });
        let any = false;
        for (const p of pairs) {
          for (const quads of page.search(p.find, null)) {
            const r = quadRect(quads[0]);
            // The match's first letter: where the new words start, and how they look.
            const c = chars.find((ch) => {
              const [cx, cy] = [(ch.quad[0] + ch.quad[6]) / 2, (ch.quad[1] + ch.quad[7]) / 2];
              return cx >= r[0] - 0.5 && cx <= r[2] + 0.5 && cy >= r[1] - 0.5 && cy <= r[3] + 0.5;
            });
            page.createAnnotation("Redact").setQuadPoints(quads);
            any = true;
            counts.set(p.find, (counts.get(p.find) ?? 0) + 1);
            if (p.to && c) placed.push({ index: i, at: c.origin, dir: c.dir, size: c.size, colour: hex(c.colour), font: c.font, to: p.to });
          }
        }
        if (any) page.applyRedactions(false, m.PDFPage.REDACT_IMAGE_NONE, m.PDFPage.REDACT_LINE_ART_NONE, m.PDFPage.REDACT_TEXT_REMOVE);
      }
      const byPage = new Map<number, typeof placed>();
      for (const p of placed) byPage.set(p.index, [...(byPage.get(p.index) ?? []), p]);
      overlay(m, doc, [...byPage.keys()], (dev, _bounds, index) => {
        for (const p of byPage.get(index) ?? []) {
          const name = p.font.replace(/^[A-Z]{6}\+/, "");
          const family = name.split(/[-,]/)[0].replace(/(MT|PS|Std|Pro)$/g, "").replace(/["\\<>;{}]/g, "");
          const generic = /mono|courier|consol/i.test(name) ? "monospace" : /sans/i.test(name) ? "sans-serif" : /times|serif|roman|georgia|garamond|cambria|book/i.test(name) ? "serif" : "sans-serif";
          const bold = /bold|black|heavy|semibold|demi/i.test(name);
          const italic = /italic|oblique/i.test(name);
          const css = `body{font-family:"${family}",${generic};font-size:${p.size}pt;color:${p.colour};white-space:nowrap;font-weight:${bold ? 700 : 400};font-style:${italic ? "italic" : "normal"}}`;
          const laid = layoutHtml(m, escapeHtml(p.to), 5000, css);
          if (!laid.first) continue;
          // Along the old line, so it follows text on turned pages too.
          const turn = (Math.atan2(p.dir[1], p.dir[0]) * 180) / Math.PI;
          const ctm = [m.Matrix.translate(-laid.first[0], -laid.first[1]), m.Matrix.rotate(turn), m.Matrix.translate(p.at[0], p.at[1])].reduce((a, b) => m.Matrix.concat(a, b));
          laid.page.run(dev, ctm);
        }
      });
      const none = [...counts].filter(([, n]) => !n).map(([f]) => `"${f}"`);
      run.notes.push(`replace: ${[...counts].filter(([, n]) => n).map(([f, n]) => `"${f}" x${n}`).join(", ") || "nothing replaced"}${none.length ? `; not found: ${none.join(", ")}` : ""}. New words longer than the old can run into what follows: look at the result.`);
      return;
    }

    case "mark": {
      if (!step.find?.length && !step.boxes?.length) throw new ToolError("mark: find (words to mark) and/or boxes.");
      const type = step.style === "underline" ? "Underline" : step.style === "strike" ? "StrikeOut" : "Highlight";
      const colour = colourOf(step.colour, type === "Highlight" ? "#ffeb3b" : "#d32f2f").rgb;
      let found = 0;
      const pages = step.find?.length ? targets() : [];
      for (const i of pages) {
        const page = doc.loadPage(i);
        for (const hit of hitsOn(page, step.find ?? [])) {
          const a = page.createAnnotation(type);
          a.setColor(colour);
          a.setQuadPoints(hit.quads);
          a.update();
          found++;
        }
      }
      for (const b of step.boxes ?? []) {
        if (b.page > count) throw new ToolError(`mark: there's no page ${b.page}.`);
        const page = doc.loadPage(b.page - 1);
        const [x0, y0] = page.getBounds();
        const a = page.createAnnotation(type);
        a.setColor(colour);
        a.setQuadPoints([rectQuad([x0 + b.x, y0 + b.y, x0 + b.x + b.w, y0 + b.y + b.h])]);
        a.update();
      }
      if (step.find?.length) run.notes.push(found ? `mark: ${plural(found, "match", "matches")}.` : `mark: none of ${step.find.map((f) => `"${f}"`).join(", ")} found.`);
      return;
    }

    case "fill": {
      const wanted = need(step.fields, "fill: fields, each { name, value } (pdf_read lists the form's fields).");
      const widgets = new Map<string, Mupdf.PDFWidget[]>();
      for (let i = 0; i < count; i++) for (const w of doc.loadPage(i).getWidgets()) widgets.set(w.getName(), [...(widgets.get(w.getName()) ?? []), w]);
      const unknown: string[] = [];
      for (const f of wanted) {
        const ws = widgets.get(f.name);
        if (!ws) {
          unknown.push(f.name);
          continue;
        }
        const w = ws[0];
        if (w.isReadOnly()) throw new ToolError(`fill: ${f.name} is read-only.`);
        const type = w.getFieldType();
        if (type === "checkbox") {
          const on = /^(true|yes|on|1|x|checked|tick)$/i.test(f.value.trim());
          for (const box of ws) {
            const isOn = !["", "Off"].includes(box.getValue());
            if (isOn !== on) box.toggle();
            box.update();
          }
        } else if (type === "radiobutton") {
          const states = (box: Mupdf.PDFWidget) => {
            const out: string[] = [];
            const n = box.getObject().get("AP").get("N");
            if (n.isDictionary()) n.forEach((_v, k) => void (k !== "Off" && out.push(String(k))));
            return out;
          };
          const pick = ws.find((box) => states(box).some((s) => s.toLowerCase() === f.value.trim().toLowerCase()));
          if (!pick) throw new ToolError(`fill: ${f.name} is one of ${[...new Set(ws.flatMap(states))].join(", ")}.`);
          if (["", "Off"].includes(pick.getValue()) || !states(pick).includes(pick.getValue())) pick.toggle();
          for (const box of ws) box.update();
        } else if (type === "combobox" || type === "listbox") {
          const options = w.getOptions();
          if (!options.includes(f.value) && !(type === "combobox" && w.getFieldFlags() & m.PDFWidget.CH_FIELD_IS_EDIT)) {
            throw new ToolError(`fill: ${f.name} takes one of ${options.slice(0, 40).join(", ")}.`);
          }
          w.setChoiceValue(f.value);
          w.update();
        } else if (type === "text") {
          const max = w.getMaxLen();
          if (max > 0 && f.value.length > max) throw new ToolError(`fill: ${f.name} takes at most ${max} characters.`);
          w.setTextValue(f.value);
          w.update();
        } else {
          throw new ToolError(`fill: ${f.name} is a ${type} field, which can't be filled.`);
        }
      }
      if (unknown.length) throw new ToolError(`fill: no field named ${unknown.map((n) => `"${n}"`).join(", ")}${widgets.size ? `. The fields: ${[...widgets.keys()].slice(0, 60).join(", ")}.` : "; this PDF has no form fields (to write on it anyway, use text with a box)."}`);
      return;
    }

    case "flatten": {
      // Form fields and comments become part of the page: they print and show everywhere,
      // and can't be changed any more.
      doc.bake(true, true);
      return;
    }

    case "meta": {
      const set: [string, string | undefined][] = [
        ["Title", step.title],
        ["Author", step.author],
        ["Subject", step.subject],
        ["Keywords", step.keywords],
      ];
      if (!set.some(([, v]) => v !== undefined)) throw new ToolError("meta: title, author, subject and/or keywords.");
      for (const [k, v] of set) if (v !== undefined) doc.setMetaData(`info:${k}`, v);
      return;
    }
  }
}

const PASSWORD = /^[^,\s\u0000-\u001f]{1,64}$/;

export const pdfEdit = defineTool({
  name: "pdf_edit",
  label: "Edit PDF",
  description: [
    "Make a new PDF from one (pdf: asset:<id> or a public https URL) or from nothing (leave pdf out and start with insert or html), in steps run in order; the original is never changed.",
    "Positions are points from the page's top-left (pdf_read's sizes and layout boxes); pages: 1-based (1, 2-5, 4-, last, odd, even, lists), default all.",
    "STEPS (op): pages (keep these, in this order; repeats copy) · delete (pages) · rotate (pages, degrees: 90 clockwise, -90, 180) · crop (pages, box to keep).",
    "insert at a position (at, 1-based; default the end): refs = PDFs (asset:<id>, their pages: pages) and/or pictures (chat:<n>, asset:<id>; one per page, size a4 default with margin 18, or image = the page takes the picture's shape); no refs = blank pages (count, size).",
    "html: HTML and CSS laid out as new pages (size, default a4; margin pt, default 40; at): invoices, price lists, letters, tables, with <img src=\"asset:<id>|chat:<n>|https…\">.",
    "text: html on pages (pages; box, or position top-left|top|top-right|centre|bottom-left|bottom|bottom-right|diagonal, margin default 28; fontSize pt; font = a family added with video_assets add_font; colour; opacity; angle; {page} and {pages} become numbers): page numbers, headers, footers, stamps, watermarks (diagonal: big, grey, see-through).",
    "image: a picture on pages (ref; box, or position + width pt; opacity): logos, signatures, seals.",
    "redact: really removes text (find) and/or areas (boxes with page), black boxes or fill white. replace: { find, to } pairs, in the same place, size and colour (similar font). mark: find or boxes, style highlight|underline|strike, colour.",
    "fill: form fields { name, value } (checkboxes true/false; radios and lists take one of their options). flatten: fields and comments become part of the page. meta: title, author, subject, keywords.",
    "OUTPUT: a PDF asset by default (lock: a password to open it; unlock: save without the password it was opened with); split: page lists, each its own PDF ([\"each\"] = one per page);",
    "as png|jpeg: pictures of pages (pages, dpi default 150) as image assets. You see the first pages of the result (look: other pages); check it before calling it done.",
  ].join(" "),
  parameters: Type.Object({
    pdf: optional(Type.String()),
    password: optional(Type.String({ maxLength: 128 })),
    steps: Type.Array(Step, { maxItems: 40 }),
    name: optional(Type.String({ maxLength: 120 })),
    as: optional(StringEnum(["pdf", "png", "jpeg"])),
    pages: optional(Type.String({ maxLength: 400 })),
    dpi: optional(Type.Integer({ minimum: 36, maximum: 400 })),
    split: optional(Type.Array(Type.String({ maxLength: 400 }), { minItems: 1, maxItems: 100 })),
    lock: optional(Type.String({ maxLength: 64 })),
    unlock: optional(Type.Boolean()),
    look: optional(Type.String({ maxLength: 100 })),
  }),
  kind: "read",
  summary: (a) => `${a.steps.map((s) => s.op).join(" → ") || "save"}${a.pdf ? ` on ${a.pdf}` : ""}${a.as && a.as !== "pdf" ? ` as ${a.as}` : ""}`,
  async execute(a, ctx) {
    if (!a.pdf && !a.steps.length) throw new ToolError("Which PDF (pdf), or what to make (steps)?");
    if (a.lock && !PASSWORD.test(a.lock)) throw new ToolError("lock: 1–64 characters, no spaces or commas.");
    if (a.lock && a.unlock) throw new ToolError("Either lock or unlock.");
    const m = await mupdf();
    const src = a.pdf ? await pdfOf(a.pdf, ctx) : null;
    const opened = src ? openPdf(m, src, a.password) : { doc: new m.PDFDocument(), locked: false };
    const run: Run = { m, doc: opened.doc, ctx, notes: [] };
    if (opened.locked && !a.lock && !a.unlock) {
      if (!a.password || !PASSWORD.test(a.password)) throw new ToolError("This PDF's password can't be put back on the copy: pass lock with a new one, or unlock.");
    }

    try {
      for (const [n, step] of a.steps.entries()) {
        ctx.progress(`${step.op} (${n + 1} of ${a.steps.length})…`);
        try {
          await runStep(step, run);
        } catch (e) {
          if (e instanceof ToolError || e instanceof MediaError) throw new ToolError(`Step ${n + 1} (${step.op}): ${e.message}`);
          throw new ToolError(`Step ${n + 1} (${step.op}) failed in MuPDF: ${msg(e)}`);
        }
      }
      const doc = run.doc;
      const count = doc.countPages();
      if (!count) throw new ToolError("The result has no pages.");
      const base = a.name ?? (src ? `${src.name.replace(/\.pdf$/i, "")} edited` : "document");
      const source = src ? "edited" : "generated";
      const meta = { from: src?.ref ?? null, steps: a.steps.map((s) => s.op) };
      const results: Record<string, unknown>[] = [];
      const images: ImageContent[] = [];

      if (a.as === "png" || a.as === "jpeg") {
        const dpi = a.dpi ?? 150;
        const pages = pagesOf(a.pages, count);
        if (pages.length > 60) throw new ToolError(`${pages.length} pictures is too many at once; 60 at most (pages).`);
        for (const i of pages) {
          ctx.progress(`Picture of page ${i + 1}…`);
          const page = doc.loadPage(i);
          const [x0, y0, x1, y1] = page.getBounds();
          const s = Math.min(dpi / 72, 8000 / Math.max(x1 - x0, y1 - y0));
          const pix = page.toPixmap(m.Matrix.scale(s, s), m.ColorSpace.DeviceRGB, false, true);
          const bytes = Buffer.from(a.as === "png" ? pix.asPNG() : pix.asJPEG(90));
          const row = await saveAsset({ bytes, mime: a.as === "png" ? "image/png" : "image/jpeg", name: `${base} p${i + 1}`, source: "edited", chatId: ctx.chatId, userId: ctx.user.id, meta: { ...meta, page: i + 1, dpi } });
          results.push({ page: i + 1, ...assetSummary(row), kb: Math.round(bytes.length / 1024) });
          if (images.length < 6) images.push(jpegBlock(pageJpeg(m, page, 1200)));
        }
        return { data: { pictures: results, ...(run.notes.length ? { notes: run.notes } : {}) }, images };
      }

      const password = a.lock ?? (opened.locked && !a.unlock ? a.password : undefined);
      // garbage=2, not 3: merging look-alike objects mixes up the fonts and forms drawn on top.
      const options = ["garbage=2", "compress", ...(password ? ["encrypt=aes-256", `user-password=${password}`, `owner-password=${password}`] : ["encrypt=none"])].join(",");
      const parts = a.split ? (a.split.length === 1 && a.split[0].trim().toLowerCase() === "each" ? Array.from({ length: count }, (_, i) => String(i + 1)) : a.split) : null;
      if (parts && parts.length > 100) throw new ToolError(`That's ${parts.length} PDFs; split into 100 at most.`);

      const save = async (d: Mupdf.PDFDocument, name: string, label: string | null) => {
        const bytes = Buffer.from(d.saveToBuffer(options).asUint8Array());
        const pages = d.countPages();
        const row: AssetRow = await saveAsset({ bytes, mime: "application/pdf", name, source, chatId: ctx.chatId, userId: ctx.user.id, meta: { ...meta, pages, ...(label ? { split: label } : {}) } });
        results.push({ ...assetSummary(row), kb: Math.round(bytes.length / 1024), ...(password ? { locked: true } : {}) });
      };

      if (parts) {
        for (const spec of parts) {
          ctx.progress(`Saving pages ${spec}…`);
          const part = new m.PDFDocument();
          const map = part.newGraftMap();
          for (const i of pagesOf(spec, count, "split")) map.graftPage(-1, doc, i);
          await save(part, `${base} (${spec.replace(/\s+/g, "")})`, spec);
        }
      } else {
        ctx.progress("Saving…");
        await save(doc, base, null);
      }

      // What the first result looks like (or the pages asked for), to check before saying it's done.
      for (const i of pagesOf(a.look ?? `1-${Math.min(2, count)}`, count, "look").slice(0, 6)) images.push(jpegBlock(pageJpeg(m, doc.loadPage(i), 1200)));
      return {
        data: { ...(results.length === 1 ? results[0] : { pdfs: results }), pages: count, ...(run.notes.length ? { notes: run.notes } : {}) },
        images,
      };
    } finally {
      run.doc.destroy();
      if (run.doc !== opened.doc) opened.doc.destroy();
    }
  },
});
