import assert from "node:assert/strict";
import { after, test } from "node:test";

import { applyChanges } from "../src/apply.ts";
import { tx } from "../src/db.ts";
import { prune, reconcileAll, reseedCloud } from "../src/ops.ts";
import { Pair } from "../src/pair.ts";
import { assertConverged, close, cloudExtension, conflicts, pairConfig, rows, settle, setup, testSettings } from "./helpers.ts";

type Setup = Awaited<ReturnType<typeof setup>>;
let current: Setup | null = null;
async function fresh(opts: Parameters<typeof setup>[0] = {}) {
  if (current) await close(current.pair, current.local, current.cloud);
  current = await setup(opts);
  return current;
}
after(async () => {
  if (current) await close(current.pair, current.local, current.cloud);
});

test("bootstrap copies the cloud, and the first cycle has nothing to do", async () => {
  const { pair, local } = await fresh();
  const o = await local.query(`select count(*)::int as n from orders`);
  assert.equal(o.rows[0].n, 3);
  const m = await local.query(`select count(*)::int as n from migrations`);
  assert.equal(m.rows[0].n, 1, "excluded tables are copied once, then left alone");
  assert.equal(pair.isReady(), false, "not ready before a cycle");
  await settle(pair);
  assert.equal(pair.isReady(), true);
  await assertConverged(pair);
  assert.deepEqual(await conflicts(pair), []);
});

test("ThinkPad writes reach the cloud, cascades and all", async () => {
  const { pair, local, cloud } = await fresh();
  await settle(pair);
  await local.query(`insert into accounts (name) values ('meesho')`);
  await local.query(`insert into orders (account_id, ext, status) values (3, 'm-1', 'packed')`);
  await local.query(`update products set cost = 550.25, name = 'Kurta set' where sku = 'A'`);
  await local.query(`delete from accounts where name = 'flipkart'`); // cascades to f-1 and its item
  await local.query(`insert into labels (pdf) values ('\\x255044462d312e37'::bytea)`);
  await local.query(`insert into categories (id, name) values ('00000000-0000-0000-0000-00000000000a', 'Women')`);
  await local.query(`insert into categories (parent_id, name) values ('00000000-0000-0000-0000-00000000000a', 'Kurtis')`);
  await local.query(`insert into batch_orders values (7, 1), (7, 2)`);
  await local.query(`insert into notes (body) values ('hello world')`);
  await local.query(`insert into reel_jobs (output) values ('\\x00')`);
  await local.query(`insert into migrations (name) values ('local only')`);
  await settle(pair);
  await assertConverged(pair);

  const reels = await cloud.query(`select count(*)::int as n from reel_jobs`);
  assert.equal(reels.rows[0].n, 0, "ThinkPad-only tables stay on the ThinkPad");
  const mig = await cloud.query(`select count(*)::int as n from migrations`);
  assert.equal(mig.rows[0].n, 1, "excluded tables are never synced");
  const seq = await cloud.query(`select last_value::int as v from pg_sequences where sequencename = 'orders_id_seq'`);
  assert.ok(seq.rows[0].v >= 4 + 1000, `cloud sequence kept ahead of the ThinkPad (got ${seq.rows[0].v})`);
});

test("cloud writes come home without echoing back", async () => {
  const { pair, local, cloud } = await fresh();
  await settle(pair);
  await cloud.query(`insert into orders (account_id, ext) values (2, 'f-2')`);
  await cloud.query(`update orders set status = 'shipped' where ext = 'o-1'`);
  await cloud.query(`delete from order_items where order_id = 2`);
  await settle(pair);
  await assertConverged(pair);
  const echo = await local.query(`select count(*)::int as n from paribelle_sync.changes`);
  assert.equal(echo.rows[0].n, 0, "applying a pulled change logs nothing on the ThinkPad");
  // The ThinkPad's next id must not collide with what the cloud used, now or later.
  const cloudIds = new Set((await cloud.query(`select id from orders`)).rows.map((r) => r.id));
  await local.query(`insert into orders (account_id, ext) values (1, 'o-3')`);
  const mine = await local.query(`select id from orders where ext = 'o-3'`);
  assert.ok(!cloudIds.has(mine.rows[0].id));
  await cloud.query(`insert into orders (account_id, ext) values (2, 'f-3')`);
  await settle(pair);
  await assertConverged(pair);
  assert.deepEqual(await conflicts(pair), []);
});

test("ids: the ThinkPad jumps past the cloud's before it could reach them, and the cloud moves on", async () => {
  const { pair, local, cloud } = await fresh({ settings: { seqHeadroom: 100 } });
  await settle(pair);
  const ext = (side: string, n: number) => Array.from({ length: n }, (_, i) => `(1, '${side}-${i}')`).join(", ");
  // Both sides keep inserting; the ThinkPad uses up more than half its headroom below the cloud's rows.
  for (let round = 0; round < 6; round++) {
    await cloud.query(`insert into orders (account_id, ext) values ${ext(`c${round}`, 5)}`);
    await settle(pair);
    await local.query(`insert into orders (account_id, ext) values ${ext(`l${round}`, 20)}`);
    await settle(pair);
  }
  // A cloud insert racing a ThinkPad insert in the same cycle: different ids, both kept.
  await cloud.query(`insert into orders (account_id, ext) values (2, 'race-c')`);
  await local.query(`insert into orders (account_id, ext) values (2, 'race-l')`);
  await settle(pair);
  await assertConverged(pair);
  const n = await local.query(`select count(*)::int as n from orders`);
  assert.equal(n.rows[0].n, 3 + 6 * 25 + 2, "every insert from both sides is there");
  assert.deepEqual(await conflicts(pair), []);
  const seqs = await Promise.all(
    [local, cloud].map((db) => db.query(`select last_value::int as v from pg_sequences where sequencename = 'orders_id_seq'`)),
  );
  assert.ok(seqs[1].rows[0].v >= seqs[0].rows[0].v + 100, "the cloud is still counting above the ThinkPad");
});

test("ids: the ThinkPad jumps ahead alone when the cloud is out of reach", async () => {
  const { pair, local, cloud, cfg, settings } = await fresh({ settings: { seqHeadroom: 100 } });
  await settle(pair);
  await cloud.query(`insert into orders (account_id, ext) values (1, 'c-before')`);
  await settle(pair);
  await pair.close();
  const offline = new Pair({ ...cfg, cloudUrl: "postgres://postgres:cloud@127.0.0.1:1/cloud" }, settings);
  current!.pair = offline;
  // 60 ThinkPad inserts with the cloud unreachable: past half the headroom below the cloud's rows.
  for (let i = 0; i < 60; i++) {
    await local.query(`insert into orders (account_id, ext) values (1, $1)`, [`off-${i}`]);
    (offline as unknown as { lastSeqCheck: number }).lastSeqCheck = 0;
    await offline.exclusive(() => offline.cycle());
  }
  // Meanwhile the fallback kept writing to the cloud.
  for (let i = 0; i < 30; i++) await cloud.query(`insert into orders (account_id, ext) values (2, $1)`, [`fb-${i}`]);
  await offline.close();
  const back = new Pair(cfg, settings);
  current!.pair = back;
  await settle(back);
  await assertConverged(back);
  const n = await local.query(`select count(*)::int as n from orders`);
  assert.equal(n.rows[0].n, 3 + 1 + 60 + 30);
  assert.deepEqual(await conflicts(back), []);
});

test("a key written on both sides in one cycle: the losing version is kept in the conflict", async () => {
  const { pair, local, cloud } = await fresh();
  await settle(pair);
  await local.query(`update products set name = 'ThinkPad' where sku = 'A'`);
  await cloud.query(`update products set name = 'Cloud (later)' where sku = 'A'`);
  await cloud.query(`update products set name = 'Cloud' where sku = 'B'`);
  await local.query(`update products set name = 'ThinkPad (later)' where sku = 'B'`);
  await settle(pair);
  await assertConverged(pair);
  const lost = await local.query<{ pk: { id: number }; kept: string; name: string }>(
    `select pk, kept, lost_row->>'name' as name from paribelle_sync.conflicts order by pk->>'id'`,
  );
  assert.deepEqual(
    lost.rows.map((r) => [r.pk.id, r.kept, r.name]),
    [
      [1, "cloud", "ThinkPad"],
      [2, "local", "Cloud"],
    ],
  );
});

test("an outage: the fallback writes to the cloud, the ThinkPad catches up before serving", async () => {
  const { pair, local, cloud } = await fresh();
  await settle(pair);
  // The ThinkPad wrote something just before it went down, which never got out.
  await local.query(`insert into orders (account_id, ext) values (1, 'last-second')`);
  // Fallback traffic while it's down: new orders get ids from the cloud's (ahead) sequence.
  for (let i = 0; i < 120; i++) await cloud.query(`insert into orders (account_id, ext) values (2, 'fb-${i}')`);
  await cloud.query(`insert into order_items (order_id, product_id) select id, 2 from orders where ext like 'fb-%'`);
  await cloud.query(`update products set name = 'Dupatta (new)' where sku = 'B'`);
  await cloud.query(`delete from orders where ext = 'o-2'`);

  // The ThinkPad comes back: a fresh process, not ready until the backlog (bigger than a page) is in.
  await pair.close();
  const back = new Pair(pair.cfg, pair.settings);
  current!.pair = back;
  assert.equal(back.isReady(), false);
  await back.exclusive(() => back.cycle());
  assert.equal(back.isReady(), false, "one page in, more waiting: still catching up");
  await settle(back);
  assert.equal(back.isReady(), true);
  await assertConverged(back);
  const ids = await local.query(`select count(distinct id)::int as n, count(*)::int as c from orders`);
  assert.equal(ids.rows[0].n, ids.rows[0].c);
  assert.equal((await local.query(`select 1 from orders where ext = 'last-second'`)).rowCount, 1);
  assert.equal((await local.query(`select 1 from orders where ext = 'o-2'`)).rowCount, 0);
  assert.deepEqual(await conflicts(back), []);
});

test("the same row changed on both sides: the later change wins everywhere", async () => {
  const { pair, local, cloud } = await fresh();
  await settle(pair);
  await local.query(`update products set name = 'ThinkPad name' where sku = 'A'`);
  await cloud.query(`update products set name = 'Cloud name (later)' where sku = 'A'`);
  await local.query(`update products set name = 'ThinkPad name (later)' where sku = 'B'`);
  await cloud.query(`update products set name = 'Cloud name' where sku = 'B'`);
  // B's ThinkPad change must be the later one.
  await local.query(`update products set cost = cost where sku = 'B'`);
  await settle(pair);
  await assertConverged(pair);
  const names = await local.query(`select sku, name from products order by sku`);
  assert.deepEqual(names.rows, [
    { sku: "A", name: "Cloud name (later)" },
    { sku: "B", name: "ThinkPad name (later)" },
  ]);
  const cs = await conflicts(pair);
  assert.equal(cs.length, 2);
  assert.deepEqual(cs.map((c) => c.kept).sort(), ["cloud", "local"]);
});

test("a write racing the apply is not lost: the newer pending change wins", async () => {
  const { pair, local } = await fresh();
  await settle(pair);
  const shape = await pair.refreshShape(true);
  const { push } = await pair.positions();
  // The ThinkPad changed product A after the cloud's (older) change was read.
  await local.query(`update products set name = 'fresh on ThinkPad' where sku = 'A'`);
  const key = (await local.query<{ k: string }>(`select jsonb_build_object('id', id)::text as k from products where sku = 'A'`)).rows[0].k;
  const cloudRow = (await pair.cloud.query<{ r: string }>(`select to_jsonb(p)::text as r from products p where sku = 'A'`)).rows[0].r;
  const res = await tx(pair.local, { applying: true }, (c) =>
    applyChanges({
      side: "local",
      target: c,
      pendingFrom: push,
      order: shape.order,
      tables: shape.intoLocal,
      fks: shape.local.fks,
      changedAt: new Map([["products", new Map([[key, BigInt(Date.now() - 60_000) * 1000n]])]]),
      rows: new Map([["products", new Map([[key, cloudRow]])]]),
    }),
  );
  assert.equal(res.conflicts.length, 1);
  assert.equal(res.conflicts[0].kept, "local");
  const name = await local.query(`select name from products where sku = 'A'`);
  assert.equal(name.rows[0].name, "fresh on ThinkPad");
  await settle(pair);
  await assertConverged(pair);
});

test("pruning frees the cloud; the ThinkPad keeps everything; pruned rows stay pruned", async () => {
  const { pair, local, cloud } = await fresh();
  await settle(pair);
  await local.query(`update orders set ordered_at = now() - interval '2 years' where ext in ('o-1', 'o-2')`);
  await local.query(`insert into returns (order_id, reason) values (2, 'size')`); // o-2 is kept: SET NULL would change this return
  await local.query(`insert into labels (created_at, pdf) values (now() - interval '90 days', '\\xdeadbeef'), (now(), '\\xbeef')`);
  await settle(pair);

  const res = await pair.exclusive(() => prune(pair, { force: true }));
  assert.deepEqual(res.pruned, { labels: 1, orders: 1 });
  assert.equal((await cloud.query(`select 1 from orders where ext = 'o-1'`)).rowCount, 0);
  assert.equal((await cloud.query(`select 1 from order_items where order_id = 1`)).rowCount, 0, "cascade in the cloud");
  assert.equal((await cloud.query(`select 1 from orders where ext = 'o-2'`)).rowCount, 1, "kept: a return points at it");
  assert.equal((await local.query(`select 1 from orders where ext = 'o-1'`)).rowCount, 1, "the ThinkPad keeps it");
  assert.equal((await local.query(`select 1 from order_items where order_id = 1`)).rowCount, 1);
  await settle(pair);
  await assertConverged(pair);

  // Editing a pruned row on the ThinkPad doesn't bring it back...
  await local.query(`update order_items set qty = 5 where order_id = 1`);
  await settle(pair);
  assert.equal((await cloud.query(`select 1 from order_items where order_id = 1`)).rowCount, 0);
  // ...and reconcile doesn't either.
  await pair.exclusive(() => reconcileAll(pair));
  assert.equal((await cloud.query(`select 1 from orders where ext = 'o-1'`)).rowCount, 0);
  await assertConverged(pair);

  // A new row that points at a pruned one puts the parent back.
  await local.query(`insert into batch_orders values (9, 1)`);
  await settle(pair);
  assert.equal((await cloud.query(`select 1 from orders where ext = 'o-1'`)).rowCount, 1, "parent put back");
  assert.equal((await cloud.query(`select 1 from batch_orders where batch = 9`)).rowCount, 1);
  await assertConverged(pair);
  assert.deepEqual((await conflicts(pair)).filter((c) => c.kept === "none"), []);
});

test("one transaction bigger than a page, and many small ones", async () => {
  const { pair, local, cloud } = await fresh();
  await settle(pair);
  await local.query(`insert into products (sku, name) select 'bulk-' || g, 'bulk' from generate_series(1, 400) g`);
  for (let i = 0; i < 130; i++) await cloud.query(`insert into categories (name) values ('c${i}')`);
  await settle(pair);
  await assertConverged(pair);
  assert.equal((await cloud.query(`select count(*)::int as n from products`)).rows[0].n, 402);
  assert.equal((await local.query(`select count(*)::int as n from categories`)).rows[0].n, 130);
});

test("a migration on one side first: common columns sync, the rest follows once both have it", async () => {
  const { pair, local, cloud } = await fresh();
  await settle(pair);
  await local.query(`alter table products add column colour text`);
  await local.query(`update products set colour = 'red', name = 'Kurta v2' where sku = 'A'`);
  await settle(pair);
  assert.equal((await cloud.query(`select name from products where sku = 'A'`)).rows[0].name, "Kurta v2");
  await cloud.query(`alter table products add column colour text`);
  await settle(pair); // notices the column set changed and reconciles the table
  await settle(pair);
  assert.equal((await cloud.query(`select colour from products where sku = 'A'`)).rows[0].colour, "red");
  await assertConverged(pair);
});

test("a table added by a migration on both sides is picked up", async () => {
  const { pair, local, cloud } = await fresh();
  await settle(pair);
  await local.query(`create table wishlists (id serial primary key, name text)`);
  await cloud.query(`create table wishlists (id serial primary key, name text)`);
  await local.query(`insert into wishlists (name) values ('before triggers')`);
  await settle(pair);
  await settle(pair);
  await local.query(`insert into wishlists (name) values ('after triggers')`);
  await settle(pair);
  await assertConverged(pair, { tables: ["wishlists"] });
});

test("TRUNCATE on one side makes that side win for the table", async () => {
  const { pair, local, cloud } = await fresh();
  await settle(pair);
  await local.query(`truncate labels`);
  await cloud.query(`insert into labels (pdf) values ('\\x01')`);
  await settle(pair);
  await local.query(`insert into labels (pdf) values ('\\x02')`);
  await local.query(`truncate labels`);
  await settle(pair);
  await settle(pair);
  await assertConverged(pair, { tables: ["labels"] });
});

test("readiness: a sleep or an internet outage means catching up again", async () => {
  const { pair } = await fresh();
  await settle(pair);
  assert.equal(pair.isReady(), true);
  pair.tick(60_000);
  assert.equal(pair.isReady(), false, "after a long pause, not ready until the next pull");
  await pair.exclusive(() => pair.cycle());
  assert.equal(pair.isReady(), true);
});

test("readiness: an app down keeps the pair out; back up, it catches up before serving", async () => {
  const { pair, cloud } = await fresh({ cfg: { appHealth: ["http://api:3001/api/v1/health"] } });
  await settle(pair);
  assert.equal(pair.isReady(), false, "not until the apps have answered");
  pair.setAppsUp(true);
  assert.equal(pair.isReady(), false, "answering, but a pull must start after that");
  await pair.exclusive(() => pair.cycle());
  assert.equal(pair.isReady(), true);

  pair.setAppsUp(false, "restarting");
  assert.equal(pair.isReady(), false);
  await pair.exclusive(() => pair.cycle());
  assert.equal(pair.isReady(), false, "caught up, but an app is still down");
  await cloud.query(`insert into orders (account_id, ext) values (2, 'f-9')`); // the fallback took an order
  pair.setAppsUp(true);
  assert.equal(pair.isReady(), false);
  await pair.exclusive(() => pair.cycle());
  assert.equal(pair.isReady(), true);
  const got = await pair.local.query(`select count(*)::int as n from orders where ext = 'f-9'`);
  assert.equal(got.rows[0].n, 1, "what the fallback wrote meanwhile is home before serving");
});

test("the cloud unreachable at boot: degraded serving after the grace period, if the internet works", async () => {
  const { pair, cfg, settings } = await fresh();
  await settle(pair);
  await pair.close(); // one sync per database
  const broken = new Pair({ ...cfg, cloudUrl: cfg.cloudUrl.replace(/@[^/]+\//, "@127.0.0.1:1/") }, { ...settings, bootGraceMs: 50 });
  try {
    await broken.exclusive(() => broken.cycle());
    await new Promise((r) => setTimeout(r, 80));
    broken.internetOk = false;
    assert.equal(broken.isReady(), false, "offline: the fallback has the traffic, stay out");
    broken.internetOk = true;
    assert.equal(broken.isReady(), true);
    assert.equal(broken.status.degraded, true);
  } finally {
    await broken.close();
  }
});

test("a replaced cloud database halts the sync instead of guessing", async () => {
  const { pair, cloud } = await fresh();
  await settle(pair);
  await cloud.query(`update paribelle_sync.meta set value = gen_random_uuid()::text where key = 'instance'`);
  await pair.close();
  const again = new Pair(pair.cfg, pair.settings);
  current!.pair = again;
  await again.exclusive(() => again.cycle());
  assert.match(again.status.halted ?? "", /not the one/);
  assert.equal(again.isReady(), false);
});

test("reseed: a new, empty cloud database filled from the ThinkPad", async () => {
  const { pair, local, cloud } = await fresh();
  await settle(pair);
  await local.query(`insert into reel_jobs (output) values ('\\x0102')`);
  await pair.close();
  await cloud.query(`drop schema public cascade; create schema public; drop schema paribelle_sync cascade`);
  await reseedCloud(pair.cfg, pair.settings);
  const again = new Pair(pair.cfg, pair.settings);
  current!.pair = again;
  await settle(again);
  await assertConverged(again);
  assert.equal((await cloud.query(`select count(*)::int as n from reel_jobs`)).rows[0].n, 0, "ThinkPad-only data stays home");
  await local.query(`update orders set status = 'shipped' where id = 1`);
  await cloud.query(`insert into accounts (name) values ('after reseed')`);
  await settle(again);
  await assertConverged(again);
});

test("pgvector (the OMS's reel_songs): copied at bootstrap, synced both ways, reseeded", async () => {
  const { pair, local, cloud } = await fresh({
    extensions: ["vector"],
    schema: `create table reel_songs (id serial primary key, title text not null, embedding vector(3));`,
    seed: `insert into reel_songs (title, embedding) values ('Lehenga', '[0.1,0.25,-3]'), ('Suit', null);`,
  });
  const copied = await local.query(`select embedding::text as e from reel_songs where title = 'Lehenga'`);
  assert.equal(copied.rows[0].e, "[0.1,0.25,-3]");
  await settle(pair);
  await local.query(`insert into reel_songs (title, embedding) values ('Kurti', '[1,2,3]')`);
  await cloud.query(`update reel_songs set embedding = '[0.5,0.5,0.5]' where title = 'Suit'`);
  await settle(pair);
  await assertConverged(pair, { tables: ["reel_songs"] });
  const near = await local.query(`select title from reel_songs order by embedding <-> '[0.5,0.5,0.4]' limit 1`);
  assert.equal(near.rows[0].title, "Suit", "the ThinkPad searches by embedding");

  await pair.close();
  await cloud.query(`drop schema public cascade; create schema public; drop schema paribelle_sync cascade`);
  await cloudExtension("vector"); // a new Supabase project: its postgres role may create it
  await reseedCloud(pair.cfg, pair.settings);
  const again = new Pair(pair.cfg, pair.settings);
  current!.pair = again;
  await settle(again);
  await assertConverged(again, { tables: ["reel_songs"] });
});

test("two syncs can't work the same databases", async () => {
  const { pair, cfg, settings } = await fresh();
  await settle(pair);
  const second = new Pair(cfg, settings);
  try {
    await second.exclusive(() => second.cycle());
    assert.match(second.status.halted ?? "", /another sync/);
  } finally {
    await second.close();
  }
});

test("randomised: interleaved writes, cycles and outages always converge", async () => {
  const { pair, local, cloud } = await fresh({ settings: { pageSize: 20 } });
  await settle(pair);
  let seed = 42;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % n;
  };
  const ops = [
    (db: typeof local, side: string, i: number) => db.query(`insert into products (sku, name) values ($1, 'p')`, [`${side}-${i}`]),
    (db: typeof local) => db.query(`update products set name = md5(random()::text) where id = (select id from products order by random() limit 1)`),
    (db: typeof local, side: string, i: number) =>
      db.query(`insert into orders (account_id, ext) select id, $1 from accounts order by random() limit 1`, [`${side}-o${i}`]),
    (db: typeof local) =>
      db.query(`insert into order_items (order_id, product_id, qty) select o.id, p.id, 1 + floor(random() * 3) from orders o, products p order by random() limit 1`),
    (db: typeof local) => db.query(`update orders set status = 'packed' where id = (select id from orders order by random() limit 1)`),
    (db: typeof local) => db.query(`delete from order_items where id = (select id from order_items order by random() limit 1)`),
    (db: typeof local) => db.query(`delete from orders where id = (select id from orders order by random() limit 1)`),
    (db: typeof local) => db.query(`insert into categories (name, parent_id) select 'c', (select id from categories order by random() limit 1)`),
  ];
  for (let round = 0; round < 30; round++) {
    const outage = rnd(4) === 0;
    for (let i = 0; i < 15; i++) {
      // During an outage only the cloud takes writes, as with the fallback serving.
      const side = outage || rnd(2) === 0 ? "cloud" : "local";
      const db = side === "cloud" ? cloud : local;
      await ops[rnd(ops.length)](db, side, round * 100 + i).catch(() => {}); // FK races between sides are fine to skip
      if (!outage && rnd(5) === 0) await pair.exclusive(() => pair.cycle());
    }
  }
  await settle(pair);
  await assertConverged(pair);
  const failed = (await conflicts(pair)).filter((c) => c.kept === "none");
  // A child written on one side for a parent deleted on the other can't be applied: recorded, not lost silently.
  for (const f of failed) assert.match(f.reason, /foreign key|23503/);
});

test("concurrent: the daemon loop runs while both sides are written at once", async () => {
  const { pair, local, cloud } = await fresh({ settings: { pageSize: 25, intervalMs: 5 } });
  await settle(pair);
  const stop = new AbortController();
  const loop = pair.run(stop.signal);
  const made = { skus: [] as string[], exts: [] as string[] };
  const writer = async (db: typeof local, side: string) => {
    for (let i = 0; i < 300; i++) {
      const r = i % 6;
      const tag = `${side}-${i}`;
      await (r === 0
        ? db.query(`insert into products (sku, name) values ($1, 'p')`, [tag]).then(() => made.skus.push(tag))
        : r === 1
          ? db.query(`update products set name = $1 where sku in ('A', 'B')`, [tag])
          : r === 2
            ? db.query(`insert into orders (account_id, ext) values (1, $1)`, [tag]).then(() => made.exts.push(tag))
            : r === 3
              ? db.query(`update orders set status = 'packed', raw = jsonb_build_object('by', $1::text) where id in (1, 2, 3)`, [side])
              : r === 4
                ? db.query(`insert into order_items (order_id, product_id) select max(id), 1 from orders`)
                : db.query(`delete from order_items where id = (select min(id) from order_items)`)
      ).catch(() => {});
    }
  };
  await Promise.all([writer(local, "local"), writer(cloud, "cloud")]);
  stop.abort();
  await loop;
  await settle(pair);
  await assertConverged(pair);
  // Every insert that succeeded on either side is still there: none merged into another by a shared id.
  const skus = new Set((await local.query(`select sku from products`)).rows.map((r) => r.sku));
  const exts = new Set((await local.query(`select ext from orders`)).rows.map((r) => r.ext));
  assert.deepEqual(made.skus.filter((s) => !skus.has(s)), []);
  assert.deepEqual(made.exts.filter((e) => !exts.has(e)), []);
  assert.equal(made.skus.length + made.exts.length, 200, "no insert failed");
});
