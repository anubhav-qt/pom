import { spawn, spawnSync } from "node:child_process";

/**
 * yt-dlp, for song audio (scripts/reel-songs.ts and Seelie's songs tool) and YouTube
 * search and details (Seelie's youtube tool). YTDLP_PATH names the binary (the Docker
 * image ships a pinned one); otherwise yt-dlp on PATH or the Python module.
 */

let found: string[] | null | undefined;

export function ytDlpCommand(): string[] | null {
  if (found !== undefined) return found;
  const candidates = [
    ...(process.env.YTDLP_PATH?.trim() ? [[process.env.YTDLP_PATH.trim()]] : []),
    ["yt-dlp"],
    ["py", "-m", "yt_dlp"],
    ["python", "-m", "yt_dlp"],
    ["python3", "-m", "yt_dlp"],
  ];
  for (const cmd of candidates) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), "--version"], { encoding: "utf8", timeout: 15_000 });
    if (r.status === 0) return (found = cmd);
  }
  return (found = null);
}

export class YtDlpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YtDlpError";
  }
}

/**
 * Runs yt-dlp and gives back what it printed. `--js-runtimes node` lets it solve
 * YouTube's player challenges with the Node that runs the OMS.
 */
export function runYtDlp(args: string[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
  const cmd = ytDlpCommand();
  if (!cmd) return Promise.reject(new YtDlpError("yt-dlp isn't installed on this machine."));
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0], [...cmd.slice(1), "--js-runtimes", "node", "--no-warnings", ...args], {
      // UTF-8 so titles in Gurmukhi or Devanagari survive the Windows console codepage.
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });
    const out: Buffer[] = [];
    let err = "";
    let size = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
    const abort = () => child.kill("SIGKILL");
    opts.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (b: Buffer) => {
      size += b.length;
      if (size < 32 * 1024 * 1024) out.push(b);
    });
    child.stderr.on("data", (b: Buffer) => {
      err = (err + b.toString("utf8")).slice(-4000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new YtDlpError(`yt-dlp couldn't start: ${e.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", abort);
      if (opts.signal?.aborted) return reject(new YtDlpError("Stopped."));
      if (code === 0) return resolve(Buffer.concat(out).toString("utf8"));
      const last = err.trim().split("\n").pop() ?? "";
      reject(new YtDlpError(signal ? "yt-dlp took too long." : `yt-dlp failed: ${last.replace(/^ERROR:\s*/, "")}`));
    });
  });
}
