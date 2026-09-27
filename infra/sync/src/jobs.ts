import type { Job } from "./config.ts";
import { errText, log } from "./db.ts";

export interface JobStatus {
  name: string;
  url: string;
  every: string;
  when: string | null;
  running: boolean;
  lastRunAt: string | null;
  lastMs: number | null;
  /** The HTTP status, or null when the request itself failed. */
  lastStatus: number | null;
  lastError: string | null;
  /** Why the last due run didn't happen (its pair wasn't serving). */
  waiting: string | null;
}

/**
 * The ThinkPad's timed work: the OMS's order sync, keeping Render awake (config.ts, Job).
 * A job whose pair isn't serving waits, and runs as soon as it is.
 */
export class Jobs {
  private readonly jobs: Job[];
  private readonly serving: (pair: string) => boolean;
  private readonly now: () => number;
  private readonly state: Map<string, JobStatus & { nextAt: number }>;
  private timer: NodeJS.Timeout | undefined;

  constructor(jobs: Job[], serving: (pair: string) => boolean, now: () => number = Date.now, firstRunAfterMs = 30_000) {
    this.jobs = jobs;
    this.serving = serving;
    this.now = now;
    this.state = new Map(
      jobs.map((j) => [
        j.name,
        {
          name: j.name,
          url: j.url.replace(/\/\/[^/@]*@/, "//"),
          every: `${j.everyMs / 1000}s`,
          when: j.when,
          running: false,
          lastRunAt: null,
          lastMs: null,
          lastStatus: null,
          lastError: null,
          waiting: null,
          nextAt: now() + firstRunAfterMs,
        },
      ]),
    );
  }

  start(everyMs = 5000) {
    if (this.jobs.length) log("info", "jobs", { jobs: this.jobs.map((j) => `${j.name} every ${j.everyMs / 1000}s`) });
    this.timer = setInterval(() => this.tick(), everyMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  status(): JobStatus[] {
    return [...this.state.values()].map(({ nextAt: _, ...s }) => s);
  }

  /** Starts every job that's due. Resolves when the ones it started have finished (for tests). */
  async tick(): Promise<void> {
    const started: Promise<void>[] = [];
    for (const job of this.jobs) {
      const s = this.state.get(job.name)!;
      if (s.running || this.now() < s.nextAt) continue;
      if (job.when && !this.serving(job.when)) {
        s.waiting = `the ThinkPad isn't serving ${job.when}`;
        continue;
      }
      s.waiting = null;
      s.running = true;
      s.nextAt = this.now() + job.everyMs;
      started.push(this.run(job, s));
    }
    await Promise.all(started);
  }

  private async run(job: Job, s: JobStatus) {
    const t0 = this.now();
    s.lastRunAt = new Date(t0).toISOString();
    try {
      const res = await fetch(job.url, {
        headers: job.token ? { authorization: `Bearer ${job.token}` } : {},
        signal: AbortSignal.timeout(job.timeoutMs),
      });
      const text = await res.text();
      s.lastStatus = res.status;
      s.lastError = res.ok ? null : text.slice(0, 300);
      if (!res.ok) log("warn", "job answered with an error", { job: job.name, status: res.status, body: text.slice(0, 300) });
    } catch (e) {
      s.lastStatus = null;
      s.lastError = errText(e);
      log("warn", "job failed", { job: job.name, error: errText(e) });
    } finally {
      s.lastMs = this.now() - t0;
      s.running = false;
    }
  }
}
