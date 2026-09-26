import { runFfmpeg, probe } from "./ffmpeg";
import type { VideoPlan } from "./plan";
import { FPS } from "./render-photos";
import { FRAME_SIZE, type ReelLayout } from "./types";

/**
 * A supplier's video, re-branded: their audio gone, their end card cut off,
 * ours in its place, and a song under it whose beats meet the footage's cuts.
 *
 * Reading the footage is plain frame arithmetic on a small greyscale copy:
 * a cut is a frame that differs from the one before far more than its
 * neighbours do; an end card is a last stretch that barely moves and is mostly
 * one flat colour.
 */

const AW = 64;
const AH = 112;
const AFPS = 30;

export interface VideoFacts {
  duration: number;
  width: number;
  height: number;
  /** Seconds of the supplier's footage to keep (their end card starts here, or the video ends). */
  contentEnd: number;
  /** Their end card was found and will be removed. */
  endCard: boolean;
  /** Scene cuts inside the kept footage, seconds. */
  cuts: number[];
  /** Black bars to trim, as ffmpeg's crop w:h:x:y, when the whole video has them. */
  crop: string | null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/** Share of a frame's pixels within a narrow band around its most common grey: high for a flat card. */
function flatness(frame: Uint8Array): number {
  const hist = new Uint32Array(32);
  for (const v of frame) hist[v >> 3]++;
  let peak = 0;
  for (let i = 0; i < 32; i++) {
    const band = hist[i] + (i > 0 ? hist[i - 1] : 0) + (i < 31 ? hist[i + 1] : 0);
    if (band > peak) peak = band;
  }
  return peak / frame.length;
}

export async function analyseVideo(file: string): Promise<VideoFacts> {
  const info = await probe(file);
  if (!info.duration || !info.width) throw new Error("That file does not look like a video.");

  const { stdout } = await runFfmpeg([
    "-i", file, "-an",
    "-vf", `fps=${AFPS},scale=${AW}:${AH}:flags=area,format=gray`,
    "-f", "rawvideo", "pipe:1",
  ]);
  const size = AW * AH;
  const n = Math.floor(stdout.length / size);
  const frames: Uint8Array[] = [];
  for (let i = 0; i < n; i++) frames.push(stdout.subarray(i * size, (i + 1) * size));
  if (n < AFPS) throw new Error("That video is too short to use.");

  // Mean absolute difference from the previous frame.
  const diff = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    let s = 0;
    const a = frames[i];
    const b = frames[i - 1];
    for (let k = 0; k < size; k++) s += Math.abs(a[k] - b[k]);
    diff[i] = s / size;
  }

  // Cuts: well above the local norm, and not closer than 0.3 s to the last one.
  const cutsIdx: number[] = [];
  for (let i = 1; i < n; i++) {
    const local = median(Array.from(diff.slice(Math.max(1, i - 15), Math.min(n, i + 16))));
    if (diff[i] > Math.max(12, 3.5 * local) && (cutsIdx.length === 0 || i - cutsIdx[cutsIdx.length - 1] >= 0.3 * AFPS)) {
      cutsIdx.push(i);
    }
  }

  // Their end card: the last stretch, at least ~1 s long in the final 45% of
  // the video, that barely moves and is mostly one flat colour.
  const isCard = (from: number) => {
    const len = n - from;
    if (len < AFPS * 0.8) return false;
    const motion = Array.from(diff.slice(from + 2, n));
    const still = motion.length === 0 || median(motion) < 1.6;
    const flat = median([from + Math.floor(len * 0.3), from + Math.floor(len * 0.6), n - 2].map((k) => flatness(frames[Math.min(n - 1, k)])));
    return still && flat > 0.4;
  };
  let contentIdx = n;
  for (let c = cutsIdx.length - 1; c >= 0; c--) {
    if (cutsIdx[c] < n * 0.55) break;
    if (isCard(cutsIdx[c])) {
      contentIdx = cutsIdx[c];
      break;
    }
  }
  if (contentIdx === n) {
    // No hard cut: a card that faded in. Walk back over the still tail, then
    // over the fade itself.
    let s = n - 1;
    while (s > 1 && diff[s] < 1.2) s--;
    let f = s;
    while (f > 1 && diff[f] >= 1.2 && s - f < AFPS) f--;
    if (n - f >= AFPS * 1.2 && f > n * 0.55 && isCard(s + 1)) contentIdx = f;
  }

  // Black bars present in every frame of the footage we keep.
  let crop: string | null = null;
  try {
    const { stderr } = await runFfmpeg([
      "-t", (contentIdx / AFPS).toFixed(2), "-i", file,
      "-vf", "cropdetect=limit=24:round=2:reset=0", "-an", "-f", "null", "-",
    ]);
    const all = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
    const last = all[all.length - 1];
    if (last) {
      const [w, h] = [Number(last[1]), Number(last[2])];
      const trims = w < info.width - 4 || h < info.height - 4;
      if (trims && w >= info.width * 0.6 && h >= info.height * 0.6) crop = `${last[1]}:${last[2]}:${last[3]}:${last[4]}`;
    }
  } catch {
    // Without cropdetect the video is simply used as it is.
  }

  const contentEnd = Math.min(info.duration, contentIdx / AFPS);
  return {
    duration: info.duration,
    width: info.width,
    height: info.height,
    contentEnd,
    endCard: contentIdx < n,
    cuts: cutsIdx.filter((i) => i < contentIdx).map((i) => Math.round((i / AFPS) * 1000) / 1000),
    crop,
  };
}

/**
 * Fit the footage to the frame, whole and centred. Footage already the frame's
 * shape (within 5%) fills it; anything else sits on a blurred copy of itself.
 */
function fitFilter(facts: VideoFacts, W: number, H: number): string {
  let w = facts.width;
  let h = facts.height;
  if (facts.crop) [w, h] = facts.crop.split(":").map(Number);
  const aspect = w / h;
  const crop = facts.crop ? `crop=${facts.crop},` : "";
  if (Math.abs(aspect / (W / H) - 1) < 0.05) {
    return `${crop}scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H}`;
  }
  return (
    `${crop}split[fa][fb];` +
    `[fa]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=40,eq=brightness=-0.08[bg];` +
    `[fb]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=lanczos[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2`
  );
}

export async function renderVideoReel(input: {
  plan: VideoPlan;
  facts: VideoFacts;
  layout: ReelLayout;
  videoFile: string;
  /** The end card, already fitted to the frame (see `cardFrame`). */
  cardFile: string;
  audioFile: string;
  outFile: string;
  onProgress?: (fraction: number) => void;
}): Promise<void> {
  const { plan, facts } = input;
  const { width: W, height: H } = FRAME_SIZE[input.layout];
  const xfade = 0.32;
  const E = plan.contentEnd;
  const outroLen = plan.total - E + xfade;
  const fadeOut = Math.min(1.4, plan.total - E);

  const graph =
    `[0:v]trim=end=${E.toFixed(3)},setpts=PTS-STARTPTS,${fitFilter(facts, W, H)},fps=${FPS},format=yuv420p,setsar=1,settb=AVTB[v0];` +
    `[1:v]scale=${W}:${H},fps=${FPS},format=yuv420p,setsar=1,settb=AVTB[v1];` +
    // The card slides up over the footage and is fully in on the beat at E.
    `[v0][v1]xfade=transition=slideup:duration=${xfade}:offset=${(E - xfade).toFixed(3)}[v];` +
    `[2:a]afade=t=in:st=0:d=0.02,afade=t=out:st=${(plan.total - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}[a]`;

  await runFfmpeg(
    [
      "-y",
      "-i", input.videoFile,
      "-loop", "1", "-framerate", String(FPS), "-t", outroLen.toFixed(3), "-i", input.cardFile,
      "-ss", plan.segStart.toFixed(3), "-t", plan.total.toFixed(3), "-i", input.audioFile,
      "-filter_complex", graph,
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", String(FPS),
      "-c:a", "aac", "-b:a", "192k",
      "-t", plan.total.toFixed(3),
      "-movflags", "+faststart",
      input.outFile,
    ],
    {
      onStderr: (chunk) => {
        const m = /time=(\d+):(\d+):([\d.]+)/.exec(chunk);
        if (m) input.onProgress?.(Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / plan.total));
      },
    },
  );
  input.onProgress?.(1);
}
