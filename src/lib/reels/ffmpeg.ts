import { spawn } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";

/**
 * The ffmpeg binary: `FFMPEG_PATH` when set (a system install), else the one
 * `ffmpeg-static` downloaded for this platform at install time, else whatever
 * `ffmpeg` is on PATH.
 */
export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH || ffmpegStatic || "ffmpeg";
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** Last lines of ffmpeg's log: the part that says what went wrong. */
const tail = (s: string) => s.trim().split("\n").slice(-6).join("\n");

/** Run ffmpeg to completion. Resolves with stdout (as a Buffer) and stderr. */
export function runFfmpeg(
  args: string[],
  opts: { onStderr?: (line: string) => void; signal?: AbortSignal } = {},
): Promise<{ stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), ["-hide_banner", "-nostdin", ...args], { windowsHide: true });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => out.push(d));
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      err += s;
      if (err.length > 200_000) err = err.slice(-100_000);
      opts.onStderr?.(s);
    });
    opts.signal?.addEventListener("abort", () => child.kill("SIGKILL"));
    child.on("error", (e) => reject(new FfmpegError(`ffmpeg could not start: ${e.message}`, "")));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new FfmpegError(`ffmpeg failed (${code}): ${tail(err)}`, err));
    });
  });
}

/** Decode any audio (or a video's audio) to mono float PCM. */
export async function decodeMono(file: string, sampleRate: number, opts: { from?: number; duration?: number } = {}) {
  const args: string[] = [];
  if (opts.from) args.push("-ss", opts.from.toFixed(3));
  if (opts.duration) args.push("-t", opts.duration.toFixed(3));
  args.push("-i", file, "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "pipe:1");
  const { stdout } = await runFfmpeg(args);
  // Copy into an aligned buffer: a Buffer from the pool may start at an odd offset.
  const copy = new Uint8Array(stdout.length - (stdout.length % 4));
  copy.set(stdout.subarray(0, copy.length));
  return new Float32Array(copy.buffer);
}

/** A media file's duration and first video stream size, read from ffmpeg's banner. */
export async function probe(file: string): Promise<{ duration: number; width: number; height: number; fps: number }> {
  let stderr = "";
  try {
    ({ stderr } = await runFfmpeg(["-i", file]));
  } catch (e) {
    // `ffmpeg -i` with no output always exits non-zero; the banner is still there.
    stderr = e instanceof FfmpegError ? e.stderr : "";
  }
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(stderr);
  const duration = d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0;
  const v = /Stream #[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})[^\n]*/.exec(stderr);
  const fpsMatch = v ? /([\d.]+) fps/.exec(v[0]) : null;
  // A phone video can carry a rotation; the displayed size is what matters.
  const rotated = /rotation of -?90/.test(stderr) || /rotate\s*:\s*-?90/.test(stderr);
  const w = v ? Number(v[1]) : 0;
  const h = v ? Number(v[2]) : 0;
  return {
    duration,
    width: rotated ? h : w,
    height: rotated ? w : h,
    fps: fpsMatch ? Number(fpsMatch[1]) : 30,
  };
}
