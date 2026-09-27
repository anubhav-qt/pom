import { createCanvas, loadImage, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";
import { spawn } from "node:child_process";

import { ffmpegPath } from "./ffmpeg";
import type { PhotoPlan } from "./plan";
import { transitionSeconds, type TransitionId } from "./transitions";
import { FRAME_SIZE, type ReelLayout } from "./types";

/**
 * Draws a photo reel frame by frame and pipes the frames into ffmpeg, which
 * encodes them and lays the song under them.
 *
 * Every photo sits still in the frame, exactly as fitted: no zooms, no pans.
 * All the movement is in the transitions (transitions.ts), which work in place
 * on the picture and are centred on the beat their cut sits on. They are drawn
 * here rather than with ffmpeg's filters so each one lands precisely on its
 * beat; every frame is a pure function of its time (grain and dust come from a
 * seeded generator), so what the plan says is what plays, every render.
 */

export const FPS = 30;

type Frame = { width: number; height: number };

/* -------------------------------------------------------------------------- */
/* Easing                                                                     */
/* -------------------------------------------------------------------------- */

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeInOutSine = (x: number) => -(Math.cos(Math.PI * clamp01(x)) - 1) / 2;
/** 0 before `a`, 1 after `b`, a smooth S between. */
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** 0 → 1 → 0 across a transition, peaking on its cut. */
const bell = (p: number) => Math.sin(Math.PI * clamp01(p));

/** A small seeded generator (mulberry32): the same seed gives the same grain every render. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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

/** A photo fitted to the frame, exactly as it will stand on screen. */
async function plate(bytes: Buffer, frame: Frame, opts: { solid?: boolean } = {}): Promise<Canvas> {
  const img = await loadImage(bytes);
  return fitted(img, frame.width, frame.height, opts);
}

/** The end card as one still at exactly the frame size (PNG), for the video renderer. */
export async function cardFrame(bytes: Buffer, layout: ReelLayout): Promise<Buffer> {
  const { width, height } = FRAME_SIZE[layout];
  return fitted(await loadImage(bytes), width, height, { solid: true }).toBuffer("image/png");
}

/* -------------------------------------------------------------------------- */
/* Transitions                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Scratch surfaces, made once per render: the transitions composite through
 * them, so a frame never allocates.
 */
export class Kit {
  readonly W: number;
  readonly H: number;
  private made = new Map<string, Canvas>();
  private grainPlates: Canvas[] | null = null;

  constructor(frame: Frame) {
    this.W = frame.width;
    this.H = frame.height;
  }

  /** A named scratch canvas, `div` times smaller than the frame, cleared. */
  scratch(name: string, div = 1): { canvas: Canvas; ctx: SKRSContext2D } {
    return this.sized(name, Math.max(1, Math.round(this.W / div)), Math.max(1, Math.round(this.H / div)));
  }

  /**
   * `img` at 1/`div` of the frame, inside a border `m` pixels wide that
   * repeats its edge pixels. A blur or a shift of up to `m` pixels then never
   * pulls in empty space, so no dark or coloured rim appears at the frame's edge.
   */
  padded(name: string, img: Canvas, div: number, m: number): Canvas {
    const w = Math.round(this.W / div);
    const h = Math.round(this.H / div);
    const { canvas, ctx } = this.sized(name, w + 2 * m, h + 2 * m);
    const iw = img.width;
    const ih = img.height;
    ctx.drawImage(img, m, m, w, h);
    ctx.drawImage(img, 0, 0, iw, 1, m, 0, w, m);
    ctx.drawImage(img, 0, ih - 1, iw, 1, m, m + h, w, m);
    ctx.drawImage(img, 0, 0, 1, ih, 0, m, m, h);
    ctx.drawImage(img, iw - 1, 0, 1, ih, m + w, m, m, h);
    ctx.drawImage(img, 0, 0, 1, 1, 0, 0, m, m);
    ctx.drawImage(img, iw - 1, 0, 1, 1, m + w, 0, m, m);
    ctx.drawImage(img, 0, ih - 1, 1, 1, 0, m + h, m, m);
    ctx.drawImage(img, iw - 1, ih - 1, 1, 1, m + w, m + h, m, m);
    return canvas;
  }

  /**
   * `img` blurred by `r` frame pixels, worked at 1/`div` size (cheap, and a big
   * blur hides the resampling) with an edge-repeating border of `m` small
   * pixels. Returns a function that draws the result over a frame, unmoved.
   */
  blur(name: string, img: Canvas, r: number, div: number, m: number) {
    const pad = this.padded(`${name}-pad`, img, div, m);
    const { canvas: out, ctx } = this.sized(`${name}-out`, pad.width, pad.height);
    ctx.filter = `blur(${(r / div).toFixed(2)}px)`;
    ctx.drawImage(pad, 0, 0);
    ctx.filter = "none";
    const w = pad.width - 2 * m;
    const h = pad.height - 2 * m;
    return (to: SKRSContext2D) => to.drawImage(out, m, m, w, h, 0, 0, this.W, this.H);
  }

  private sized(name: string, w: number, h: number): { canvas: Canvas; ctx: SKRSContext2D } {
    let c = this.made.get(name);
    if (!c || c.width !== w || c.height !== h) {
      c = createCanvas(w, h);
      this.made.set(name, c);
    }
    const ctx = c.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.imageSmoothingQuality = "high";
    ctx.clearRect(0, 0, c.width, c.height);
    return { canvas: c, ctx };
  }

  /** Four plates of film grain at half size (drawn up, the grain is soft, like film's), made on first use. */
  grain(): Canvas[] {
    if (this.grainPlates) return this.grainPlates;
    const w = Math.round(this.W / 2);
    const h = Math.round(this.H / 2);
    this.grainPlates = [0, 1, 2, 3].map((k) => {
      const next = random(9001 + k);
      const c = createCanvas(w, h);
      const ctx = c.getContext("2d");
      const img = ctx.createImageData(w, h);
      for (let i = 0; i < w * h; i++) {
        // Three uniforms averaged: roughly bell-shaped around mid grey.
        const v = 128 + ((next() + next() + next()) / 3 - 0.5) * 190;
        img.data[i * 4] = v;
        img.data[i * 4 + 1] = v;
        img.data[i * 4 + 2] = v;
        img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      return c;
    });
    return this.grainPlates;
  }
}

function draw(ctx: SKRSContext2D, img: Canvas, alpha = 1) {
  if (alpha <= 0) return;
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(img, 0, 0);
  ctx.globalAlpha = 1;
}

/** A, then B over it at weight `w` (0 = all A). */
function mix(ctx: SKRSContext2D, A: Canvas, B: Canvas, w: number) {
  if (w < 1) draw(ctx, A);
  if (w > 0) draw(ctx, B, w);
}

/** Fill the frame with a colour, through a blend mode. */
function wash(ctx: SKRSContext2D, kit: Kit, color: string, alpha: number, mode: GlobalCompositeOperation = "source-over") {
  if (alpha <= 0.002) return;
  ctx.globalCompositeOperation = mode;
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, kit.W, kit.H);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

/**
 * A linear gradient across the frame from (x0,y0) to (x1,y1) whose opacity
 * follows `alpha(g)`, g being 0..1 along it. Sampled finely, so any curve
 * works and no stop ever falls outside 0..1.
 */
function curve(ctx: SKRSContext2D, x0: number, y0: number, x1: number, y1: number, rgb: string, alpha: (g: number) => number) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  const N = 48;
  for (let i = 0; i <= N; i++) g.addColorStop(i / N, `rgba(${rgb},${clamp01(alpha(i / N)).toFixed(3)})`);
  return g;
}

/** `img` defocused by `r` pixels, drawn over what is there (a sharp copy, which it fades in over while `r` is small). */
function defocus(ctx: SKRSContext2D, kit: Kit, img: Canvas, r: number) {
  if (r < 0.4) return;
  const blurred = kit.blur("defocus", img, r, 4, 16);
  ctx.globalAlpha = Math.min(1, r / 3);
  blurred(ctx);
  ctx.globalAlpha = 1;
}

type Draw = (ctx: SKRSContext2D, kit: Kit, A: Canvas, B: Canvas, p: number, seed: number, frame: number) => void;

/**
 * Each transition at progress `p` (0..1; 0.5 is the cut, on the beat), from
 * photo A to photo B. None of them moves the pictures.
 */
const DRAW: Record<TransitionId, Draw> = {
  cut: (ctx, _kit, A, B, p) => draw(ctx, p < 0.5 ? A : B),

  dissolve: (ctx, _kit, A, B, p) => mix(ctx, A, B, easeInOutSine(p)),

  dip_black: (ctx, kit, A, B, p) => {
    draw(ctx, p < 0.5 ? A : B);
    wash(ctx, kit, "#070505", p < 0.5 ? easeInOutSine(p * 2) : 1 - easeInOutSine((p - 0.5) * 2));
  },

  // Through light rather than paint: screen brightens the picture towards ivory.
  dip_ivory: (ctx, kit, A, B, p) => {
    draw(ctx, p < 0.5 ? A : B);
    const a = p < 0.5 ? easeInOutSine(p * 2) : 1 - easeInOutSine((p - 0.5) * 2);
    wash(ctx, kit, "#fbf3e8", a, "screen");
    wash(ctx, kit, "#fbf3e8", a * a * 0.6);
  },

  light_leak: (ctx, kit, A, B, p, seed) => {
    mix(ctx, A, B, smooth(0.36, 0.64, p));
    const I = Math.pow(bell(p), 0.85);
    if (I < 0.01) return;
    const { W, H } = kit;
    const next = random(seed * 7919 + 17);
    const dir = next() < 0.5 ? 1 : -1;
    const along = dir > 0 ? p : 1 - p;
    const y0 = H * (0.25 + 0.5 * next());
    // Blobs of warm light, stretched tall like a leak on film, drifting across.
    const blob = (x: number, y: number, rx: number, ry: number, rgb: string, a: number) => {
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(rx, ry);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, `rgba(${rgb},${(a * I).toFixed(3)})`);
      g.addColorStop(0.55, `rgba(${rgb},${(a * I * 0.45).toFixed(3)})`);
      g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(-1, -1, 2, 2);
      ctx.restore();
    };
    const x = W * (-0.25 + 1.5 * along);
    ctx.globalCompositeOperation = "screen";
    blob(x, y0, W * 0.75, H * 0.6, "255,138,58", 0.9);
    blob(x - W * 0.3 * dir, y0 + H * 0.18, W * 0.55, H * 0.45, "255,84,112", 0.6);
    blob(x + W * 0.12 * dir, y0 - H * 0.08, W * 0.3, H * 0.34, "255,228,176", 0.95);
    ctx.globalCompositeOperation = "source-over";
    wash(ctx, kit, "#ffc79a", 0.14 * I, "screen");
  },

  chroma: (ctx, kit, A, B, p) => {
    const { canvas: base, ctx: b } = kit.scratch("chroma-base");
    mix(b, A, B, smooth(0.44, 0.56, p));
    const M = 24;
    const shift = Math.min(M - 2, kit.W * 0.016 * Math.pow(bell(p), 1.6));
    if (shift < 0.5) {
      draw(ctx, base);
      return;
    }
    // Each channel on its own, added back together a little apart. The border
    // repeats the edge, so a shifted channel never leaves a coloured line there.
    const pad = kit.padded("chroma-pad", base, 1, M);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, kit.W, kit.H);
    const channels: [string, number, number][] = [
      ["#ff0000", -shift, shift * 0.2],
      ["#00ff00", 0, 0],
      ["#0000ff", shift, -shift * 0.2],
    ];
    for (const [color, dx, dy] of channels) {
      const { ctx: c, canvas: ch } = kit.scratch("chroma-channel");
      c.drawImage(pad, M - dx, M - dy, kit.W, kit.H, 0, 0, kit.W, kit.H);
      c.globalCompositeOperation = "multiply";
      c.fillStyle = color;
      c.fillRect(0, 0, kit.W, kit.H);
      ctx.globalCompositeOperation = "lighter";
      ctx.drawImage(ch, 0, 0);
    }
    ctx.globalCompositeOperation = "source-over";
  },

  grain: (ctx, kit, A, B, p, seed, frame) => {
    const I = bell(p);
    const next = random(seed * 131 + frame * 7 + 1);
    // Around the cut the film stutters between the two frames.
    const stutter = Math.abs(p - 0.5) < 0.09;
    draw(ctx, stutter ? (next() < 0.5 ? A : B) : p < 0.5 ? A : B);
    // Exposure flicker.
    const e = (next() - 0.5) * 0.22 * I;
    if (e > 0) wash(ctx, kit, "#fff4e6", e, "screen");
    else wash(ctx, kit, "#000", -e);
    // Grain.
    const plates = kit.grain();
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = 0.25 + 0.5 * I;
    ctx.drawImage(plates[frame % plates.length], 0, 0, kit.W, kit.H);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    // Dust and hairline scratches.
    const specks = Math.round(26 * I);
    for (let i = 0; i < specks; i++) {
      const light = next() < 0.35;
      const a = (0.35 + 0.4 * next()).toFixed(2);
      ctx.fillStyle = light ? `rgba(255,248,235,${a})` : `rgba(20,14,10,${a})`;
      ctx.beginPath();
      ctx.ellipse(next() * kit.W, next() * kit.H, 1 + next() * 3.5, 1 + next() * 2.5, next() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    const scratches = I > 0.4 ? Math.floor(next() * 3) : 0;
    for (let i = 0; i < scratches; i++) {
      const x = next() * kit.W;
      const top = next() * kit.H * 0.4;
      ctx.fillStyle = `rgba(245,238,225,${(0.18 + 0.2 * next()).toFixed(2)})`;
      ctx.fillRect(x, top, 1.2, kit.H * (0.3 + 0.6 * next()));
    }
    // A burnt, warm edge that comes and goes with the grain.
    const g = ctx.createRadialGradient(kit.W / 2, kit.H / 2, kit.H * 0.25, kit.W / 2, kit.H / 2, kit.H * 0.75);
    g.addColorStop(0, "rgba(90,45,15,0)");
    g.addColorStop(1, `rgba(90,45,15,${(0.55 * I).toFixed(3)})`);
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, kit.W, kit.H);
    ctx.globalCompositeOperation = "source-over";
  },

  ripple: (ctx, kit, A, B, p) => {
    // One long, slow wave travelling down the picture, with a gentler one under it: silk, not static.
    const amp = kit.W * 0.016 * Math.pow(bell(p), 1.3);
    const phase = p * Math.PI * 2;
    const wave = kit.H * 0.34;
    const band = 4;
    const wavy = (to: SKRSContext2D, img: Canvas) => {
      // The still picture underneath, so the bands never open a gap at the edges.
      to.drawImage(img, 0, 0);
      if (amp < 0.3) return;
      for (let y = 0; y < kit.H; y += band) {
        const dx = amp * Math.sin((2 * Math.PI * y) / wave - phase) + 0.18 * amp * Math.sin((2 * Math.PI * y) / (wave * 0.55) + 1.3 * phase);
        to.drawImage(img, 0, y, kit.W, band, dx, y, kit.W, band);
      }
    };
    const w = smooth(0.3, 0.7, p);
    if (w < 1) wavy(ctx, A);
    if (w > 0) {
      const { canvas: layer, ctx: l } = kit.scratch("ripple-b");
      wavy(l, B);
      draw(ctx, layer, w);
    }
  },

  focus: (ctx, kit, A, B, p) => {
    const max = kit.W * 0.022;
    const w = smooth(0.4, 0.6, p);
    if (w < 1) {
      draw(ctx, A);
      defocus(ctx, kit, A, max * easeInOutSine(p * 2));
    }
    if (w > 0) {
      const { canvas: layer, ctx: l } = kit.scratch("focus-b");
      draw(l, B);
      defocus(l, kit, B, max * (1 - easeInOutSine((p - 0.5) * 2)));
      draw(ctx, layer, w);
    }
    // Out-of-focus light lifts the picture a touch, as a lens does.
    wash(ctx, kit, "#fff8f0", 0.08 * bell(p), "screen");
  },

  silk_wipe: (ctx, kit, A, B, p, seed) => {
    const f = 0.3;
    const s = -f / 2 + easeInOutSine(p) * (1 + f);
    // From the lower left to the upper right, or mirrored.
    const [x0, y0, x1, y1] = seed % 2 === 1 ? [kit.W, kit.H, 0, 0] : [0, kit.H, kit.W, 0];
    draw(ctx, A);
    const { canvas: layer, ctx: l } = kit.scratch("silk");
    l.drawImage(B, 0, 0);
    l.globalCompositeOperation = "destination-in";
    l.fillStyle = curve(l, x0, y0, x1, y1, "0,0,0", (g) => 1 - smooth(s - f / 2, s + f / 2, g));
    l.fillRect(0, 0, kit.W, kit.H);
    draw(ctx, layer);
    // A faint sheen along the edge.
    const sheen = 0.3 * bell(p);
    if (sheen > 0.01) {
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = curve(ctx, x0, y0, x1, y1, "255,250,242", (g) => sheen * Math.max(0, 1 - Math.abs(g - s) / 0.07));
      ctx.fillRect(0, 0, kit.W, kit.H);
      ctx.globalCompositeOperation = "source-over";
    }
  },

  glow: (ctx, kit, A, B, p) => {
    const { canvas: base, ctx: b } = kit.scratch("glow-base");
    mix(b, A, B, smooth(0.4, 0.6, p));
    draw(ctx, base);
    const I = bell(p);
    if (I < 0.01) return;
    // Bloom: a blurred copy of the picture screened over it, so the highlights glow.
    const bloom = kit.blur("glow", base, 36 + 60 * I, 6, 40);
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = 0.9 * I;
    bloom(ctx);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    wash(ctx, kit, "#fff3e6", 0.2 * I * I, "screen");
  },
};

/* -------------------------------------------------------------------------- */
/* The reel                                                                   */
/* -------------------------------------------------------------------------- */

/** One change of picture: on the beat `at`, from A to B, taking `half` seconds either side. */
export interface Change {
  at: number;
  A: Canvas;
  B: Canvas;
  transition: TransitionId;
  half: number;
  /** The reel's first photo: only the second half plays, out of the transition into the picture. */
  opening: boolean;
  seed: number;
}

/**
 * Every change in the reel, the end card's included. A transition takes at
 * most 45% of the shot either side, so two never overlap and every photo is
 * seen whole for a moment.
 */
export function changesOf(plan: Pick<PhotoPlan, "shots" | "outro">, plates: (photo: number) => Canvas, card: Canvas): Change[] {
  const shots = plan.shots;
  const out: Change[] = shots.map((s, k) => {
    const prev = k > 0 ? shots[k - 1] : null;
    const room = Math.min(prev ? prev.end - prev.start : Infinity, s.end - s.start) * 0.45;
    return {
      at: s.start,
      // The first photo transitions out of itself: a fade from black would only dim it.
      A: plates(prev ? prev.photo : s.photo),
      B: plates(s.photo),
      transition: s.transition,
      half: Math.min(transitionSeconds(s.transition) / 2, room),
      opening: k === 0,
      seed: k + 1,
    };
  });
  const last = shots[shots.length - 1];
  const into = plan.outro.transition;
  out.push({
    at: plan.outro.start,
    A: plates(last.photo),
    B: card,
    transition: into,
    half: Math.min(transitionSeconds(into) / 2, (last.end - last.start) * 0.45, (plan.outro.end - plan.outro.start) * 0.45),
    opening: false,
    seed: shots.length + 1,
  });
  return out;
}

/** The frame at time `t` (frame number `f`): the photo on screen, or the transition under way. */
export function drawFrame(ctx: SKRSContext2D, kit: Kit, changes: Change[], t: number, f: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, kit.W, kit.H);

  for (const c of changes) {
    if (c.half <= 0) continue;
    const from = c.opening ? c.at : c.at - c.half;
    if (t >= from && t < c.at + c.half) {
      DRAW[c.transition](ctx, kit, c.A, c.B, 0.5 + (t - c.at) / (2 * c.half), c.seed, f);
      return;
    }
  }
  // Nothing under way: the latest change holds the screen.
  let on = changes[0];
  for (const c of changes) if (t >= c.at) on = c;
  draw(ctx, on.B);
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
  const card = await plate(input.lastPage, frame, { solid: true });
  const changes = changesOf(plan, (photo) => plates.get(photo)!, card);
  const kit = new Kit(frame);

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
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-pix_fmt", "yuv420p", "-r", String(FPS),
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

  for (let f = 0; f < frames; f++) {
    if (input.signal?.aborted) break;
    drawFrame(ctx, kit, changes, f / FPS, f);
    const buf = canvas.data();
    if (!ff.stdin.write(buf)) await new Promise<void>((r) => ff.stdin.once("drain", () => r()));
    if (f % 15 === 0) input.onProgress?.(f / frames);
  }
  ff.stdin.end();
  await done;
  input.onProgress?.(1);
}

