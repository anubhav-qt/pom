import type pg from "pg";

import {
  applyChanges,
  commonTables,
  fetchRows,
  group,
  missingParents,
  readChanges,
  size,
  type Changeset,
  type Conflict,
  type ReadResult,
} from "./apply.ts";
import type { PairConfig, Settings } from "./config.ts";
import { discard, errText, isAuthError, lit, log, makePool, q, redact, sleep, tx, type Client } from "./db.ts";
import { ensureTriggers, installBase, instanceId, loadMeta, topoOrder, type Meta, type Table } from "./schema.ts";

const LOCK_KEY = "hashtext('paribelle_sync')";

export interface PairStatus {
  pair: string;
  ready: boolean;
  /** Serving without having caught up with the cloud, because it can't be reached. */
  degraded: boolean;
  /** Why the sync refuses to run, when it does. */
  halted: string | null;
  drained: boolean;
  /** The apps behind this pair answer their health checks (see PairConfig.appHealth). */
  appsUp: boolean;
  cloudReachable: boolean;
  lastCycleAt: string | null;
  lastCycleMs: number | null;
  pulled: number;
  pushed: number;
  pullBacklog: boolean;
  pushBacklog: boolean;
  /** Since when pushes to the cloud have been failing: its copy falls further behind meanwhile. */
  pushFailingSince: string | null;
  openConflicts: number;
  lastError: string | null;
  cloudSizeMb: number | null;
  lastPruneAt: string | null;
  lastReconcileAt: string | null;
}

/** Metadata for one cycle: which tables sync, in which order, with each side's view of them. */
export interface Shape {
  local: Meta;
  cloud: Meta;
  synced: string[];
  order: string[];
  /** Target-side tables restricted to the columns the other side has too. */
  intoLocal: Map<string, Table>;
  intoCloud: Map<string, Table>;
  /** Per table, the common column list; a change means a migration landed on one side. */
  signature: Map<string, string>;
  loadedAt: number;
}

/**
 * One ThinkPad database and its cloud copy (`shop` ↔ the API's Supabase,
 * `oms` ↔ the OMS's Supabase), synced both ways.
 *
 * Each cycle pulls the cloud's changes into the ThinkPad first, then pushes
 * the ThinkPad's changes out. The ThinkPad only counts as ready (and the gate
 * only lets traffic through) once a pull has found nothing more waiting, so
 * whatever the fallback wrote during an outage is back before the ThinkPad
 * serves again.
 */
export class Pair {
  readonly name: string;
  readonly cfg: PairConfig;
  readonly settings: Settings;
  readonly local: pg.Pool;
  readonly cloud: pg.Pool;

  private shape: Shape | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private cloudLock: pg.PoolClient | null = null;
  private lockPing: ReturnType<typeof setInterval> | null = null;
  private localLock: pg.PoolClient | null = null;
  private startedAt = Date.now();
  private cloudFailingSince: number | null = null;
  private localFailingSince: number | null = null;
  private nextCloudTry = 0;
  private cloudFailures = 0;
  private lastSeqCheck = 0;
  private lastTrim = 0;
  private lastConflictCount = 0;
  private lastPushWarning = 0;
  /** What the push being attempted sends, per table, for the warning when pushes keep failing. */
  private pushBatch: Record<string, string> = {};
  private appsUp: boolean;
  /** Bumped whenever the ThinkPad stops counting as caught up; only a pull begun after that counts. */
  private undrains = 0;
  private reconcileQueue = new Map<string, "local" | "cloud" | null>();
  internetOk = true;

  status: PairStatus;

  constructor(cfg: PairConfig, settings: Settings) {
    this.name = cfg.name;
    this.cfg = cfg;
    this.settings = settings;
    this.local = makePool(cfg.localUrl, 4, `paribelle-sync-${cfg.name}`);
    this.cloud = makePool(cfg.cloudUrl, 3, `paribelle-sync-${cfg.name}`);
    this.appsUp = cfg.appHealth.length === 0;
    this.status = {
      pair: cfg.name,
      ready: false,
      degraded: false,
      halted: null,
      drained: false,
      appsUp: this.appsUp,
      cloudReachable: false,
      lastCycleAt: null,
      lastCycleMs: null,
      pulled: 0,
      pushed: 0,
      pullBacklog: false,
      pushBacklog: false,
      pushFailingSince: null,
      openConflicts: 0,
      lastError: null,
      cloudSizeMb: null,
      lastPruneAt: null,
      lastReconcileAt: null,
    };
  }

  /** Runs `fn` after whatever this pair is already doing, never alongside it. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * Whether the ThinkPad may serve this pair's apps right now. Asked by the
   * gate on every request, so it only reads state.
   */
  isReady(now = Date.now()): boolean {
    const s = this.status;
    let ready: boolean;
    let degraded = false;
    if (s.halted || this.localFailingSince !== null || !this.appsUp) ready = false;
    else if (s.drained) ready = true;
    else if (this.cloudFailingSince !== null && now - this.startedAt > this.settings.bootGraceMs && this.internetOk) {
      // The cloud has been out of reach since boot and the internet works, so the
      // fallback can't be writing to it either: serve rather than stay dark.
      ready = true;
      degraded = true;
    } else ready = false;
    s.ready = ready;
    s.degraded = degraded;
    return ready;
  }

  /** Called every second. Catches a suspended laptop and a lost internet connection. */
  tick(gapMs: number) {
    if (gapMs > this.settings.suspendGapMs && this.status.drained) {
      log("warn", "the process was paused (sleep?); catching up before serving", { pair: this.name, gapMs });
      this.undrain();
    }
    if (this.cloudFailingSince !== null && !this.internetOk && this.status.drained) {
      log("warn", "offline; the fallback may be taking writes, so catch up before serving again", { pair: this.name });
      this.undrain();
    }
  }

  /**
   * Whether every app behind this pair answers (main.ts asks them every few seconds).
   * While one doesn't, the fallback serves the whole pair, so a restarting API never
   * leaves the ThinkPad's storefront half working. Back up, the ThinkPad first catches
   * up with whatever the fallback took meanwhile.
   */
  setAppsUp(up: boolean, why?: string) {
    if (up === this.appsUp) return;
    this.appsUp = up;
    this.status.appsUp = up;
    if (up) {
      log("info", "the apps answer again; catching up before serving", { pair: this.name });
      this.undrain();
    } else log("warn", "an app stopped answering; the fallback is serving", { pair: this.name, why });
  }

  private undrain() {
    this.status.drained = false;
    this.undrains++;
  }

  cloudFailingFor(now = Date.now()): number {
    return this.cloudFailingSince === null ? 0 : now - this.cloudFailingSince;
  }

  // ---------------------------------------------------------------- state

  private async getState(c: Client | pg.Pool, key: string): Promise<string | null> {
    const r = await c.query<{ value: string }>(`select value from paribelle_sync.state where key = $1`, [key]);
    return r.rows[0]?.value ?? null;
  }

  static async setState(c: Client | pg.Pool, key: string, value: string) {
    await c.query(
      `insert into paribelle_sync.state (key, value, updated_at) values ($1, $2, now())
       on conflict (key) do update set value = excluded.value, updated_at = now()`,
      [key, value],
    );
  }

  // ---------------------------------------------------------------- metadata

  private isSyncedName(t: string) {
    return !this.cfg.exclude.includes(t);
  }

  /** Loads both sides' tables, installs missing triggers, and notices migrations. */
  async refreshShape(force = false): Promise<Shape> {
    if (!force && this.shape && Date.now() - this.shape.loadedAt < this.settings.metaRefreshMs) return this.shape;
    const [local, cloud] = await Promise.all([loadMeta(this.local), loadMeta(this.cloud)]);
    const both = [...local.tables.keys()].filter((t) => cloud.tables.has(t) && this.isSyncedName(t));
    const onlyLocal = [...local.tables.keys()].filter((t) => !cloud.tables.has(t) && this.isSyncedName(t));
    const onlyCloud = [...cloud.tables.keys()].filter((t) => !local.tables.has(t) && this.isSyncedName(t));
    const synced = new Set(both);
    const order = topoOrder(both, local.fks);

    const signature = new Map<string, string>();
    for (const t of both) {
      const lc = new Set(local.tables.get(t)!.columns.map((c) => c.name));
      const common = cloud.tables.get(t)!.columns.map((c) => c.name).filter((c) => lc.has(c)).sort();
      signature.set(t, `${local.tables.get(t)!.pk.join()}|${common.join()}`);
    }

    const prev = this.shape;
    if (prev) {
      for (const t of both) {
        const before = prev.signature.get(t);
        if (before === undefined) {
          log("info", "table now on both sides; reconciling it", { pair: this.name, table: t });
          this.reconcileQueue.set(t, null);
        } else if (before !== signature.get(t)) {
          log("info", "table's columns changed; reconciling it", { pair: this.name, table: t });
          this.reconcileQueue.set(t, null);
        }
      }
    }
    if (!prev || prev.synced.join() !== both.join()) {
      if (onlyLocal.length) log("warn", "tables only on the ThinkPad (not synced until the cloud has them)", { pair: this.name, tables: onlyLocal });
      if (onlyCloud.length) log("warn", "tables only in the cloud (not synced)", { pair: this.name, tables: onlyCloud });
      const noPk = [...new Set([...local.noPk, ...cloud.noPk])].filter((t) => this.isSyncedName(t));
      if (noPk.length) log("warn", "tables without a primary key can't be synced", { pair: this.name, tables: noPk });
    }

    await ensureTriggers(this.local, local, synced);
    await ensureTriggers(this.cloud, cloud, synced);

    this.shape = {
      local,
      cloud,
      synced: both,
      order,
      intoLocal: commonTables(local, cloud, both),
      intoCloud: commonTables(cloud, local, both),
      signature,
      loadedAt: Date.now(),
    };
    return this.shape;
  }

  // ---------------------------------------------------------------- startup

  /**
   * Checks the pair was bootstrapped, and takes the ThinkPad-side lock that
   * stops a second sync (a stray container, a second stack) from working the
   * same database.
   */
  private async prepareLocal(): Promise<{ pull: string; push: string; cloudInstance: string }> {
    if (!this.localLock) {
      await installBase(this.local, "local");
      const c = await this.local.connect();
      const got = await c.query<{ ok: boolean }>(`select pg_try_advisory_lock(${LOCK_KEY}) as ok`).catch((e) => {
        c.release(true);
        throw e;
      });
      if (!got.rows[0].ok) {
        c.release();
        throw new Halt("another sync is running against the ThinkPad's database");
      }
      this.localLock = c;
      c.on("error", () => {
        this.localLock = null;
      });
    }
    const [pull, push, cloudInstance] = await Promise.all([
      this.getState(this.local, "pull"),
      this.getState(this.local, "push"),
      this.getState(this.local, "cloud_instance"),
    ]);
    if (!pull || !push || !cloudInstance) {
      throw new Halt(`not bootstrapped: run \`sync bootstrap ${this.name}\` (see infra/README.md)`);
    }
    return { pull, push, cloudInstance };
  }

  /**
   * Checks the cloud is the database this pair was bootstrapped against, and
   * takes the cloud-side lock, so a second laptop can't sync it at the same time.
   */
  private async prepareCloud(want: string) {
    if (this.cloudLock) return;
    const c = await this.cloud.connect();
    try {
      const have = await instanceId(c);
      if (have !== want) {
        throw new Halt(
          have
            ? "the cloud database is not the one this ThinkPad was bootstrapped against (replaced project?); see README › The cloud database was replaced"
            : "the cloud database has no sync schema (reset or replaced?); see README › The cloud database was replaced",
        );
      }
      const got = await c.query<{ ok: boolean }>(`select pg_try_advisory_lock(${LOCK_KEY}) as ok`);
      if (!got.rows[0].ok && !(await this.takeStaleLock(c))) {
        throw new Halt("another ThinkPad (or a second stack) is syncing this cloud database");
      }
    } catch (e) {
      // Not back into the pool: if this client is what failed, the next check would get it again.
      c.release(true);
      throw e;
    }
    this.cloudLock = c;
    c.on("error", () => {
      if (this.cloudLock === c) this.dropLocks();
    });
    // Keeps the lock's session busy, so takeStaleLock elsewhere never takes it for a dead one.
    // A ping that fails means the lock may be gone with its connection: the next cycle takes it again.
    let pinging = false;
    this.lockPing = setInterval(() => {
      if (pinging || this.cloudLock !== c) return;
      pinging = true;
      c.query("select 1")
        .catch(() => {
          if (this.cloudLock === c) this.dropLocks();
        })
        .finally(() => {
          pinging = false;
        });
    }, this.settings.lockPingMs);
    this.lockPing.unref();
  }

  /**
   * Takes over the cloud lock when the session holding it has done nothing for
   * `staleLockSec`: a sync whose connection vanished (the ThinkPad's internet
   * dropped) while Supabase's pooler kept its session, and the lock, open. On
   * 2026-10-04 that halted both pairs for three hours, until the sessions were
   * ended by hand. A live sync pings its lock's session (prepareCloud), so a
   * second ThinkPad still halts this one. If the database refuses, the lock
   * stays where it is and the sync halted; a lost connection is thrown, as an
   * outage.
   */
  private async takeStaleLock(c: pg.PoolClient): Promise<boolean> {
    try {
      const r = await c.query<{ pid: number; idle: string; ended: boolean }>(
        `select a.pid, date_trunc('second', now() - a.state_change)::text as idle, pg_terminate_backend(a.pid, 5000) as ended
         from pg_locks l join pg_stat_activity a on a.pid = l.pid
         where l.locktype = 'advisory' and l.granted and l.objsubid = 1
           and l.database = (select oid from pg_database where datname = current_database())
           and ((l.classid::bigint << 32) | l.objid::bigint) = ${LOCK_KEY}::bigint
           and a.pid <> pg_backend_pid() and a.state = 'idle'
           and a.state_change < now() - make_interval(secs => $1)`,
        [this.settings.staleLockSec],
      );
      if (!r.rows.length) return false;
      log("warn", "ended a dead sync's session that held the cloud lock", { pair: this.name, ...r.rows[0] });
      const got = await c.query<{ ok: boolean }>(`select pg_try_advisory_lock(${LOCK_KEY}) as ok`);
      return got.rows[0].ok;
    } catch (e) {
      if (!(e as { code?: string })?.code) throw e;
      log("error", "could not take over the cloud lock", { pair: this.name, error: errText(e) });
      return false;
    }
  }

  /**
   * Keeps the two sides from ever handing out the same id.
   *
   * The cloud counts above the ThinkPad: its sequence is kept at least
   * `seqHeadroom` past the ThinkPad's. Ids the cloud hands out come into the
   * ThinkPad above its own sequence, which is left where it is (moving it up
   * to them would set both sides counting from the same place). Once the
   * ThinkPad gets within half the headroom of the lowest id the cloud has used
   * above it, it jumps past everything the cloud has, and the cloud moves on
   * again.
   *
   * Per table, `floor` is where the cloud's sequence was last seen or set (its
   * next ids are above it) and `ceil` the lowest id above the ThinkPad's
   * sequence that the cloud may have used.
   */
  private async syncSequences(shape: Shape) {
    const H = BigInt(this.settings.seqHeadroom);
    const tables = shape.synced
      .map((t) => [shape.local.tables.get(t)!, shape.cloud.tables.get(t)!] as const)
      .filter(([l, c]) => l.sequence && c.sequence && l.sequence.column === c.sequence.column);
    if (!tables.length) return;
    const [cv, marks] = await Promise.all([seqValues(this.cloud), this.seqMarks()]);
    for (const [lt, ct] of tables) {
      const col = lt.sequence!.column;
      const L = await localSeq(this.local, lt.sequence!.name, lt.name, col);
      const C = cv.get(ct.sequence!.name);
      if (!L || !C) continue;
      const m = marks.get(lt.name) ?? { floor: C.value, ceil: null };
      // The cloud went back (restored or reseeded): its next ids start where it is now.
      if (C.value < m.floor) m.floor = C.value;
      // The cloud handed out ids since the last look, just past where it was.
      if (C.value > m.floor) {
        m.ceil = minOf(m.ceil, m.floor + 1n);
        m.floor = C.value;
      }
      // Rows already sitting above the ThinkPad's sequence, on either side.
      m.ceil = minOf(m.ceil, minOf(L.above, await idAbove(this.cloud, ct.name, col, L.value)));
      if (m.ceil !== null && m.ceil <= L.value) m.ceil = null;

      if (m.ceil !== null && m.ceil - L.value - 1n < H / 2n) {
        const [lTop, cTop] = await Promise.all([topId(this.local, lt.name, col), topId(this.cloud, ct.name, col)]);
        const to = maxOf(L.value, C.value, m.floor, lTop, cTop) + H;
        if (to + H > (L.max < C.max ? L.max : C.max)) {
          log("error", "id sequence close to its maximum; widen the column to bigint", { pair: this.name, table: lt.name });
          continue;
        }
        await raiseSeq(this.cloud, ct.sequence!.name, to + H);
        await raiseSeq(this.local, lt.sequence!.name, to);
        log("info", "ThinkPad ids jumped past the cloud's", {
          pair: this.name,
          table: lt.name,
          from: L.value.toString(),
          to: to.toString(),
          cloudUsedFrom: m.ceil.toString(),
          cloudAt: C.value.toString(),
        });
        m.floor = to + H;
        m.ceil = null;
      } else if (C.value < L.value + H && L.value + H <= C.max) {
        await raiseSeq(this.cloud, ct.sequence!.name, L.value + H);
        m.floor = L.value + H;
      }
      marks.set(lt.name, m);
    }
    await this.saveSeqMarks(marks);
  }

  /**
   * While the cloud can't be reached its sequence can't be moved on, so if
   * the ThinkPad gets near where the cloud counts from, it jumps ahead alone,
   * leaving the cloud the headroom below it. The cloud is moved past it once
   * it's back.
   */
  private async guardLocalSequences() {
    const H = BigInt(this.settings.seqHeadroom);
    const meta = this.shape?.local ?? (await loadMeta(this.local));
    const [lv, marks] = await Promise.all([seqValues(this.local), this.seqMarks()]);
    let moved = false;
    for (const t of meta.tables.values()) {
      const m = marks.get(t.name);
      const L = t.sequence && lv.get(t.sequence.name);
      if (!m || !L || !t.sequence) continue;
      const limit = L.value < m.floor ? minOf(m.ceil, m.floor + 1n) : m.ceil;
      if (limit === null || limit - L.value - 1n >= H / 2n) continue;
      const to = maxOf(L.value, m.floor, await topId(this.local, t.name, t.sequence.column)) + H;
      if (to > L.max) continue;
      await raiseSeq(this.local, t.sequence.name, to);
      log("warn", "ThinkPad ids jumped ahead while the cloud is out of reach", { pair: this.name, table: t.name, to: to.toString() });
      m.ceil = null;
      moved = true;
    }
    if (moved) await this.saveSeqMarks(marks);
  }

  private async seqMarks(): Promise<Map<string, SeqMark>> {
    const raw = JSON.parse((await this.getState(this.local, "sequences")) ?? "{}") as Record<string, { floor: string; ceil: string | null }>;
    return new Map(Object.entries(raw).map(([t, m]) => [t, { floor: BigInt(m.floor), ceil: m.ceil === null ? null : BigInt(m.ceil) }]));
  }

  private async saveSeqMarks(marks: Map<string, SeqMark>) {
    const raw = Object.fromEntries([...marks].map(([t, m]) => [t, { floor: m.floor.toString(), ceil: m.ceil?.toString() ?? null }]));
    await Pair.setState(this.local, "sequences", JSON.stringify(raw));
  }

  // ---------------------------------------------------------------- the cycle

  /** One round: pull, then push. Returns whether more is waiting. */
  async cycle(): Promise<boolean> {
    const t0 = Date.now();
    const undrains = this.undrains;
    if (this.cloudFailingSince !== null && t0 - this.lastSeqCheck > 10_000) {
      this.lastSeqCheck = t0;
      await this.guardLocalSequences().catch((e) => log("error", "could not check id sequences", { pair: this.name, error: errText(e) }));
    }
    if (Date.now() < this.nextCloudTry) return false;

    let pos: { pull: string; push: string; cloudInstance: string };
    try {
      pos = await this.prepareLocal();
      this.localFailingSince = null;
    } catch (e) {
      if (!(e instanceof Halt)) this.localFailingSince ??= Date.now();
      return this.failed(e);
    }
    try {
      await this.prepareCloud(pos.cloudInstance);
    } catch (e) {
      return this.failed(e);
    }
    // Both checks pass: whatever halted the sync is gone. It still catches up before serving (see failed).
    if (this.status.halted) {
      log("info", "the sync's checks pass again; catching up before serving", { pair: this.name, was: this.status.halted });
      this.status.halted = null;
    }

    let shape: Shape;
    let cloudRead: ReadResult;
    let localRead: ReadResult;
    let pullRows = new Map<string, Map<string, string>>();
    let C: Changeset;
    let L: Changeset;
    const conflicts: Conflict[] = [];
    // Keys changed on both sides since the last cycle, and the losing version of each.
    const both: { tbl: string; key: string; kept: "local" | "cloud" }[] = [];
    const lost = new Map<string, string>();

    try {
      shape = await this.refreshShape();
      const synced = new Set(shape.synced);
      const wPull = pos.pull;
      const wPush = pos.push;

      // 1. The cloud's changes, and the rows as they are now, from one snapshot.
      const cc = await this.cloud.connect();
      try {
        await cc.query("begin isolation level repeatable read read only");
        await cc.query("set local timezone = 'UTC'");
        cloudRead = await readChanges(cc, wPull, this.settings.pageSize);
        // 2. The ThinkPad's changes.
        localRead = await tx(this.local, { repeatableRead: true, readOnly: true }, (c) => readChanges(c, wPush, this.settings.pageSize));

        C = group(cloudRead.entries);
        L = group(localRead.entries);
        for (const cs of [C, L]) for (const t of [...cs.keys.keys()]) if (!synced.has(t)) cs.keys.delete(t);

        // 3. A key changed on both sides since the last cycle: the later change wins.
        for (const [tbl, ck] of C.keys) {
          const lk = L.keys.get(tbl);
          if (!lk) continue;
          for (const [key, cloudAt] of ck) {
            const localAt = lk.get(key);
            if (!localAt) continue;
            if (cloudAt > localAt) lk.delete(key);
            else ck.delete(key);
            both.push({ tbl, key, kept: cloudAt > localAt ? "cloud" : "local" });
          }
        }
        await this.losers(cc, shape.cloud, both, "local", lost);
        for (const t of C.truncated) if (synced.has(t)) this.reconcileQueue.set(t, "cloud");
        for (const t of L.truncated) if (synced.has(t)) this.reconcileQueue.set(t, "local");

        for (const [tbl, keys] of C.keys) {
          if (keys.size) pullRows.set(tbl, await fetchRows(cc, shape.cloud.tables.get(tbl)!, [...keys.keys()]));
        }
        await cc.query("commit");
      } catch (e) {
        await discard(cc, e);
        throw e;
      }
      cc.release();
      this.cloudOk();
    } catch (e) {
      return this.failed(e);
    }

    // 4. Into the ThinkPad, advancing the pull position in the same transaction.
    let pulled = 0;
    try {
      const res = await tx(this.local, { applying: true }, async (lc) => {
        await this.losers(lc, shape.local, both, "cloud", lost);
        const r = await applyChanges({
          side: "local",
          target: lc,
          pendingFrom: localRead.xmin,
          order: shape.order,
          tables: shape.intoLocal,
          fks: shape.local.fks,
          changedAt: C.keys,
          rows: pullRows,
        });
        await Pair.setState(lc, "pull", cloudRead.next);
        return r;
      });
      pulled = size(C);
      for (const b of both) {
        const lostRow = lost.get(`${b.tbl}|${b.key}`) ?? null;
        conflicts.push({ tbl: b.tbl, pk: b.key, kept: b.kept, lostRow, reason: "changed on both sides in the same cycle" });
      }
      conflicts.push(...res.conflicts);
      if (!cloudRead.full && !this.status.drained && undrains === this.undrains) {
        this.status.drained = true;
        log("info", "caught up with the cloud; serving", { pair: this.name });
      }
      this.status.pullBacklog = cloudRead.full;
    } catch (e) {
      this.localFailingSince ??= Date.now();
      return this.failed(e);
    }
    pullRows = new Map();

    // 5. Out to the cloud, reading the ThinkPad's rows as they are now.
    let pushed = 0;
    let pushDone = false;
    this.pushBatch = {};
    try {
      if (size(L) > 0) {
        const res = await this.pushKeys(shape, L, cloudRead.xmin);
        conflicts.push(...res);
        pushed = size(L);
      }
      await Pair.setState(this.local, "push", localRead.next);
      pushDone = true;
      this.pushOk();
      this.status.pushBacklog = localRead.full;

      if (pulled || pushed || Date.now() - this.lastSeqCheck > 10_000) {
        await this.syncSequences(shape);
        this.lastSeqCheck = Date.now();
      }
      if (Date.now() - this.lastTrim > 60_000) {
        await this.trim(cloudRead.next, localRead.next);
        this.lastTrim = Date.now();
      }
    } catch (e) {
      await this.recordConflicts(conflicts);
      if (!pushDone) this.pushFailed(e);
      return this.failed(e);
    }

    await this.recordConflicts(conflicts);
    if (this.reconcileQueue.size) {
      const [tbl, prefer] = this.reconcileQueue.entries().next().value!;
      this.reconcileQueue.delete(tbl);
      try {
        const { reconcileTable } = await import("./ops.ts");
        await reconcileTable(this, tbl, prefer);
      } catch (e) {
        log("error", "reconcile failed", { pair: this.name, table: tbl, error: errText(e) });
      }
    }

    this.status.pulled += pulled;
    this.status.pushed += pushed;
    this.status.lastCycleAt = new Date().toISOString();
    this.status.lastCycleMs = Date.now() - t0;
    this.status.lastError = null;
    if (pulled || pushed) log("info", "synced", { pair: this.name, pulled, pushed, ms: Date.now() - t0 });
    return cloudRead.full || localRead.full;
  }

  /** Reads the version of each key that `side` is about to lose into `lost` (absent: deleted there). */
  private async losers(c: Client, meta: Meta, both: { tbl: string; key: string; kept: string }[], kept: string, lost: Map<string, string>) {
    const byTable = new Map<string, string[]>();
    for (const b of both) if (b.kept === kept) byTable.set(b.tbl, [...(byTable.get(b.tbl) ?? []), b.key]);
    for (const [tbl, keys] of byTable) {
      for (const [key, row] of await fetchRows(c, meta.tables.get(tbl)!, keys)) lost.set(`${tbl}|${key}`, row);
    }
  }

  /** Writes the ThinkPad's current version of each changed key into the cloud. */
  async pushKeys(shape: Shape, L: Changeset, cloudPendingFrom: string): Promise<Conflict[]> {
    const lc = await this.local.connect();
    const rehydrated: { tbl: string; key: string }[] = [];
    let conflicts: Conflict[];
    try {
      await lc.query("begin isolation level repeatable read read only");
      await lc.query("set local timezone = 'UTC'");
      const rows = new Map<string, Map<string, string>>();
      for (const [tbl, keys] of L.keys) {
        if (keys.size && !this.cfg.localOnly.includes(tbl)) {
          rows.set(tbl, await fetchRows(lc, shape.local.tables.get(tbl)!, [...keys.keys()]));
        }
      }
      this.pushBatch = Object.fromEntries(
        [...rows].map(([tbl, m]) => [tbl, `${m.size} rows, ${(sumLength(m.values()) / 1048576).toFixed(1)} MB`]),
      );
      const changedAt = new Map([...L.keys].filter(([t]) => !this.cfg.localOnly.includes(t)));

      const res = await tx(this.cloud, { applying: true }, async (cc) => {
        const ensureParents = async (tbl: string, childRows: string[], seen = new Set<string>()): Promise<void> => {
          for (const fk of shape.cloud.fks) {
            if (fk.child !== tbl || !shape.synced.includes(fk.parent) || this.cfg.localOnly.includes(fk.parent)) continue;
            const parent = shape.intoCloud.get(fk.parent)!;
            let missing = await missingParents(cc, fk, parent, childRows);
            if (fk.parent === tbl) {
              // A row further down this same batch is not missing.
              const inBatch = new Set(childRows.map((r) => keyOfRow(parent, r)));
              missing = missing.filter((k) => !inBatch.has(k));
            }
            missing = missing.filter((k) => !seen.has(`${fk.parent}|${k}`));
            if (!missing.length) continue;
            // Deleted in the cloud but not yet pulled: the delete wins, the child fails and is recorded.
            const pend = await cc.query<{ k: string }>(
              `select distinct pk::text as k from paribelle_sync.changes where txid >= $1::xid8 and tbl = $2 and pk::text = any($3::text[])`,
              [cloudPendingFrom, fk.parent, missing],
            );
            const blocked = new Set(pend.rows.map((r) => r.k));
            missing = missing.filter((k) => !blocked.has(k));
            if (!missing.length) continue;
            const found = await fetchRows(lc, shape.local.tables.get(fk.parent)!, missing);
            if (!found.size) continue;
            for (const k of found.keys()) seen.add(`${fk.parent}|${k}`);
            await ensureParents(fk.parent, [...found.values()], seen);
            await applyChanges({
              side: "cloud",
              target: cc,
              pendingFrom: cloudPendingFrom,
              order: [fk.parent],
              tables: shape.intoCloud,
              fks: shape.cloud.fks,
              changedAt: new Map([[fk.parent, new Map([...found.keys()].map((k) => [k, BigInt(Date.now()) * 1000n]))]]),
              rows: new Map([[fk.parent, found]]),
            });
            for (const k of found.keys()) rehydrated.push({ tbl: fk.parent, key: k });
            log("info", "put pruned rows back in the cloud for a new row that points at them", {
              pair: this.name,
              table: fk.parent,
              count: found.size,
            });
          }
        };
        return applyChanges({
          side: "cloud",
          target: cc,
          pendingFrom: cloudPendingFrom,
          order: shape.order,
          tables: shape.intoCloud,
          fks: shape.cloud.fks,
          changedAt,
          rows,
          skip: (tbl, keys) => this.prunedKeys(lc, tbl, keys),
          ensureParents: (tbl, r) => ensureParents(tbl, r),
        });
      });
      await lc.query("commit");
      conflicts = res.conflicts;
    } catch (e) {
      await discard(lc, e);
      throw e;
    }
    lc.release();
    for (const { tbl, key } of rehydrated) {
      await this.local.query(`delete from paribelle_sync.pruned where tbl = $1 and pk = $2::jsonb`, [tbl, key]);
    }
    return conflicts;
  }

  /**
   * Writes the cloud's current version of the given keys into the ThinkPad
   * (reconcile). `pendingFrom` is where the ThinkPad's unread changes start.
   */
  async pullKeys(shape: Shape, cs: Changeset, pendingFrom: string): Promise<Conflict[]> {
    const rows = new Map<string, Map<string, string>>();
    await tx(this.cloud, { repeatableRead: true, readOnly: true }, async (cc) => {
      for (const [tbl, keys] of cs.keys) {
        if (keys.size) rows.set(tbl, await fetchRows(cc, shape.cloud.tables.get(tbl)!, [...keys.keys()]));
      }
    });
    const res = await tx(this.local, { applying: true }, (lc) =>
      applyChanges({
        side: "local",
        target: lc,
        pendingFrom,
        order: shape.order,
        tables: shape.intoLocal,
        fks: shape.local.fks,
        changedAt: cs.keys,
        rows,
      }),
    );
    return res.conflicts;
  }

  /** Whether bootstrap has run against the ThinkPad's database. */
  async bootstrapped(): Promise<boolean> {
    try {
      const r = await this.local.query<{ n: number }>(
        `select count(*)::int as n from paribelle_sync.state where key in ('pull', 'push', 'cloud_instance')`,
      );
      return r.rows[0].n === 3;
    } catch {
      return false;
    }
  }

  /** Where each direction has read up to. */
  async positions(): Promise<{ pull: string; push: string }> {
    const [pull, push] = await Promise.all([this.getState(this.local, "pull"), this.getState(this.local, "push")]);
    if (!pull || !push) throw new Halt("not bootstrapped");
    return { pull, push };
  }

  async prunedKeys(c: Client | pg.Pool, tbl: string, keys: string[]): Promise<Set<string>> {
    const r = await c.query<{ k: string }>(
      `select pk::text as k from paribelle_sync.pruned where tbl = $1 and pk::text = any($2::text[])`,
      [tbl, keys],
    );
    return new Set(r.rows.map((x) => x.k));
  }

  /** Change records both sides have read: the cloud's go soon (space is tight there), the ThinkPad's after a week. */
  private async trim(pull: string, push: string) {
    await this.cloud.query(
      `delete from paribelle_sync.changes where txid < $1::xid8 and at < now() - make_interval(secs => $2)`,
      [pull, this.settings.cloudChangeRetentionSec],
    );
    await this.local.query(
      `delete from paribelle_sync.changes where txid < $1::xid8 and at < now() - make_interval(secs => $2)`,
      [push, this.settings.localChangeRetentionSec],
    );
    const open = await this.local.query<{ n: number }>(`select count(*)::int as n from paribelle_sync.conflicts where resolved_at is null`);
    this.status.openConflicts = open.rows[0].n;
    const sz = await this.cloud.query<{ mb: number }>(`select (pg_database_size(current_database()) / 1048576)::int as mb`);
    this.status.cloudSizeMb = sz.rows[0].mb;
  }

  /**
   * Records conflicts for someone to look at. One already open with the same
   * row, outcome and reason isn't recorded again: a row that can't be applied
   * fails the same way at every reconcile and every retried push.
   */
  async recordConflicts(conflicts: Conflict[]) {
    if (!conflicts.length) return;
    try {
      const r = await this.local.query(
        `insert into paribelle_sync.conflicts (tbl, pk, kept, lost_row, reason)
         select x.tbl, x.pk::jsonb, x.kept, x.lost_row::jsonb, x.reason
         from jsonb_to_recordset($1::jsonb) as x(tbl text, pk text, kept text, lost_row text, reason text)
         where not exists (
           select 1 from paribelle_sync.conflicts o
           where o.resolved_at is null and o.tbl = x.tbl and o.pk = x.pk::jsonb and o.kept = x.kept
             and o.reason = x.reason and o.lost_row is not distinct from x.lost_row::jsonb
         )`,
        [JSON.stringify(conflicts.map((c) => ({ tbl: c.tbl, pk: c.pk, kept: c.kept, lost_row: c.lostRow, reason: c.reason })))],
      );
      const added = r.rowCount ?? 0;
      this.status.openConflicts += added;
      if (this.status.openConflicts !== this.lastConflictCount) {
        log("warn", "conflicts recorded", { pair: this.name, new: added, open: this.status.openConflicts });
        this.lastConflictCount = this.status.openConflicts;
      }
    } catch (e) {
      log("error", "could not record conflicts", { pair: this.name, error: errText(e), conflicts });
    }
  }

  private pushOk() {
    if (this.status.pushFailingSince) {
      log("info", "pushing to the cloud again", { pair: this.name, failingSince: this.status.pushFailingSince });
    }
    this.status.pushFailingSince = null;
    this.lastPushWarning = 0;
  }

  /**
   * A push that failed. Each failure also shows as "cycle failed", next to the
   * pull that worked; this names what is stuck, and repeats every 10 minutes
   * while it stays stuck. (The heartbeat stops too: no cycle completes.)
   */
  private pushFailed(e: unknown) {
    const now = Date.now();
    this.status.pushFailingSince ??= new Date(now).toISOString();
    if (now - this.lastPushWarning < 10 * 60_000) return;
    this.lastPushWarning = now;
    log("warn", "pushes to the cloud are failing; its copy is falling behind", {
      pair: this.name,
      since: this.status.pushFailingSince,
      error: errText(e),
      batch: this.pushBatch,
    });
  }

  private cloudOk() {
    if (this.cloudFailingSince !== null) log("info", "cloud reachable again", { pair: this.name, afterMs: Date.now() - this.cloudFailingSince });
    this.cloudFailingSince = null;
    this.cloudFailures = 0;
    this.status.cloudReachable = true;
    if (this.status.degraded) this.status.degraded = false;
  }

  /** Records a failed cycle and decides when to try again. Never throws. */
  private failed(e: unknown): false {
    const msg = errText(e);
    if (e instanceof Halt) {
      if (this.status.halted !== msg) log("error", "sync halted", { pair: this.name, reason: msg });
      this.status.halted = msg;
      // The fallback serves meanwhile; once the halt lifts (cycle), the ThinkPad catches up with it first.
      this.undrain();
      this.nextCloudTry = Date.now() + 30_000;
      return false;
    }
    // A halt stays until its checks pass (cycle): an outage meanwhile says nothing about its cause.
    this.status.lastError = msg;
    const local = this.localFailingSince !== null;
    if (!local) {
      this.cloudFailingSince ??= Date.now();
      this.status.cloudReachable = false;
      this.cloudFailures++;
      // Supabase's pooler blocks a whole project after repeated bad logins: wait minutes, not seconds.
      const wait = isAuthError(e) ? 300_000 : Math.min(60_000, 1000 * 2 ** Math.min(this.cloudFailures, 6));
      this.nextCloudTry = Date.now() + wait;
      // Held locks are on connections that may be gone.
      this.dropLocks();
      if (this.cloudFailures === 1 || this.cloudFailures % 20 === 0 || isAuthError(e)) {
        log("warn", "cycle failed", { pair: this.name, error: msg, retryInMs: wait, cloud: redact(this.cfg.cloudUrl) });
      }
    } else {
      log("error", "ThinkPad database unavailable", { pair: this.name, error: msg });
      this.status.drained = false;
      this.nextCloudTry = Date.now() + 2000;
    }
    return false;
  }

  private dropLocks() {
    if (this.lockPing) {
      clearInterval(this.lockPing);
      this.lockPing = null;
    }
    if (this.cloudLock) {
      this.cloudLock.release(true);
      this.cloudLock = null;
    }
  }

  /** The daemon loop for this pair. */
  async run(signal: AbortSignal) {
    while (!signal.aborted) {
      const more = await this.exclusive(() => this.cycle()).catch((e) => this.failed(e));
      if (!more) await sleep(this.settings.intervalMs);
    }
  }

  async close() {
    this.dropLocks();
    this.localLock?.release(true);
    this.localLock = null;
    await Promise.allSettled([this.local.end(), this.cloud.end()]);
  }
}

export class Halt extends Error {}

interface SeqMark {
  floor: bigint;
  ceil: bigint | null;
}

async function seqValues(c: pg.Pool): Promise<Map<string, { value: bigint; max: bigint }>> {
  const r = await c.query<{ name: string; v: string; max: string }>(
    `select sequencename as name, coalesce(last_value, start_value - 1)::text as v, max_value::text as max
     from pg_sequences where schemaname = 'public'`,
  );
  return new Map(r.rows.map((x) => [x.name, { value: BigInt(x.v), max: BigInt(x.max) }]));
}

/**
 * The ThinkPad's sequence and the lowest id above it. One statement, so a row
 * the app inserts meanwhile can't pass for one above the sequence: every row
 * the statement sees was numbered before the sequence is read.
 */
async function localSeq(c: pg.Pool, seq: string, tbl: string, col: string) {
  const r = await c.query<{ v: string; max: string; above: string | null }>(
    `select s.v::text as v, s.max::text as max,
       (select min(${q(col)}) from public.${q(tbl)} where ${q(col)} > s.v)::text as above
     from (select coalesce(last_value, start_value - 1) as v, max_value as max from pg_sequences
           where schemaname = 'public' and sequencename = $1) s`,
    [seq],
  );
  const x = r.rows[0];
  return x && { value: BigInt(x.v), max: BigInt(x.max), above: x.above === null ? null : BigInt(x.above) };
}

async function idAbove(c: pg.Pool, tbl: string, col: string, above: bigint): Promise<bigint | null> {
  const r = await c.query<{ m: string | null }>(
    `select min(${q(col)})::text as m from public.${q(tbl)} where ${q(col)} > $1::bigint`,
    [above.toString()],
  );
  return r.rows[0].m === null ? null : BigInt(r.rows[0].m);
}

async function topId(c: pg.Pool, tbl: string, col: string): Promise<bigint> {
  const r = await c.query<{ m: string | null }>(`select max(${q(col)})::text as m from public.${q(tbl)}`);
  return BigInt(r.rows[0].m ?? "0");
}

/** Moves a sequence up to `to`, never down. */
async function raiseSeq(c: pg.Pool, name: string, to: bigint) {
  await c.query(
    `select setval(${lit(`public.${q(name)}`)}, $1::bigint)
     where $1::bigint > coalesce((select last_value from pg_sequences where schemaname = 'public' and sequencename = $2), 0)`,
    [to.toString(), name],
  );
}

function sumLength(xs: Iterable<string>): number {
  let n = 0;
  for (const x of xs) n += x.length;
  return n;
}

function minOf(a: bigint | null, b: bigint | null): bigint | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

function maxOf(...xs: bigint[]): bigint {
  return xs.reduce((m, x) => (x > m ? x : m));
}

/** The canonical key text of a row given as json text. */
function keyOfRow(t: Table, row: string): string {
  const obj = JSON.parse(row) as Record<string, unknown>;
  const key: Record<string, unknown> = {};
  for (const c of [...t.pk].sort()) key[c] = obj[c];
  return canonicalJson(key);
}

/** jsonb's text form for a flat object: keys by length then bytes, ", " and ": " separators. */
export function canonicalJson(o: Record<string, unknown>): string {
  const keys = Object.keys(o).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}: ${JSON.stringify(o[k])}`).join(", ")}}`;
}
