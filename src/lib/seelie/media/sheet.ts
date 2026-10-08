import "server-only";

/**
 * A contact sheet: frames of a video side by side in one picture, each labelled with its
 * scene and time, so the owner and the model see the whole piece at a glance (and small
 * text at a size Gemini's 1-frame-a-second look at a small copy would miss).
 */
export async function contactSheet(frames: { image: Buffer; label: string }[], opts: { cellWidth?: number; columns?: number } = {}): Promise<Buffer> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const images = await Promise.all(frames.map((f) => loadImage(f.image)));
  const cellWidth = opts.cellWidth ?? 300;
  const columns = Math.max(1, Math.min(opts.columns ?? 6, frames.length));
  const ratio = images.length ? images[0].height / images[0].width : 16 / 9;
  const cellHeight = Math.round(cellWidth * ratio);
  const label = 34;
  const gap = 8;
  const rows = Math.ceil(frames.length / columns);
  const canvas = createCanvas(columns * cellWidth + (columns + 1) * gap, rows * (cellHeight + label) + (rows + 1) * gap);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#1c1216";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textBaseline = "middle";
  ctx.font = "600 17px sans-serif";
  images.forEach((img, i) => {
    const x = gap + (i % columns) * (cellWidth + gap);
    const y = gap + Math.floor(i / columns) * (cellHeight + label + gap);
    // Cover the cell, whatever the frame's shape.
    const scale = Math.max(cellWidth / img.width, cellHeight / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, cellWidth, cellHeight);
    ctx.clip();
    ctx.drawImage(img, x + (cellWidth - w) / 2, y + (cellHeight - h) / 2, w, h);
    ctx.restore();
    ctx.fillStyle = "#f4e6ea";
    ctx.fillText(frames[i].label.slice(0, 32), x + 6, y + cellHeight + label / 2, cellWidth - 12);
  });
  return canvas.encode("jpeg", 82);
}
