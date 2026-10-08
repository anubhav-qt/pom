// Seelie's renderer (infra/compose.yml `render`). The OMS writes a job into the media
// volume and this process runs it with HyperFrames, one job at a time, oldest first:
//
//   <media>/render-jobs/<id>/job.json     what to do (steps, written last by the OMS)
//                          /project/      the composition: index.html, assets/, fonts/
//                          /state.json    written here: queued → running → done | failed | stopped
//                          /result.json   written here when it ends
//                          /out/          what the steps made (snapshots, video.mp4)
//                          /stop          written by the OMS to stop it
//   <media>/render-jobs/renderer.json     written here every 2 s, so the OMS knows it's up
//
// It has no network (compose.yml), so a composition can only use what the OMS staged.
import { spawn } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(process.env.SEELIE_MEDIA_DIR || "/data/seelie", "render-jobs");
const GSAP = "/opt/render/node_modules/gsap/dist/gsap.min.js";
const WORKERS = process.env.RENDER_WORKERS || "2";
const BEAT_MS = 2_000;
const POLL_MS = 500;
/** Jobs nobody collected (the OMS deletes the ones it reads) go after a day. */
const KEEP_MS = 24 * 3_600_000;
const LIMITS_MS = { check: 3 * 60_000, snapshot: 3 * 60_000, render: 12 * 60_000 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

async function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value));
  await rename(temp, file);
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

let current = null; // the job running: { id, state }

async function beat() {
  await writeJson(path.join(ROOT, "renderer.json"), {
    pid: process.pid,
    release: process.env.RELEASE || "dev",
    beatAt: now(),
    job: current?.id ?? null,
  }).catch(() => {});
  if (current) await writeJson(path.join(ROOT, current.id, "state.json"), { ...current.state, beatAt: now() }).catch(() => {});
}

/** Run one hyperframes command; its output is kept, progress lines feed `onProgress`. */
function hyperframes(args, cwd, { limitMs, isStopped, onProgress }) {
  return new Promise((resolve) => {
    const child = spawn("hyperframes", args, { cwd, detached: true, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } });
    let out = "";
    let err = "";
    let stopped = false;
    let timedOut = false;
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already ended.
      }
    };
    // "  ██████░░░  25%  Starting frame capture", on either stream.
    const progress = (s) => {
      for (const m of s.matchAll(/[█░]\s+(\d{1,3})%\s+([^\r\n]+)/g)) onProgress?.(Number(m[1]) / 100, m[2].trim());
    };
    child.stdout.on("data", (d) => {
      const s = d.toString();
      out = (out + s).slice(-4_000_000);
      progress(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      err = (err + s).slice(-200_000);
      progress(s);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, limitMs);
    const watch = setInterval(async () => {
      if (await isStopped()) {
        stopped = true;
        kill();
      }
    }, 1000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearInterval(watch);
      resolve({ code, signal, out, err, stopped, timedOut });
    });
  });
}

const tail = (s, n = 12) =>
  s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/[\r\n]+/)
    .filter((l) => l.trim() && !/^\[(INFO|DEBUG)\]/.test(l))
    .slice(-n)
    .join("\n");

/** Errors left after the codes the OMS said to ignore. */
function blockingErrors(report, ignore, allow) {
  const allowed = (f) =>
    !!allow?.codes?.includes(f.code) && typeof f.time === "number" && (allow.windows ?? []).some(([a, b]) => f.time >= a - 0.01 && f.time <= b + 0.01);
  const out = [];
  for (const section of ["lint", "runtime", "layout", "motion", "contrast"]) {
    const list = report?.[section]?.findings ?? report?.[section]?.issues ?? [];
    for (const f of list) if (f.severity === "error" && !ignore.includes(f.code) && !allowed(f)) out.push(f.code);
  }
  return out;
}

async function runJob(id) {
  const dir = path.join(ROOT, id);
  const job = await readJson(path.join(dir, "job.json"));
  const project = path.join(dir, "project");
  const outDir = path.join(dir, "out");
  const state = { status: "running", step: null, progress: null, note: null, startedAt: now() };
  current = { id, state };
  const isStopped = async () => existsSync(path.join(dir, "stop"));
  const result = { ok: false, steps: {} };
  try {
    if (!job || !Array.isArray(job.steps)) throw new Error("The job has no steps.");
    await mkdir(outDir, { recursive: true });
    if (!existsSync(path.join(project, "gsap.min.js"))) await copyFile(GSAP, path.join(project, "gsap.min.js"));
    for (const step of job.steps) {
      if (await isStopped()) {
        state.status = "stopped";
        break;
      }
      state.step = step.do;
      state.progress = null;
      state.note = null;
      const onProgress = (p, note) => {
        state.progress = p;
        state.note = note;
      };
      const opts = { limitMs: LIMITS_MS[step.do] ?? 60_000, isStopped, onProgress };
      let run;
      if (step.do === "check") {
        // A check takes one caption band; each further band (a reel's top, bottom and sides)
        // is a quick layout-only pass whose collisions join the first report.
        const [firstZone, ...moreZones] = step.zones ?? [];
        const checkArgs = (zone, extra) => {
          const args = ["check", project, "--json", "--max-issues", "60", "--timeout", "8000", ...extra];
          if (step.at?.length) args.push("--at", step.at.join(","));
          if (step.transitions) args.push("--at-transitions", "--max-transition-samples", "24");
          if (zone) args.push("--caption-zone", zone);
          return args;
        };
        const parse = (out) => {
          try {
            return JSON.parse(out.slice(out.indexOf("{")));
          } catch {
            return null;
          }
        };
        run = await hyperframes(checkArgs(firstZone, []), dir, opts);
        const report = parse(run.out);
        if (!report && !run.stopped) throw new Error(`The check didn't finish:\n${tail(run.err || run.out)}`);
        for (const zone of report?.lint?.ok === false ? [] : moreZones) {
          if (run.stopped) break;
          run = await hyperframes(checkArgs(zone, ["--no-contrast"]), dir, opts);
          const layout = parse(run.out)?.layout;
          const extra = layout?.issues ?? layout?.findings ?? [];
          const issues = report.layout?.issues ?? report.layout?.findings;
          if (Array.isArray(issues)) {
            for (const f of extra) {
              if (f.code !== "caption_zone_collision") continue;
              if (!issues.some((g) => g.code === f.code && g.selector === f.selector && g.message === f.message)) issues.push(f);
            }
            if (issues.some((f) => f.severity === "error")) report.layout.ok = false;
          }
        }
        result.steps.check = report;
        const blocking = blockingErrors(report, step.ignore ?? [], step.allow);
        if (step.gate && blocking.length) {
          result.blocked = blocking;
          break;
        }
      } else if (step.do === "snapshot") {
        const args = ["snapshot", project, "-o", path.join(outDir, "snapshots"), "--at", step.at.join(","), "--no-end", "--describe", "false", "--timeout", "8000"];
        run = await hyperframes(args, dir, opts);
        if (run.code !== 0 && !run.stopped) throw new Error(`Snapshots failed:\n${tail(run.err || run.out)}`);
        const files = existsSync(path.join(outDir, "snapshots")) ? (await readdir(path.join(outDir, "snapshots"))).filter((f) => f.endsWith(".png")).sort() : [];
        result.steps.snapshot = files.map((f) => `out/snapshots/${f}`);
      } else if (step.do === "render") {
        const args = ["render", project, "-o", path.join(outDir, "video.mp4"), "-q", step.quality === "final" ? "delivery" : "draft", "-f", String(step.fps ?? 30), "-w", String(WORKERS)];
        run = await hyperframes(args, dir, opts);
        if (run.code !== 0 && !run.stopped) {
          throw new Error(run.timedOut ? "The render took longer than 12 minutes and was stopped." : run.signal === "SIGKILL" ? "The renderer ran out of memory and stopped this render." : `The render failed:\n${tail(run.err || run.out)}`);
        }
        if (!run.stopped) result.steps.render = "out/video.mp4";
      } else {
        throw new Error(`Unknown step ${step.do}.`);
      }
      if (run.stopped) {
        state.status = "stopped";
        break;
      }
    }
    if (state.status === "running") {
      state.status = "done";
      result.ok = true;
    }
  } catch (err) {
    state.status = "failed";
    result.error = err instanceof Error ? err.message : String(err);
  }
  state.endedAt = now();
  // The OMS may have removed a stopped job's folder already.
  await writeJson(path.join(dir, "result.json"), result).catch(() => {});
  await writeJson(path.join(dir, "state.json"), { ...state, beatAt: now() }).catch(() => {});
  current = null;
}

/** The oldest job not started yet. */
async function nextJob() {
  const names = (await readdir(ROOT).catch(() => [])).filter((n) => !n.includes(".")).sort();
  for (const name of names) {
    const dir = path.join(ROOT, name);
    if (!existsSync(path.join(dir, "job.json"))) continue;
    const state = await readJson(path.join(dir, "state.json"));
    if (state && state.status !== "queued") continue;
    if (existsSync(path.join(dir, "stop"))) {
      await writeJson(path.join(dir, "result.json"), { ok: false, steps: {} }).catch(() => {});
      await writeJson(path.join(dir, "state.json"), { status: "stopped", endedAt: now(), beatAt: now() }).catch(() => {});
      continue;
    }
    return name;
  }
  return null;
}

async function sweep() {
  for (const name of await readdir(ROOT).catch(() => [])) {
    const dir = path.join(ROOT, name);
    const s = await stat(dir).catch(() => null);
    if (s?.isDirectory() && Date.now() - s.mtimeMs > KEEP_MS && name !== current?.id) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  await mkdir(ROOT, { recursive: true });
  // A job that was running when this process last stopped didn't finish.
  for (const name of await readdir(ROOT).catch(() => [])) {
    const file = path.join(ROOT, name, "state.json");
    const state = await readJson(file);
    if (state?.status === "running") {
      await writeJson(path.join(ROOT, name, "result.json"), { ok: false, steps: {}, error: "The renderer restarted while this ran." });
      await writeJson(file, { ...state, status: "failed", endedAt: now() });
    }
  }
  setInterval(beat, BEAT_MS).unref();
  setInterval(sweep, 3_600_000).unref();
  await beat();
  console.log(`renderer ${process.env.RELEASE || "dev"} watching ${ROOT}`);
  for (;;) {
    const id = await nextJob();
    if (id) {
      await runJob(id);
      await beat();
    } else await sleep(POLL_MS);
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
