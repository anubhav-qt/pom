import { inflateSync, deflateSync } from "zlib";

import {
  PDFDict,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  type PDFDocument,
  type PDFPage,
} from "pdf-lib";

/**
 * Some carriers' Amazon labels (the "RSH" ones) are printed inside a thick
 * black frame that is baked into the label picture, a couple of pixels from
 * the address text, so it cannot be cropped off. This whites the frame out in
 * the picture itself and leaves everything else alone.
 *
 * A frame is recognised by shape, not by carrier: rows near the top or bottom
 * edge that are almost all ink, and columns near the left or right edge that
 * are ink for most of the label's height. Labels without one are untouched.
 */

const ROW_INK = 0.85; // a bar row is ink across this much of the width
const COL_INK = 0.8; // a bar column is ink over this much of the height
const EDGE_ZONE = 0.2; // bars are only looked for this close to an edge
const MAX_BAR = 40; // px; anything thicker is a solid block, not a frame

/** Every 1-bit image reachable from the page, with the ref to write it back to. */
function findImages(resources: PDFDict | undefined, depth = 0) {
  const found: { ref: PDFRef; stream: PDFRawStream }[] = [];
  const xobjects = resources?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (!xobjects || depth > 3) return found;

  for (const key of xobjects.keys()) {
    const ref = xobjects.get(key);
    const obj = xobjects.lookup(key);
    if (!(obj instanceof PDFRawStream) || !(ref instanceof PDFRef)) continue;
    const subtype = obj.dict.get(PDFName.of("Subtype"));
    if (subtype === PDFName.of("Image")) found.push({ ref, stream: obj });
    else if (subtype === PDFName.of("Form")) found.push(...findImages(obj.dict.lookupMaybe(PDFName.of("Resources"), PDFDict), depth + 1));
  }
  return found;
}

/**
 * Undo PNG row filtering (PDF Predictor 10-15). Rows arrive as one filter-type
 * byte plus `stride` data bytes; 1-bit images have a 1-byte pixel step.
 */
function pngUnfilter(data: Buffer, stride: number, h: number): Buffer {
  const out = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const type = data[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const left = i > 0 ? out[dst + i - 1] : 0;
      const up = y > 0 ? out[dst - stride + i] : 0;
      const upLeft = y > 0 && i > 0 ? out[dst - stride + i - 1] : 0;
      let v = data[src + i];
      if (type === 1) v += left;
      else if (type === 2) v += up;
      else if (type === 3) v += (left + up) >> 1;
      else if (type === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[dst + i] = v & 255;
    }
  }
  return out;
}

/** Prefix every row with filter type 0. */
function pngUnfiltered(raw: Buffer, stride: number, h: number): Buffer {
  const out = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) raw.copy(out, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return out;
}

const num = (s: PDFStream, key: string) => Number(String(s.dict.get(PDFName.of(key))));

/** Returns true if a frame was found and removed. */
export function stripLabelFrame(doc: PDFDocument, page: PDFPage): boolean {
  let changed = false;

  for (const { ref, stream } of findImages(page.node.Resources())) {
    const filter = String(stream.dict.get(PDFName.of("Filter")));
    if (filter !== "/FlateDecode" || num(stream, "BitsPerComponent") !== 1) continue;
    const w = num(stream, "Width");
    const h = num(stream, "Height");
    if (!w || !h) continue;

    const stride = Math.ceil(w / 8);
    const parms = stream.dict.lookupMaybe(PDFName.of("DecodeParms"), PDFDict);
    const predictor = parms ? Number(String(parms.get(PDFName.of("Predictor")) ?? 1)) : 1;
    if (predictor !== 1 && predictor < 10) continue; // TIFF predictor: not handled

    let raw: Buffer;
    try {
      const inflated = inflateSync(Buffer.from(stream.contents));
      raw = predictor >= 10 ? pngUnfilter(inflated, stride, h) : inflated;
    } catch {
      continue;
    }
    if (raw.length < stride * h) continue;

    const bit = (x: number, y: number) => (raw[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1;

    // Labels are mostly paper, so whichever bit value is rarer is the ink.
    let ones = 0;
    for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) ones += bit(x, y);
    const total = Math.ceil(h / 4) * Math.ceil(w / 4);
    const inkBit = ones < total / 2 ? 1 : 0;

    const rowInk = (y: number) => {
      let n = 0;
      for (let x = 0; x < w; x++) if (bit(x, y) === inkBit) n++;
      return n / w;
    };
    const colInk = (x: number) => {
      let n = 0;
      for (let y = 0; y < h; y++) if (bit(x, y) === inkBit) n++;
      return n / h;
    };

    // Runs of qualifying lines inside the edge zone, kept only if thin enough
    // to be a frame line rather than a black block.
    const bars = (len: number, ink: (i: number) => number, min: number) => {
      const zone = Math.floor(len * EDGE_ZONE);
      const runs: [number, number][] = [];
      for (const [lo, hi] of [[0, zone], [len - zone, len]] as const) {
        let start = -1;
        for (let i = lo; i <= hi; i++) {
          const on = i < hi && ink(i) >= min;
          if (on && start < 0) start = i;
          if (!on && start >= 0) {
            if (i - start <= MAX_BAR) runs.push([start, i - 1]);
            start = -1;
          }
        }
      }
      return runs;
    };

    const rows = bars(h, rowInk, ROW_INK);
    const cols = bars(w, colInk, COL_INK);
    if (rows.length === 0 && cols.length === 0) continue;

    const paper = inkBit ^ 1;
    const setPaper = (x: number, y: number) => {
      const i = y * stride + (x >> 3);
      const mask = 1 << (7 - (x & 7));
      raw[i] = paper ? raw[i] | mask : raw[i] & ~mask;
    };
    // One pixel of margin each side catches the ragged edge of the bar.
    for (const [a, b] of rows) {
      for (let y = Math.max(0, a - 1); y <= Math.min(h - 1, b + 1); y++) for (let x = 0; x < w; x++) setPaper(x, y);
    }
    for (const [a, b] of cols) {
      for (let x = Math.max(0, a - 1); x <= Math.min(w - 1, b + 1); x++) for (let y = 0; y < h; y++) setPaper(x, y);
    }

    // Written back with filter type 0 ("none") on every row, which any
    // predictor-15 reader accepts, so there is no need to re-filter.
    const encoded = predictor >= 10 ? pngUnfiltered(raw, stride, h) : raw;
    doc.context.assign(ref, PDFRawStream.of(stream.dict, deflateSync(encoded)));
    changed = true;
  }
  return changed;
}
