import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { duration, loadJobs } from "../src/config.ts";
import { Jobs } from "../src/jobs.ts";

test("jobs: read from JOB_<NAME>_* settings", () => {
  const jobs = loadJobs({
    JOB_OMS_ORDERS_URL: "http://oms:3000/pom/api/cron/sync",
    JOB_OMS_ORDERS_EVERY: "10m",
    JOB_OMS_ORDERS_TOKEN: "s3cret",
    JOB_OMS_ORDERS_WHEN: "oms",
    JOB_RENDER_WARM_URL: "https://render.example/api/v1/health",
    JOB_RENDER_WARM_EVERY: "10m",
    JOB_RENDER_WARM_TIMEOUT: "90s",
    JOB_EMPTY_URL: "",
  });
  assert.deepEqual(jobs, [
    { name: "oms-orders", url: "http://oms:3000/pom/api/cron/sync", everyMs: 600_000, timeoutMs: 600_000, token: "s3cret", when: "oms" },
    { name: "render-warm", url: "https://render.example/api/v1/health", everyMs: 600_000, timeoutMs: 90_000, token: null, when: null },
  ]);
  assert.equal(duration("1h"), 3_600_000);
  assert.equal(duration("250"), 250);
  assert.throws(() => loadJobs({ JOB_X_URL: "http://x" }), /JOB_X_EVERY/);
});

test("jobs: on time, only while their pair serves, never overlapping, with the token", async () => {
  const seen: { auth: string | undefined }[] = [];
  let release: () => void = () => {};
  const server = createServer((req, res) => {
    seen.push({ auth: req.headers.authorization });
    if (req.url === "/slow") new Promise<void>((r) => (release = r)).then(() => res.end("done"));
    else res.writeHead(req.url === "/broken" ? 500 : 200).end(req.url === "/broken" ? "no" : "ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    let clock = 0;
    let serving = false;
    const jobs = new Jobs(
      [
        { name: "orders", url: `${base}/ok`, everyMs: 600_000, timeoutMs: 5000, token: "t0ken", when: "oms" },
        { name: "slow", url: `${base}/slow`, everyMs: 1000, timeoutMs: 5000, token: null, when: null },
        { name: "broken", url: `${base}/broken`, everyMs: 600_000, timeoutMs: 5000, token: null, when: null },
      ],
      () => serving,
      () => clock,
      0,
    );

    const first = jobs.tick();
    await new Promise((r) => setTimeout(r, 100));
    const status = () => Object.fromEntries(jobs.status().map((s) => [s.name, s]));
    assert.equal(status().orders.lastRunAt, null, "not while the OMS isn't served");
    assert.match(status().orders.waiting ?? "", /isn't serving oms/);
    assert.equal(status().slow.running, true);

    clock += 5000; // the slow one is due again but still going: not started twice
    await jobs.tick();
    assert.equal(seen.filter((s) => s.auth === undefined).length, 2, "slow once, broken once");

    serving = true;
    await jobs.tick();
    assert.equal(status().orders.lastStatus, 200);
    assert.equal(status().orders.waiting, null);
    assert.equal(seen.find((s) => s.auth)?.auth, "Bearer t0ken");
    assert.equal(status().broken.lastStatus, 500);
    assert.equal(status().broken.lastError, "no");

    clock += 60_000; // orders isn't due for another 9 minutes
    await jobs.tick();
    assert.equal(seen.filter((s) => s.auth).length, 1);

    release();
    await first;
    assert.equal(status().slow.running, false);
    assert.equal(status().slow.lastStatus, 200);
  } finally {
    server.close();
  }
});
