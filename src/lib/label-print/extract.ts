/** Text of every page, in order. Empty string for a page with no text layer. */
export async function extractPageTexts(data: Uint8Array): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const doc = await pdfjs.getDocument({
    // pdfjs transfers the buffer it is handed; give it its own copy.
    data: data.slice(),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
    // Missing standard-font data only affects rendering, which we never do.
    verbosity: 0,
  }).promise;

  const texts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    texts.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
    page.cleanup();
  }
  await doc.destroy();
  return texts;
}

/** Where a picture sits on its page, as fractions of the page from its top-left. */
export interface ImageBox {
  left: number;
  top: number;
  width: number;
  height: number;
  /**
   * The blank band between the customer-declaration table and the routing box,
   * where the product stamp goes, as top/bottom fractions of the picture.
   * Found from the pixels because carriers lay the label out differently.
   */
  gap?: { top: number; bottom: number };
}

interface Decoded {
  width: number;
  height: number;
  kind: number; // pdfjs ImageKind: 1 = 1-bit gray, 2 = RGB, 3 = RGBA
  data: Uint8Array | Uint8ClampedArray;
}

/** Longest blank run of rows between 55% and 95% of the picture's height. */
function findStampGap(img: Decoded): { top: number; bottom: number } | null {
  const { width: w, height: h, kind, data } = img;

  // Whether a pixel is ink (dark), for each pixel layout pdfjs can hand back.
  let dark: (x: number, y: number) => boolean;
  if (kind === 1) {
    const stride = Math.ceil(w / 8);
    const bit = (x: number, y: number) => (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1;
    // Labels are mostly paper, so whichever value is rarer is the ink.
    let ones = 0;
    for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) ones += bit(x, y);
    const inkBit = ones < (Math.ceil(h / 4) * Math.ceil(w / 4)) / 2 ? 1 : 0;
    dark = (x, y) => bit(x, y) === inkBit;
  } else {
    const step = kind === 3 ? 4 : 3;
    dark = (x, y) => {
      const i = (y * w + x) * step;
      return (data[i] + data[i + 1] + data[i + 2]) / 3 < 128;
    };
  }

  // Inner columns only, so a frame's side bars do not make every row look inked.
  const x0 = Math.floor(w * 0.1);
  const x1 = Math.floor(w * 0.9);
  const blank = (y: number) => {
    let n = 0;
    for (let x = x0; x < x1; x++) if (dark(x, y)) n++;
    return n / (x1 - x0) < 0.004;
  };

  let best: [number, number] | null = null;
  let start = -1;
  const lo = Math.floor(h * 0.55);
  const hi = Math.floor(h * 0.95);
  for (let y = lo; y <= hi; y++) {
    const on = y < hi && blank(y);
    if (on && start < 0) start = y;
    if (!on && start >= 0) {
      if (!best || y - start > best[1] - best[0]) best = [start, y];
      start = -1;
    }
  }
  if (!best || best[1] - best[0] < h * 0.04) return null;
  return { top: best[0] / h, bottom: best[1] / h };
}

type Matrix = [number, number, number, number, number, number];
const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/**
 * The largest picture on each requested page (0-based), with where it is drawn.
 * Read from the page's drawing operators, following nested transforms, so it is
 * right whether the picture fills the page, is inset, or lives in a form.
 */
export async function extractImageBoxes(data: Uint8Array, pageIndexes: number[]): Promise<Map<number, ImageBox>> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { OPS } = pdfjs;
  const doc = await pdfjs.getDocument({
    data: data.slice(),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
    verbosity: 0,
  }).promise;

  const out = new Map<number, ImageBox>();
  for (const index of pageIndexes) {
    const page = await doc.getPage(index + 1);
    const [vx0, vy0, vx1, vy1] = page.view;
    const W = vx1 - vx0;
    const H = vy1 - vy0;
    const { fnArray, argsArray } = await page.getOperatorList();

    let ctm: Matrix = [1, 0, 0, 1, 0, 0];
    const stack: Matrix[] = [];
    let best: { area: number; box: ImageBox; id: string | null } | null = null;

    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      const args = argsArray[i];
      if (fn === OPS.save) stack.push(ctm);
      else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.transform) ctm = mul(ctm, args as Matrix);
      else if (fn === OPS.paintFormXObjectBegin) {
        stack.push(ctm);
        if (args?.[0]) ctm = mul(ctm, args[0] as Matrix);
      } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
      else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
        const xs = [0, 1].flatMap((u) => [0, 1].map((v) => ctm[0] * u + ctm[2] * v + ctm[4]));
        const ys = [0, 1].flatMap((u) => [0, 1].map((v) => ctm[1] * u + ctm[3] * v + ctm[5]));
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        const area = (maxX - minX) * (maxY - minY);
        if (!best || area > best.area) {
          best = {
            area,
            id: fn === OPS.paintImageXObject && typeof args?.[0] === "string" ? args[0] : null,
            box: { left: (minX - vx0) / W, top: (vy1 - maxY) / H, width: (maxX - minX) / W, height: (maxY - minY) / H },
          };
        }
      }
    }
    if (best) {
      const found: { area: number; box: ImageBox; id: string | null } = best;
      // The picture's pixels, decoded by pdfjs whatever its compression.
      try {
        const img = found.id && page.objs.has(found.id) ? (page.objs.get(found.id) as Decoded | null) : null;
        const gap = img?.data ? findStampGap(img) : null;
        if (gap) found.box.gap = gap;
      } catch {
        // No gap: the platform's default stamp position is used.
      }
      out.set(index, found.box);
    }
    page.cleanup();
  }
  await doc.destroy();
  return out;
}
