import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

import { loadPairs, loadSettings, type PairConfig, type Settings } from "./config.ts";
import { errText, log } from "./db.ts";
import { Jobs } from "./jobs.ts";
import { backup, bootstrap, listConflicts, prune, reconcileAll, reconcileTable, reseedCloud, resolveConflicts } from "./ops.ts";
import { Halt, Pair } from "./pair.ts";

/**
 * The sync daemon, and the commands that talk to it.
 *
 *   node src/main.ts                       run: sync every pair, answer the gate, run the jobs
 *   node src/main.ts bootstrap <pair>      first start: copy the cloud database in (sync stopped)
 *   node src/main.ts reseed-cloud <pair>   fill a new cloud database from the ThinkPad (sync stopped)
 *   node src/main.ts status                what the running sync is doing
 *   node src/main.ts reconcile <pair> [table]
 *   node src/main.ts prune <pair> [--dry-run] [--force]
 *   node src/main.ts backup
 *   node src/main.ts conflicts <pair>
 *   node src/main.ts resolve <pair> <id,id,…|all>
 *
 * Inside the stack: docker compose exec sync node src/main.ts status
 */

const RELEASE = process.env.RELEASE || "dev";

async function daemon(settings: Settings, cfgs: PairConfig[]) {
  if (!cfgs.length) {
    log("error", "no pairs configured: set SHOP_LOCAL_URL/SHOP_CLOUD_URL and/or OMS_LOCAL_URL/OMS_CLOUD_URL");
    process.exit(1);
  }
  const pairs = new Map(cfgs.map((c) => [c.name, new Pair(c, settings)]));
  const jobs = new Jobs(settings.jobs, (name) => pairs.get(name)?.isReady() ?? false);
  const abort = new AbortController();
  const startedAt = new Date().toISOString();
  const last = { backupDay: lastBackupDay(settings), reconcileDay: new Map<string, string>(), prune: new Map<string, number>(), heartbeat: 0 };

  const server = createServer((req, res) => {
    route(req, res).catch((e) => send(res, 500, { error: errText(e) }));
  });

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://sync");
    const parts = url.pathname.split("/").filter(Boolean);

    // The gate asks here before every request (Caddy forward_auth).
    if (parts[0] === "ready" && parts[1]) {
      const pair = pairs.get(parts[1]);
      if (pair?.isReady()) return send(res, 200, "ready");
      res.setHeader("x-paribelle-standby", "1");
      res.setHeader("retry-after", "5");
      const why = pair && !pair.status.appsUp ? "is restarting an app" : "is catching up with the cloud";
      return send(res, 503, `The ThinkPad ${why}; the fallback is answering.`);
    }
    // Healthy once every pair has been bootstrapped. The API's migrations wait for this,
    // so they never build a schema into an empty ThinkPad database before the copy lands.
    if (parts[0] === "health") {
      const missing = [];
      for (const p of pairs.values()) if (!(await p.bootstrapped())) missing.push(p.name);
      if (missing.length) return send(res, 503, `not bootstrapped: ${missing.join(", ")} (see infra/README.md)`);
      return send(res, 200, "ok");
    }
    if (parts[0] === "status") return send(res, 200, status());

    if (req.method === "POST" && parts[0] === "admin") {
      if (parts[1] === "backup") return send(res, 200, await backup(settings, cfgs));
      const pair = pairs.get(parts[2] ?? "");
      if (!pair) return send(res, 404, { error: `no pair ${parts[2]}` });
      switch (parts[1]) {
        case "reconcile":
          return send(res, 200, await pair.exclusive<unknown>(() => (parts[3] ? reconcileTable(pair, parts[3]) : reconcileAll(pair))));
        case "prune":
          return send(res, 200, await pair.exclusive(() => prune(pair, { dryRun: url.searchParams.has("dry"), force: url.searchParams.has("force") })));
        case "resolve": {
          const ids = parts[3] === "all" ? "all" : (parts[3] ?? "").split(",").map(Number).filter(Boolean);
          return send(res, 200, await resolveConflicts(pair, ids));
        }
      }
    }
    if (parts[0] === "admin" && parts[1] === "conflicts") {
      const pair = pairs.get(parts[2] ?? "");
      if (!pair) return send(res, 404, { error: `no pair ${parts[2]}` });
      return send(res, 200, await listConflicts(pair));
    }
    send(res, 404, { error: "not found" });
  }

  function status() {
    return {
      release: RELEASE,
      startedAt,
      internetOk: [...pairs.values()][0]?.internetOk ?? true,
      pairs: [...pairs.values()].map((p) => {
        p.isReady();
        return p.status;
      }),
      lastBackup: readLastBackup(settings),
      jobs: jobs.status(),
    };
  }

  server.listen(settings.port, () => log("info", "sync listening", { port: settings.port, pairs: [...pairs.keys()], release: RELEASE }));

  jobs.start();
  for (const pair of pairs.values()) {
    pair.run(abort.signal).catch((e) => log("error", "pair loop died", { pair: pair.name, error: errText(e) }));
  }

  // Every few seconds: do the apps behind each pair answer? Two misses in a row take the
  // pair out of service; two answers in a row put it back.
  const appChecks = new Map<string, { misses: number; hits: number }>();
  const appTicker = setInterval(async () => {
    for (const p of pairs.values()) {
      if (!p.cfg.appHealth.length) continue;
      const failed = (await Promise.all(p.cfg.appHealth.map(checkApp))).find((r) => r !== null) ?? null;
      const c = appChecks.get(p.name) ?? { misses: 0, hits: 0 };
      appChecks.set(p.name, c);
      if (failed) {
        c.hits = 0;
        if (++c.misses >= 2) p.setAppsUp(false, failed);
      } else {
        c.misses = 0;
        if (++c.hits >= 2) p.setAppsUp(true);
      }
    }
  }, settings.appCheckMs);

  // Every second: notice a laptop that slept, and whether the internet is there when the cloud isn't.
  let lastTick = Date.now();
  let lastProbe = 0;
  const ticker = setInterval(async () => {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    const failing = [...pairs.values()].some((p) => p.cloudFailingFor(now) > 10_000);
    if (failing && now - lastProbe > 5000) {
      lastProbe = now;
      const ok = await probe(settings.probeUrl);
      for (const p of pairs.values()) p.internetOk = ok;
    } else if (!failing) {
      for (const p of pairs.values()) p.internetOk = true;
    }
    for (const p of pairs.values()) p.tick(gap);
  }, 1000);

  // Every minute: the nightly backup and reconcile, pruning when the cloud fills up, the heartbeat.
  const scheduler = setInterval(async () => {
    const now = new Date();
    const day = localDay(now);
    try {
      if (now.getHours() >= settings.backup.hour && last.backupDay !== day) {
        last.backupDay = day;
        await backup(settings, cfgs, now).catch((e) => log("error", "backup failed", { error: errText(e) }));
      }
      for (const p of pairs.values()) {
        if (now.getHours() >= settings.reconcileHour && last.reconcileDay.get(p.name) !== day && p.isReady() && !p.status.degraded) {
          last.reconcileDay.set(p.name, day);
          await p.exclusive(() => reconcileAll(p)).catch((e) => log("error", "nightly reconcile failed", { pair: p.name, error: errText(e) }));
        }
        if (Date.now() - (last.prune.get(p.name) ?? 0) > settings.pruneEveryMs && p.isReady() && p.status.cloudReachable) {
          last.prune.set(p.name, Date.now());
          await p.exclusive(() => prune(p)).catch((e) => log("error", "prune failed", { pair: p.name, error: errText(e) }));
        }
      }
      // The heartbeat only goes out while every pair is serving and syncing: silence means look.
      const healthy = [...pairs.values()].every(
        (p) => p.isReady() && !p.status.degraded && p.status.lastCycleAt && Date.now() - Date.parse(p.status.lastCycleAt) < 60_000,
      );
      if (settings.heartbeatUrl && healthy && Date.now() - last.heartbeat > 5 * 60_000) {
        last.heartbeat = Date.now();
        await fetch(settings.heartbeatUrl, { signal: AbortSignal.timeout(10_000) }).catch(() => {});
      }
    } catch (e) {
      log("error", "scheduler", { error: errText(e) });
    }
  }, 60_000);

  const stop = async (sig: string) => {
    log("info", "stopping", { signal: sig });
    abort.abort();
    clearInterval(ticker);
    clearInterval(appTicker);
    clearInterval(scheduler);
    jobs.stop();
    server.close();
    await Promise.allSettled([...pairs.values()].map((p) => p.close()));
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

function send(res: ServerResponse, code: number, body: unknown) {
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  res.statusCode = code;
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-type", typeof body === "string" ? "text/plain; charset=utf-8" : "application/json");
  res.end(text);
}

/** null when the app answers 2xx within 3 s, otherwise what went wrong. */
async function checkApp(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    await r.body?.cancel();
    return r.ok ? null : `${url}: ${r.status}`;
  } catch (e) {
    return `${url}: ${errText(e)}`;
  }
}

async function probe(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

function localDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function readLastBackup(settings: Settings) {
  const f = join(settings.backup.dir, "last-backup.json");
  try {
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
  } catch {
    return null;
  }
}

function lastBackupDay(settings: Settings): string | null {
  const b = readLastBackup(settings);
  return b?.at ? localDay(new Date(b.at)) : null;
}

async function admin(settings: Settings, method: string, path: string) {
  const res = await fetch(`http://127.0.0.1:${settings.port}${path}`, { method });
  const text = await res.text();
  console.log(text);
  if (!res.ok) process.exit(1);
}

async function main() {
  const settings = loadSettings();
  const cfgs = loadPairs();
  const [cmd, ...args] = process.argv.slice(2);
  const pairArg = () => {
    const cfg = cfgs.find((c) => c.name === args[0]);
    if (!cfg) {
      console.error(`which pair? one of: ${cfgs.map((c) => c.name).join(", ") || "(none configured)"}`);
      process.exit(2);
    }
    return cfg;
  };

  try {
    switch (cmd ?? "run") {
      case "run":
        return await daemon(settings, cfgs);
      case "bootstrap":
        console.log(JSON.stringify(await bootstrap(pairArg(), settings), null, 2));
        return;
      case "reseed-cloud":
        console.log(JSON.stringify(await reseedCloud(pairArg(), settings), null, 2));
        return;
      case "status":
        return await admin(settings, "GET", "/status");
      case "reconcile":
        pairArg();
        return await admin(settings, "POST", `/admin/reconcile/${args[0]}${args[1] ? `/${encodeURIComponent(args[1])}` : ""}`);
      case "prune": {
        pairArg();
        const qs = [args.includes("--dry-run") ? "dry" : "", args.includes("--force") ? "force" : ""].filter(Boolean).join("&");
        return await admin(settings, "POST", `/admin/prune/${args[0]}${qs ? `?${qs}` : ""}`);
      }
      case "backup":
        return await admin(settings, "POST", "/admin/backup");
      case "conflicts":
        pairArg();
        return await admin(settings, "GET", `/admin/conflicts/${args[0]}`);
      case "resolve":
        pairArg();
        return await admin(settings, "POST", `/admin/resolve/${args[0]}/${args[1] ?? ""}`);
      default:
        console.error(`unknown command ${cmd}`);
        process.exit(2);
    }
  } catch (e) {
    if (e instanceof Halt) console.error(e.message);
    else console.error(e);
    process.exit(1);
  }
}

await main();
