import { createCanvas, loadImage, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { spawn } from "node:child_process";

import { ffmpegPath } from "./ffmpeg";
import type { Enter, PhotoPlan, PlannedShot } from "./plan";
import { FRAME_SIZE, type ReelLayout } from "./types";

/**
 * Draws a photo reel frame by frame and pipes the frames into ffmpeg, which
 * encodes them and lays the song under them.
 *
 * Frames are drawn here rather than with ffmpeg's own filters because the
 * moves need to be smooth and exact: ffmpeg's zoompan snaps to whole pixels
 * (a slow zoom visibly shivers), and the transitions have to start or finish
 * precisely on a beat. A canvas draws at sub-pixel positions, and every frame
 * is a pure function of its time, so what the plan says is what plays.
 */

export const FPS = 30;
/** Photos are prepared this much larger than the frame, so a zoom never upsamples. */
const OVERSCAN = 1.15;

type Frame = { width: number; height: number };

/* -------------------------------------------------------------------------- */
/* Easing                                                                     */
/* -------------------------------------------------------------------------- */

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeInOutSine = (x: number) => -(Math.cos(Math.PI * clamp01(x)) - 1) / 2;
const easeOutCubic = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);
const easeInCubic = (x: number) => Math.pow(clamp01(x), 3);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** How long each entrance takes, before the beat (`pre`) and after it (`post`). */
const TIMING: Record<Enter, { pre: number; post: number }> = {
  open: { pre: 0, post: 0.35 },
  cut: { pre: 0, post: 0 },
  punch: { pre: 0, post: 0.24 },
  flash: { pre: 0, post: 0.22 },
  whip: { pre: 0.13, post: 0.07 },
  fade: { pre: 0.3, post: 0 },
};

/* -------------------------------------------------------------------------- */
/* Plates: each photo prepared once at frame shape                            */
/* -------------------------------------------------------------------------- */

type Image = Awaited<ReturnType<typeof loadImage>>;
type Side = "top" | "bottom" | "left" | "right";

/** Samples taken along an edge. */
const EDGE_SAMPLES = 160;
/** Colour change per sample (RGB distance) that counts as an edge in the picture rather than shading. */
const STEP = 6;
/** A run this far (RGB distance) from the backdrop around it is not backdrop: an outfit, an arm, a foot. */
const OFF_BACKDROP = 22;
/** The two ends of an edge can be different surfaces (wall and floor), but not this different. */
const SAME_SET = 70;

/**
 * An edge is studio backdrop, and is carried outward, when most of it is
 * backdrop, or when a good part is and both its corners are (the outfit runs
 * through the middle of the edge, as trousers cut at the waist do).
 */
const isStudio = (e: { backdrop: number; corners: boolean }) => e.backdrop >= 0.6 || (e.backdrop >= 0.3 && e.corners);

const dist = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
const meanOf = (xs: number[][]) => [0, 1, 2].map((k) => xs.reduce((sum, p) => sum + p[k], 0) / xs.length);

/**
 * One edge of a photo as a line of colours (the outer ~1% averaged), with the
 * parts that are not backdrop filled in from the backdrop either side.
 *
 * The edge is split into runs of gently changing colour, separated by sharp
 * changes. A studio wall shades gradually (one run, however vignetted); where
 * a wall meets the floor, or an outfit or a hand crosses the edge, the colour
 * jumps. The runs that reach the corners are the set (wall, floor); a run in
 * between that does not match the set around it is the outfit, and is left
 * out. `backdrop` is the share of the edge that is set.
 */
function edgeLine(img: Image, side: Side): { line: Canvas; backdrop: number; corners: boolean; median: number[] } {
  const N = EDGE_SAMPLES;
  const along = side === "top" || side === "bottom";
  const depth = Math.max(2, Math.round((along ? img.height : img.width) * 0.01));
  const c = createCanvas(along ? N : 3, along ? 3 : N);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  if (side === "top") ctx.drawImage(img, 0, 0, img.width, depth, 0, 0, N, 3);
  if (side === "bottom") ctx.drawImage(img, 0, img.height - depth, img.width, depth, 0, 0, N, 3);
  if (side === "left") ctx.drawImage(img, 0, 0, depth, img.height, 0, 0, 3, N);
  if (side === "right") ctx.drawImage(img, img.width - depth, 0, depth, img.height, 0, 0, 3, N);
  const { data } = ctx.getImageData(0, 0, c.width, c.height);

  // Average across the depth: one colour per sample.
  const px: number[][] = [];
  for (let i = 0; i < N; i++) {
    const rgb = [0, 0, 0];
    for (let d = 0; d < 3; d++) {
      const o = (along ? d * N + i : i * 3 + d) * 4;
      for (let k = 0; k < 3; k++) rgb[k] += data[o + k] / 3;
    }
    px.push(rgb);
  }
  const median = [0, 1, 2].map((k) => px.map((p) => p[k]).sort((a, b) => a - b)[N >> 1]);

  // Runs of gentle change; the samples where the colour jumps belong to none.
  const gentle = px.map((_, i) => dist(px[Math.max(0, i - 1)], px[Math.min(N - 1, i + 1)]) / 2 < STEP);
  const runs: { from: number; to: number; mean: number[] }[] = [];
  for (let i = 0; i < N; i++) {
    if (!gentle[i]) continue;
    let j = i;
    while (j + 1 < N && gentle[j + 1]) j++;
    runs.push({ from: i, to: j, mean: meanOf(px.slice(i, j + 1)) });
    i = j;
  }

  const set = px.map(() => false);
  const first = runs[0];
  const last = runs[runs.length - 1];
  const ends = [first, last].filter((r) => r && (r.from === 0 || r.to === N - 1));
  if (ends.length === 2 && ends[0] !== ends[1] && dist(ends[0].mean, ends[1].mean) > SAME_SET) {
    // The two ends are not one set: the longer is; the other is the outfit at a corner.
    ends.sort((a, b) => b.to - b.from - (a.to - a.from)).pop();
  }
  for (const r of ends) for (let i = r.from; i <= r.to; i++) set[i] = true;
  // Runs in between join the set when they match it (a noisy patch of wall).
  if (ends.length) {
    const a = first.from === 0 && set[0] ? px[first.to] : (ends[0].mean as number[]);
    const b = last.to === N - 1 && set[N - 1] ? px[last.from] : (ends[ends.length - 1].mean as number[]);
    const lo = first.to;
    const hi = last.from;
    for (const r of runs) {
      if (r === first || r === last) continue;
      const t = hi > lo ? ((r.from + r.to) / 2 - lo) / (hi - lo) : 0.5;
      const ref = [0, 1, 2].map((k) => a[k] + (b[k] - a[k]) * Math.min(1, Math.max(0, t)));
      if (dist(r.mean, ref) < OFF_BACKDROP) for (let i = r.from; i <= r.to; i++) set[i] = true;
    }
  }
  // Keep clear of the soft rim where an outfit meets the backdrop.
  const clear = set.map((v, i) => v && set.slice(Math.max(0, i - 2), i + 3).every(Boolean));

  // Fill everything else between the set samples either side of it.
  const out = new Uint8ClampedArray(N * 4);
  for (let i = 0; i < N; i++) {
    let rgb = px[i];
    if (!clear[i]) {
      let l = i - 1;
      while (l >= 0 && !clear[l]) l--;
      let r = i + 1;
      while (r < N && !clear[r]) r++;
      if (l >= 0 && r < N) rgb = [0, 1, 2].map((k) => px[l][k] + ((px[r][k] - px[l][k]) * (i - l)) / (r - l));
      else if (l >= 0) rgb = px[l];
      else if (r < N) rgb = px[r];
      else rgb = median;
    }
    out.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  }
  const line = createCanvas(along ? N : 1, along ? 1 : N);
  const lctx = line.getContext("2d");
  const imgData = lctx.createImageData(line.width, line.height);
  imgData.data.set(out);
  lctx.putImageData(imgData, 0, 0);
  const tip = Math.round(N * 0.1);
  const corners = set.slice(0, tip).every(Boolean) && set.slice(N - tip).every(Boolean);
  return { line, backdrop: set.filter(Boolean).length / N, corners, median };
}

const css = (rgb: number[]) => `rgb(${rgb.map((v) => Math.round(v)).join(",")})`;

/**
 * The whole photo, fitted to a `w`×`h` frame and centred: nothing is cropped.
 * The empty bands either side are filled so they read as part of the picture:
 *
 *  - a studio backdrop (plain wall, seamless paper) is carried on outward,
 *    gradient and all, so the backdrop simply looks bigger. Where the outfit
 *    touches the edge it is left out of that, so it is not smeared;
 *  - a busy edge (a street, a garden) gets a blurred, darkened copy of the
 *    photo instead.
 *
 * `solid` fills with the edge's median colour and nothing else: the end card,
 * whose fine lines should not be carried outward.
 */
function fitted(img: Image, w: number, h: number, opts: { solid?: boolean } = {}): Canvas {
  const c = createCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";

  const s = Math.min(w / img.width, h / img.height);
  const dw = img.width * s;
  const dh = img.height * s;
  const dx = (w - dw) / 2;
  const dy = (h - dh) / 2;
  // Which sides are left open. Under a pixel is a rounding sliver, not a band.
  const topBottom = h - dh >= 1;
  const leftRight = w - dw >= 1;

  if (topBottom || leftRight) {
    const [a, b] = (topBottom ? (["top", "bottom"] as const) : (["left", "right"] as const)).map((side) => edgeLine(img, side));
    ctx.fillStyle = css([0, 1, 2].map((k) => (a.median[k] + b.median[k]) / 2));
    ctx.fillRect(0, 0, w, h);

    if (opts.solid) {
      // Each band in its own edge's colour, meeting behind the picture.
      ctx.fillStyle = css(a.median);
      if (topBottom) ctx.fillRect(0, 0, w, h / 2);
      else ctx.fillRect(0, 0, w / 2, h);
      ctx.fillStyle = css(b.median);
      if (topBottom) ctx.fillRect(0, h / 2, w, h / 2);
      else ctx.fillRect(w / 2, 0, w / 2, h);
    } else if (isStudio(a) && isStudio(b)) {
      // Stretch each cleaned edge line across its band (a pixel under the photo, so no gap).
      if (topBottom) {
        ctx.drawImage(a.line, 0, 0, a.line.width, 1, dx, 0, dw, dy + 1);
        ctx.drawImage(b.line, 0, 0, b.line.width, 1, dx, dy + dh - 1, dw, h - dy - dh + 1);
      } else {
        ctx.drawImage(a.line, 0, 0, 1, a.line.height, 0, dy, dx + 1, dh);
        ctx.drawImage(b.line, 0, 0, 1, b.line.height, dx + dw - 1, dy, w - dx - dw + 1, dh);
      }
    } else {
      const cs = Math.max(w / img.width, h / img.height);
      ctx.filter = "blur(48px)";
      ctx.drawImage(img, (w - img.width * cs) / 2, (h - img.height * cs) / 2, img.width * cs, img.height * cs);
      ctx.filter = "none";
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      ctx.fillRect(0, 0, w, h);
    }
  }
  ctx.drawImage(img, dx, dy, dw, dh);
  return c;
}

/** A photo fitted to the frame at OVERSCAN size, ready to be zoomed without upsampling. */
async function plate(bytes: Buffer, frame: Frame, opts: { solid?: boolean } = {}): Promise<Canvas> {
  const img = await loadImage(bytes);
  return fitted(img, Math.round(frame.width * OVERSCAN), Math.round(frame.height * OVERSCAN), opts);
}

/** The end card as one still at exactly the frame size (PNG), for the video renderer. */
export async function cardFrame(bytes: Buffer, layout: ReelLayout): Promise<Buffer> {
  const { width, height } = FRAME_SIZE[layout];
  return fitted(await loadImage(bytes), width, height, { solid: true }).toBuffer("image/png");
}

/* -------------------------------------------------------------------------- */
/* One frame                                                                  */
/* -------------------------------------------------------------------------- */

interface Layer {
  plate: Canvas;
  scale: number;
  pan: number;
  dx: number;
  dy?: number;
  alpha: number;
  /** Horizontal smear for a whip, in pixels. */
  smear: number;
}

function drawLayer(ctx: SKRSContext2D, l: Layer, frame: Frame) {
  const s = (frame.width / l.plate.width) * l.scale;
  const room = Math.max(0, (l.plate.height * s - frame.height) / 2);
  const cx = frame.width / 2 + l.dx;
  const cy = frame.height / 2 + l.pan * room + (l.dy ?? 0);
  // A whip's motion blur: copies along the direction of travel, each drawn at
  // 1/(k+1) so the result is their running average — opaque, but streaked.
  const copies = l.smear > 1 ? 6 : 1;
  for (let c = 0; c < copies; c++) {
    const off = copies > 1 ? (c / (copies - 1) - 0.5) * l.smear : 0;
    ctx.globalAlpha = l.alpha / (c + 1);
    ctx.setTransform(s, 0, 0, s, cx + off, cy);
    ctx.drawImage(l.plate, -l.plate.width / 2, -l.plate.height / 2);
  }
  ctx.globalAlpha = 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** The shot's own slow move and beat pulses at time `t`, as a layer. */
function shotLayer(shot: PlannedShot, p: Canvas, t: number): Layer {
  const u = easeInOutSine((t - shot.start) / Math.max(0.001, shot.end - shot.start));
  let scale = lerp(shot.motion.from, shot.motion.to, u);
  for (const b of shot.pulses) {
    const k = (t - b) / 0.16;
    if (k >= 0 && k < 1) scale *= 1 + 0.025 * Math.pow(1 - k, 2);
  }
  return { plate: p, scale, pan: lerp(shot.motion.panFrom, shot.motion.panTo, u), dx: 0, alpha: 1, smear: 0 };
}

export interface PhotoRenderInput {
  plan: PhotoPlan;
  layout: ReelLayout;
  /** JPEG bytes by upload index. */
  photos: Map<number, Buffer>;
  lastPage: Buffer;
  /** The song's stored stretch, as a file ffmpeg can read. */
  audioFile: string;
  outFile: string;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export async function renderPhotoReel(input: PhotoRenderInput): Promise<void> {
  const { plan } = input;
  const frame = FRAME_SIZE[input.layout];
  const { width: WIDTH, height: HEIGHT } = frame;
  const plates = new Map<number, Canvas>();
  for (const s of plan.shots) {
    if (!plates.has(s.photo)) plates.set(s.photo, await plate(input.photos.get(s.photo)!, frame));
  }
  const outroPlate = await plate(input.lastPage, frame, { solid: true });

  const frames = Math.round(plan.total * FPS);
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";

  const fadeOut = Math.min(1.4, plan.total - plan.outro.start);
  const ff = spawn(
    ffmpegPath(),
    [
      "-hide_banner", "-nostdin", "-y",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${WIDTH}x${HEIGHT}`, "-r", String(FPS), "-i", "pipe:0",
      "-ss", plan.segStart.toFixed(3), "-t", plan.total.toFixed(3), "-i", input.audioFile,
      "-filter_complex", `[1:a]afade=t=in:st=0:d=0.02,afade=t=out:st=${(plan.total - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[a]`,
      "-map", "0:v", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS),
      "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart", "-shortest",
      input.outFile,
    ],
    { windowsHide: true },
  );
  let stderr = "";
  ff.stderr.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  const done = new Promise<void>((resolve, reject) => {
    ff.on("error", (e) => reject(new Error(`ffmpeg could not start: ${e.message}`)));
    ff.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${stderr.trim().split("\n").slice(-4).join(" ")}`)),
    );
  });
  // A dead ffmpeg surfaces through `done`; don't let the write side throw first.
  ff.stdin.on("error", () => {});
  input.signal?.addEventListener("abort", () => ff.kill("SIGKILL"));

  const shots = plan.shots;
  for (let f = 0; f < frames; f++) {
    if (input.signal?.aborted) break;
    const t = f / FPS;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);

    // The shot on screen, and the next one if its entrance has already begun.
    let m = shots.findIndex((s) => t < s.end);
    if (m === -1) m = shots.length - 1;

    const drawShotWithEntrance = (k: number) => {
      const s = shots[k];
      const layer = shotLayer(s, plates.get(s.photo)!, t);
      const since = t - s.start;
      const T = TIMING[s.enter];
      if (s.enter === "open" && since < T.post) layer.scale *= 1 + 0.06 * (1 - easeOutCubic(since / T.post));
      if ((s.enter === "punch" || s.enter === "flash") && since >= 0 && since < T.post) {
        layer.scale *= 1 + 0.1 * (1 - easeOutCubic(since / T.post));
      }
      return layer;
    };

    if (t < plan.outro.start) {
      const cur = shots[m];
      const next = shots[m + 1];
      const nextT = next ? TIMING[next.enter] : null;
      const nextStarting = next && nextT && t >= next.start - nextT.pre;

      if (nextStarting && next.enter === "fade") {
        drawLayer(ctx, drawShotWithEntrance(m), frame);
        const k = drawShotWithEntrance(m + 1);
        k.alpha = easeInOutSine((t - (next.start - nextT.pre)) / nextT.pre);
        drawLayer(ctx, k, frame);
      } else if (nextStarting && next.enter === "whip") {
        // Out to the left, the next photo in from the right, meeting on the beat.
        const u = (t - (next.start - nextT.pre)) / nextT.pre;
        const out = drawShotWithEntrance(m);
        out.dx = -WIDTH * easeInCubic(u);
        out.smear = 90 * u;
        drawLayer(ctx, out, frame);
        const inc = drawShotWithEntrance(m + 1);
        inc.dx = WIDTH * (1 - easeInCubic(u));
        inc.smear = 90 * u;
        drawLayer(ctx, inc, frame);
      } else {
        const layer = drawShotWithEntrance(m);
        if (cur.enter === "whip") {
          const since = t - cur.start;
          if (since < TIMING.whip.post) layer.smear = 60 * (1 - since / TIMING.whip.post);
        }
        drawLayer(ctx, layer, frame);
        if (cur.enter === "flash") {
          const since = t - cur.start;
          if (since >= 0 && since < TIMING.flash.post) {
            ctx.fillStyle = `rgba(255,255,255,${(0.6 * (1 - easeOutCubic(since / TIMING.flash.post))).toFixed(3)})`;
            ctx.fillRect(0, 0, WIDTH, HEIGHT);
          }
        }
      }

      // The end card rises over the last photo, landing on the bar line.
      const rise = 0.32;
      if (t >= plan.outro.start - rise) {
        const u = easeOutCubic((t - (plan.outro.start - rise)) / rise);
        drawLayer(ctx, { plate: outroPlate, scale: 1.04, pan: 0, dx: 0, dy: HEIGHT * (1 - u), alpha: 1, smear: 0 }, frame);
      }
    } else {
      // The end card: a slow settle from 1.04 to 1.0 over its hold.
      const u = easeOutCubic((t - plan.outro.start) / Math.max(0.5, plan.outro.end - plan.outro.start));
      drawLayer(ctx, { plate: outroPlate, scale: lerp(1.04, 1, u), pan: 0, dx: 0, alpha: 1, smear: 0 }, frame);
    }

    const buf = canvas.data();
    if (!ff.stdin.write(buf)) await new Promise<void>((r) => ff.stdin.once("drain", () => r()));
    if (f % 15 === 0) input.onProgress?.(f / frames);
  }
  ff.stdin.end();
  await done;
  input.onProgress?.(1);
}
