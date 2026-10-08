import "server-only";

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { mediaFolder, mediaPath, MediaError } from "./files";

/**
 * Seelie's renderer (infra/render): HyperFrames in its own container, with no network and
 * its own memory cap. The OMS hands it jobs through the media volume and follows them:
 *
 *   render-jobs/<id>/project/   the composition (composition.ts stages it)
 *   render-jobs/<id>/job.json   what to do, written last; the renderer runs jobs one at a
 *                               time, oldest first, so a job's place is its id's order
 *   render-jobs/<id>/state.json the renderer's: queued, running (step, progress), done,
 *                               failed, stopped
 *   render-jobs/<id>/result.json  what the steps found and made
 *   render-jobs/<id>/stop       written here to stop it
 *   render-jobs/renderer.json   the renderer's heartbeat
 */

const POLL_MS = 500;
/** A renderer silent this long isn't running. */
const RENDERER_STALE_MS = 20_000;
/** How long a job may wait for the ones ahead of it before giving up and saying what's in the way. */
const WAIT_MS = 5 * 60_000;

export type RenderStep =
  | {
      do: "check";
      at?: number[];
      transitions?: boolean;
      zones?: string[];
      ignore?: string[];
      gate?: boolean;
      /** Codes the gate lets through at these times (scenes crossing on purpose). */
      allow?: { codes: string[]; windows: [number, number][] };
    }
  | { do: "snapshot"; at: number[] }
  | { do: "render"; quality: "draft" | "final"; fps: number };

export interface JobInfo {
  /** What it renders, for whoever waits on it or asks ("Draft render of video:15 \"Eid reel\""). */
  what: string;
  chatId?: string;
  runId?: string;
  videoId?: number;
}

interface JobFile extends JobInfo {
  steps: RenderStep[];
  createdAt: string;
}

interface JobState {
  status: "queued" | "running" | "done" | "failed" | "stopped";
  step?: string | null;
  progress?: number | null;
  note?: string | null;
  startedAt?: string;
  beatAt?: string;
}

export interface JobResult {
  ok: boolean;
  error?: string;
  /** Error codes the check found that stopped the job before its later steps. */
  blocked?: string[];
  steps: { check?: unknown; snapshot?: string[]; render?: string };
}

export interface RenderJobView extends JobInfo {
  id: string;
  status: JobState["status"];
  step: string | null;
  progress: number | null;
  createdAt: string;
  startedAt: string | null;
}

const jobsDir = () => mediaFolder("render-jobs");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Whether the renderer container is up (it writes its heartbeat every 2 s). */
export async function rendererUp(): Promise<boolean> {
  const beat = await readJson<{ beatAt: string }>(mediaPath("render-jobs", "renderer.json"));
  return !!beat && Date.now() - Date.parse(beat.beatAt) < RENDERER_STALE_MS;
}

/** The jobs waiting or running, in the order they run. */
export async function renderQueue(): Promise<RenderJobView[]> {
  const dir = await jobsDir();
  const out: RenderJobView[] = [];
  for (const id of (await readdir(dir)).filter((n) => !n.includes(".")).sort()) {
    const job = await readJson<JobFile>(path.join(dir, id, "job.json"));
    if (!job) continue;
    const state = (await readJson<JobState>(path.join(dir, id, "state.json"))) ?? { status: "queued" };
    if (state.status !== "queued" && state.status !== "running") continue;
    if (state.status === "queued" && existsSync(path.join(dir, id, "stop"))) continue;
    out.push({
      id,
      what: job.what,
      chatId: job.chatId,
      runId: job.runId,
      videoId: job.videoId,
      status: state.status,
      step: state.step ?? null,
      progress: state.progress ?? null,
      createdAt: job.createdAt,
      startedAt: state.startedAt ?? null,
    });
  }
  return out;
}

const ago = (iso: string | null) => {
  const s = iso ? Math.round((Date.now() - Date.parse(iso)) / 1000) : NaN;
  return !Number.isFinite(s) ? "" : s < 90 ? `${Math.max(0, s)} s ago` : `${Math.round(s / 60)} min ago`;
};

/** A job in a line: what, where (seen from `from`), how far, since when. */
export function describeJob(job: RenderJobView, from?: Pick<JobInfo, "chatId" | "runId">) {
  const where = !from ? "" : job.runId && job.runId === from.runId ? " in this same reply (a helper)" : job.chatId && job.chatId === from.chatId ? " in this chat" : " in another chat";
  const how = job.status === "queued" ? "waiting its turn" : `${job.step ?? "starting"}${job.progress !== null ? ` ${Math.floor(job.progress * 100)}%` : ""}`;
  return `${job.what}${where}, ${how}, started ${ago(job.startedAt ?? job.createdAt)}`;
}

/** Ask the running job (or the one given) to stop. What was asked to stop, or null. */
export async function stopRender(id?: string): Promise<RenderJobView | null> {
  const queue = await renderQueue();
  const job = id ? queue.find((j) => j.id === id) : queue.find((j) => j.status === "running");
  if (!job) return null;
  await writeFile(mediaPath("render-jobs", job.id, "stop"), new Date().toISOString());
  return job;
}

export interface FinishedJob {
  dir: string;
  result: JobResult;
  /** A file the job made (result paths are relative to its folder). */
  file(rel: string): string;
  /** Remove the job's folder; call once its files are copied out. */
  clear(): Promise<void>;
}

/**
 * Run a job: `stage` fills <job>/project, then the job is queued and followed until it ends.
 * Progress lines go to `progress`; `signal` stops it. Throws MediaError when the renderer
 * isn't running, the job failed, or it waited too long behind others.
 */
export async function runRenderJob(
  info: JobInfo,
  steps: RenderStep[],
  stage: (projectDir: string) => Promise<void>,
  ctx: { signal: AbortSignal; progress: (text: string) => void },
): Promise<FinishedJob> {
  if (!(await rendererUp())) {
    throw new MediaError("The video renderer isn't running on the ThinkPad (the render service in infra/compose.yml). Tell the owner; nothing can render until it's back.");
  }
  const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const dir = path.join(await jobsDir(), id);
  const clear = () => rm(dir, { recursive: true, force: true }).then(() => {});
  try {
    await mkdir(path.join(dir, "project"), { recursive: true });
    await stage(path.join(dir, "project"));
    const job: JobFile = { ...info, steps, createdAt: new Date().toISOString() };
    await writeFile(path.join(dir, "job.json.tmp"), JSON.stringify(job));
    await rename(path.join(dir, "job.json.tmp"), path.join(dir, "job.json"));
  } catch (err) {
    await clear();
    throw err;
  }

  const stop = () => writeFile(path.join(dir, "stop"), new Date().toISOString()).catch(() => {});
  ctx.signal.addEventListener("abort", stop, { once: true });
  const since = Date.now();
  let shown = "";
  try {
    for (;;) {
      if (ctx.signal.aborted) {
        // Let the renderer stop it (it checks every second) before the folder goes.
        for (let i = 0; i < 12; i++) {
          const now = await readJson<JobState>(path.join(dir, "state.json"));
          if (now?.status !== "running") break;
          await sleep(POLL_MS);
        }
        throw new MediaError("Stopped.");
      }
      const state = await readJson<JobState>(path.join(dir, "state.json"));
      if (state && state.status !== "queued" && state.status !== "running") break;

      let line: string;
      if (!state || state.status === "queued") {
        const queue = await renderQueue();
        const ahead = queue.filter((j) => j.id < id);
        if (!ahead.length && !(await rendererUp())) throw new MediaError("The video renderer stopped answering. Tell the owner; nothing can render until it's back.");
        if (ahead.length && Date.now() - since > WAIT_MS) {
          throw new MediaError(
            `Other renders are still ahead of this one: ${ahead.map((j) => describeJob(j, info)).join("; ")}. Tell the owner, and render again once they're done, or stop one with video_library stop_render if the owner wants this first. Deleting videos doesn't stop a render.`,
          );
        }
        const running = ahead.find((j) => j.status === "running") ?? ahead[0];
        line = running ? `Waiting for ${ahead.length === 1 ? "another render" : `${ahead.length} renders`} to finish: ${describeJob(running, info)}` : "Starting…";
      } else {
        if (state.beatAt && Date.now() - Date.parse(state.beatAt) > RENDERER_STALE_MS) throw new MediaError("The video renderer stopped answering mid-job. Tell the owner.");
        const pct = state.progress !== null && state.progress !== undefined ? ` ${Math.floor(state.progress * 100)}%` : "";
        line = state.step === "check" ? "Checking the layout, text and motion…" : state.step === "snapshot" ? "Taking stills…" : `Rendering${pct}${state.note ? `: ${state.note}` : ""}`;
      }
      if (line !== shown) {
        shown = line;
        ctx.progress(line);
      }
      await sleep(POLL_MS);
    }
    const state = await readJson<JobState>(path.join(dir, "state.json"));
    const result = (await readJson<JobResult>(path.join(dir, "result.json"))) ?? { ok: false, steps: {}, error: "The renderer left no result." };
    if (state?.status === "stopped") {
      throw new MediaError(ctx.signal.aborted ? "Stopped." : "This render was stopped from a chat (video_library stop_render). Render again only if the owner still wants it.");
    }
    if (state?.status === "failed") throw new MediaError(result.error ?? "The render failed.");
    return { dir, result, file: (rel) => path.join(dir, rel), clear };
  } catch (err) {
    await clear();
    throw err;
  } finally {
    ctx.signal.removeEventListener("abort", stop);
  }
}
