/**
 * Turn a self-contained SVG string into a downloadable JPEG or PDF, entirely in
 * the browser. The SVG is pure `<rect>`/`<text>` (no <img>, no foreignObject),
 * so rasterising it to a canvas never taints it and `toBlob` works. PDF reuses
 * the same raster and wraps it with `pdf-lib` (already a dependency).
 */

export function svgEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function svgToCanvas(svg: string, scale = 2): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("Canvas is not available in this browser."));
        return;
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not render the sheet."));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the image."))), type, quality);
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Render `svg` and hand the viewer a `<basename>.jpg` or `<basename>.pdf`. */
export async function exportSvg(svg: string, kind: "jpeg" | "pdf", basename: string): Promise<void> {
  const canvas = await svgToCanvas(svg, 2);
  if (kind === "jpeg") {
    downloadBlob(await canvasToBlob(canvas, "image/jpeg", 0.95), `${basename}.jpg`);
    return;
  }
  const pngBlob = await canvasToBlob(canvas, "image/png");
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const png = await pdf.embedPng(await pngBlob.arrayBuffer());
  const page = pdf.addPage([png.width, png.height]);
  page.drawImage(png, { x: 0, y: 0, width: png.width, height: png.height });
  const bytes = await pdf.save();
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  downloadBlob(new Blob([buf], { type: "application/pdf" }), `${basename}.pdf`);
}
