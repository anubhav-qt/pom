import { PDFDocument, PDFName, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import { stripLabelFrame } from "./clean";
import type { LabelRef, Platform, ProductLine, SourceFile } from "./types";

export interface ComposeOptions {
  /** Output sheet size in points. Defaults to A4 portrait. */
  sheet?: { width: number; height: number };
  /** Blank border around the whole sheet, in points. Zero keeps quarters exact. */
  margin?: number;
  /** Faint cut guides between the four cells. Off by default: the paper is pre-cut. */
  cutGuides?: boolean;
  /** Print the product name / size / colour on each label. */
  stamp?: boolean;
}

const A4 = { width: 595.28, height: 841.89 };

/**
 * Fallback stamp position per platform (fractions of the source page from its
 * top-left, plus the largest font in source points), used only when the
 * label's own blank space could not be measured (see index.ts). Flipkart is
 * never stamped.
 */
const STAMP_BOX: Partial<Record<Platform, { x: number; y: number; w: number; h: number; font: number }>> = {
  amazon: { x: 0.085, y: 0.775, w: 0.86, h: 0.072, font: 17 },
  meesho: { x: 0.03, y: 0.72, w: 0.94, h: 0.1, font: 20 },
};

/** Standard PDF fonts only cover Latin-1; swap the common look-alikes, blank the rest. */
function printable(s: string) {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

/** Amazon ids are 3-7-7 digits; show them the way they are printed on the label. */
function prettyOrderId(id: string) {
  return /^\d{17}$/.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 10)}-${id.slice(10)}` : id;
}

function fit(font: PDFFont, text: string, size: number, maxWidth: number, minSize: number) {
  let s = size;
  while (s > minSize && font.widthOfTextAtSize(text, s) > maxWidth) s -= 0.5;
  if (font.widthOfTextAtSize(text, s) <= maxWidth) return { text, size: s };
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, s) > maxWidth) t = t.slice(0, -1);
  return { text: `${t.trimEnd()}...`, size: s };
}

/**
 * Name on its own first line, then "Size: x" and "Color: y" each on their own
 * line. Every line is left-aligned at the same x so a stack of labels reads
 * uniformly. The name shrinks (then truncates) rather than wrapping, so it
 * always stays a single line.
 */
function drawStamp(
  page: PDFPage,
  font: PDFFont,
  products: ProductLine[],
  orderId: string | null,
  box: { x: number; y: number; w: number; h: number; font: number },
  cell: { x: number; y: number; w: number; h: number; scale: number },
) {
  const bx = cell.x + box.x * cell.w;
  const bw = box.w * cell.w;
  const bh = box.h * cell.h;
  const top = cell.y + cell.h - box.y * cell.h;

  // Several products on one invoice share the box: shrink to fit all of them.
  const lines = products.length * 3;
  const base = Math.min(box.font * cell.scale, bh / (lines * 1.18));
  const min = base * 0.6;

  let y = top;
  for (const p of products) {
    const name = fit(font, printable(p.name), base, bw, min);
    // When size or colour could not be read, the order id goes right beside the
    // dash, so whoever has to look the order up never has to look away. If both
    // are missing it is printed once, on the colour line.
    const tag = orderId ? ` | ${prettyOrderId(orderId)}` : "";
    const sizeMissing = p.size === "-";
    const colorMissing = p.color === "-";
    const sizeLine = `Size: ${printable(p.size)}${sizeMissing && !colorMissing ? tag : ""}`;
    const colorLine = `Color: ${printable(p.color)}${colorMissing ? tag : ""}`;
    for (const [text, size] of [
      [name.text, name.size],
      [sizeLine, base],
      [colorLine, base],
    ] as const) {
      y -= size * 1.18;
      page.drawText(text, { x: bx, y: y + size * 0.2, size, font, color: rgb(0, 0, 0) });
    }
  }
}

/**
 * Lay labels out four to a sheet (2 x 2, left-to-right then top-to-bottom).
 *
 * The sheet is divided into four exact quarters and each page is scaled
 * uniformly to fit its quarter (an A4 source lands at exactly 50%, an A6),
 * which matches a printer's own "4 pages per sheet" and pre-cut four-up sticker
 * stock. The last sheet is simply left partly empty.
 */
export async function composeFourUp(
  files: SourceFile[],
  labels: LabelRef[],
  { sheet = A4, margin = 0, cutGuides = false, stamp = true }: ComposeOptions = {},
): Promise<{ pdf: Uint8Array; sheets: number; framesRemoved: number }> {
  const out = await PDFDocument.create();
  // Ask the viewer to print at 100%. Without this some viewers default to "fit
  // to page" and shrink the sheet by a few percent, which throws the quarters
  // off the pre-cut stickers.
  out.catalog.set(PDFName.of("ViewerPreferences"), out.context.obj({ PrintScaling: "None" }));
  out.setTitle("Label sheet");
  const font = await out.embedFont(StandardFonts.HelveticaBold);

  // Load each source once and embed just the pages that are used.
  const sources = new Map<number, PDFDocument>();
  const embedded = new Map<string, Awaited<ReturnType<PDFDocument["embedPage"]>>>();
  let framesRemoved = 0;
  for (const ref of labels) {
    const key = `${ref.fileIndex}:${ref.pageIndex}`;
    if (embedded.has(key)) continue;
    let src = sources.get(ref.fileIndex);
    if (!src) {
      src = await PDFDocument.load(files[ref.fileIndex].data, { ignoreEncryption: true });
      sources.set(ref.fileIndex, src);
    }
    const page = src.getPage(ref.pageIndex);
    if (ref.platform !== "flipkart" && stripLabelFrame(src, page)) framesRemoved++;
    let bounds: { left: number; bottom: number; right: number; top: number } | undefined;
    if (ref.crop) {
      const { x, y, width, height } = page.getMediaBox();
      bounds = {
        left: x + ref.crop.x * width,
        right: x + (ref.crop.x + ref.crop.w) * width,
        top: y + height - ref.crop.y * height,
        bottom: y + height - (ref.crop.y + ref.crop.h) * height,
      };
    }
    embedded.set(key, await out.embedPage(page, bounds));
  }

  const cellW = (sheet.width - margin * 2) / 2;
  const cellH = (sheet.height - margin * 2) / 2;
  const sheets = Math.ceil(labels.length / 4);

  for (let s = 0; s < sheets; s++) {
    const page = out.addPage([sheet.width, sheet.height]);

    for (let slot = 0; slot < 4; slot++) {
      const ref = labels[s * 4 + slot];
      if (!ref) break;
      const emb = embedded.get(`${ref.fileIndex}:${ref.pageIndex}`)!;

      const scale = Math.min(cellW / emb.width, cellH / emb.height);
      const w = emb.width * scale;
      const h = emb.height * scale;
      const col = slot % 2;
      const row = Math.floor(slot / 2);
      // PDF origin is bottom-left; row 0 is the top of the sheet.
      const x = margin + col * cellW + (cellW - w) / 2;
      const y = sheet.height - margin - (row + 1) * cellH + (cellH - h) / 2;
      page.drawPage(emb, { x, y, width: w, height: h });

      const fallback = STAMP_BOX[ref.platform];
      const measured = ref.stampArea && ref.platform !== "flipkart" ? ref.stampArea : null;
      // A measured band is padded a little so the text never touches the table
      // above it or the routing box below it.
      const box = measured
        ? {
            ...measured,
            y: measured.y + measured.h * 0.06,
            h: measured.h * 0.88,
            font: fallback?.font ?? 17,
          }
        : fallback;
      if (stamp && ref.platform !== "flipkart" && box && ref.products.length > 0) {
        drawStamp(page, font, ref.products, ref.orderId, box, { x, y, w, h, scale });
      }
    }

    if (cutGuides) {
      const line = { thickness: 0.4, color: rgb(0.75, 0.75, 0.75), dashArray: [3, 3] };
      page.drawLine({ start: { x: sheet.width / 2, y: margin }, end: { x: sheet.width / 2, y: sheet.height - margin }, ...line });
      page.drawLine({ start: { x: margin, y: sheet.height / 2 }, end: { x: sheet.width - margin, y: sheet.height / 2 }, ...line });
    }
  }

  return { pdf: await out.save(), sheets, framesRemoved };
}
