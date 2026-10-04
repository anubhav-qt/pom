import { readFileSync } from "node:fs";

/**
 * Which rows may be deleted from the cloud copy when it runs short of space.
 * The ThinkPad keeps them regardless.
 *
 *   { "table": "label_print_runs", "column": "created_at", "keepDays": 30 }
 *       rows whose created_at is older than 30 days
 *   { "table": "reel_job_files", "all": true }
 *       every row
 *
 * Rules run in the order listed, and only while the cloud database is over
 * `pruneAtMb`. Rows other rows point at with ON DELETE SET NULL or RESTRICT
 * are kept: deleting them would change or block those rows.
 */
export interface PruneRule {
  table: string;
  column?: string;
  keepDays?: number;
  all?: boolean;
}

export interface PairConfig {
  name: string;
  localUrl: string;
  cloudUrl: string;
  /** Never synced: each side keeps its own (migration history). */
  exclude: string[];
  /** Kept on the ThinkPad only, never copied to the cloud. (What the fallback makes still comes home.) */
  localOnly: string[];
  prune: PruneRule[];
  /**
   * Health URLs of the apps behind this pair that a request can't route around
   * (<PAIR>_APP_HEALTH, comma-separated). The storefront calls the API from inside the
   * ThinkPad, so with the API down the ThinkPad mustn't serve the storefront either.
   */
  appHealth: string[];
}

export interface Settings {
  intervalMs: number;
  pageSize: number;
  /** How far ahead of the ThinkPad each cloud sequence is kept, so outage-time ids never collide. */
  seqHeadroom: number;
  /** At boot, serve anyway once the cloud has been unreachable this long (and the internet works). */
  bootGraceMs: number;
  /** A gap this long between ticks means the laptop slept: catch up before serving. */
  suspendGapMs: number;
  /** How often the cloud lock's connection says it's still there (Pair.takeStaleLock). */
  lockPingMs: number;
  /** A cloud lock whose session has done nothing for this long is a dead sync's, and is taken over. */
  staleLockSec: number;
  metaRefreshMs: number;
  cloudChangeRetentionSec: number;
  localChangeRetentionSec: number;
  pruneAtMb: number;
  pruneEveryMs: number;
  appCheckMs: number;
  port: number;
  probeUrl: string;
  heartbeatUrl: string | null;
  backup: {
    dir: string;
    keep: number;
    /** Local hour (TZ) after which the nightly backup runs. */
    hour: number;
    recipient: string | null;
    s3: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string } | null;
  };
  reconcileHour: number;
  jobs: Job[];
}

/**
 * A request the ThinkPad makes on a timer, set in compose.yml as
 *   JOB_<NAME>_URL      what to call (GET)
 *   JOB_<NAME>_EVERY    how often: 30s, 10m, 1h
 *   JOB_<NAME>_TOKEN    sent as "Authorization: Bearer …" (optional)
 *   JOB_<NAME>_WHEN     a pair: run only while the ThinkPad serves it (optional)
 *   JOB_<NAME>_TIMEOUT  give up after this long (optional; default: EVERY, at most 10m)
 * A run never overlaps the one before it.
 */
export interface Job {
  name: string;
  url: string;
  everyMs: number;
  timeoutMs: number;
  token: string | null;
  when: string | null;
}

/** "90s", "10m", "1h", or plain milliseconds. */
export function duration(v: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(v.trim());
  if (!m) throw new Error(`not a duration: ${v}`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "ms"]!;
}

export function loadJobs(env: NodeJS.ProcessEnv = process.env): Job[] {
  const jobs: Job[] = [];
  for (const key of Object.keys(env).sort()) {
    const m = /^JOB_([A-Z0-9_]+)_URL$/.exec(key);
    if (!m || !env[key]) continue;
    const at = (s: string) => env[`JOB_${m[1]}_${s}`]?.trim() || undefined;
    const every = at("EVERY");
    if (!every) throw new Error(`JOB_${m[1]}_EVERY is not set`);
    const everyMs = duration(every);
    const timeout = at("TIMEOUT");
    jobs.push({
      name: m[1].toLowerCase().replaceAll("_", "-"),
      url: env[key]!,
      everyMs,
      timeoutMs: timeout ? duration(timeout) : Math.min(everyMs, 600_000),
      token: at("TOKEN") ?? null,
      when: at("WHEN") ?? null,
    });
  }
  return jobs;
}

interface PolicyFile {
  [pair: string]: { exclude?: string[]; localOnly?: string[]; prune?: PruneRule[] };
}

const num = (v: string | undefined, d: number) => (v && v.trim() !== "" ? Number(v) : d);

export function loadSettings(env = process.env): Settings {
  const s3 =
    env.S3_ENDPOINT && env.S3_BACKUP_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          endpoint: env.S3_ENDPOINT,
          region: env.S3_REGION || "auto",
          bucket: env.S3_BACKUP_BUCKET,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        }
      : null;
  return {
    intervalMs: num(env.SYNC_INTERVAL_MS, 1000),
    pageSize: num(env.SYNC_PAGE_SIZE, 5000),
    seqHeadroom: num(env.SYNC_SEQ_HEADROOM, 100_000),
    bootGraceMs: num(env.SYNC_BOOT_GRACE_MS, 120_000),
    suspendGapMs: num(env.SYNC_SUSPEND_GAP_MS, 10_000),
    lockPingMs: num(env.SYNC_LOCK_PING_MS, 30_000),
    staleLockSec: num(env.SYNC_STALE_LOCK_SEC, 180),
    metaRefreshMs: num(env.SYNC_META_REFRESH_MS, 60_000),
    cloudChangeRetentionSec: num(env.SYNC_CLOUD_CHANGE_RETENTION_SEC, 600),
    localChangeRetentionSec: num(env.SYNC_LOCAL_CHANGE_RETENTION_SEC, 7 * 86400),
    pruneAtMb: num(env.PRUNE_AT_MB, 400),
    pruneEveryMs: num(env.PRUNE_EVERY_MS, 3_600_000),
    appCheckMs: num(env.SYNC_APP_CHECK_MS, 3000),
    port: num(env.PORT, 8090),
    probeUrl: env.INTERNET_PROBE_URL || "https://www.cloudflare.com/cdn-cgi/trace",
    heartbeatUrl: env.HEARTBEAT_URL || null,
    backup: {
      dir: env.BACKUP_DIR || "/data/backups",
      keep: num(env.BACKUP_KEEP, 14),
      hour: num(env.BACKUP_HOUR, 3),
      recipient: env.BACKUP_RECIPIENT || null,
      s3,
    },
    reconcileHour: num(env.RECONCILE_HOUR, 4),
    jobs: loadJobs(env),
  };
}

/**
 * The pairs to sync. Each needs both URLs:
 *   SHOP_LOCAL_URL / SHOP_CLOUD_URL   the storefront API's database
 *   OMS_LOCAL_URL  / OMS_CLOUD_URL    the OMS's database
 * The policy file (policy.json next to src/, or SYNC_POLICY) says what each pair
 * leaves out and what may be pruned.
 */
export function loadPairs(env = process.env): PairConfig[] {
  const path = env.SYNC_POLICY || new URL("../policy.json", import.meta.url);
  const policy = JSON.parse(readFileSync(path, "utf8")) as PolicyFile;
  const names = (env.SYNC_PAIRS || "shop,oms").split(",").map((s) => s.trim()).filter(Boolean);
  const out: PairConfig[] = [];
  for (const name of names) {
    const up = name.toUpperCase();
    const localUrl = env[`${up}_LOCAL_URL`];
    const cloudUrl = env[`${up}_CLOUD_URL`];
    if (!localUrl || !cloudUrl) continue;
    const p = policy[name] ?? {};
    out.push({
      name,
      localUrl,
      cloudUrl,
      exclude: p.exclude ?? [],
      localOnly: p.localOnly ?? [],
      prune: p.prune ?? [],
      appHealth: (env[`${up}_APP_HEALTH`] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    });
  }
  return out;
}
