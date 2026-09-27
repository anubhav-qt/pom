import assert from "node:assert/strict";
import { test } from "node:test";

import { failover, type DownState, type FailoverOptions } from "../failover.ts";

const PRIMARY = "https://laptop.paribelle.in";
const KEY = "k".repeat(64);

/** A ThinkPad that answers with `answer`, and a fallback that echoes what it was given. */
function harness(answer: (r: Request) => Response | Promise<Response>, over: Partial<FailoverOptions> = {}) {
  const seen = { primary: [] as Request[], fallback: [] as { method: string; body: string }[] };
  let clock = 1_000_000;
  const down: DownState = { until: 0 };
  const opts: FailoverOptions = {
    primary: PRIMARY,
    edgeKey: KEY,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const r = new Request(input as Request, init);
      seen.primary.push(r);
      return answer(r);
    }) as typeof fetch,
    fallback: async (r) => {
      const body = r.body ? await r.text() : "";
      seen.fallback.push({ method: r.method, body });
      return new Response(`fallback ${r.method} ${body}`, { status: 200 });
    },
    now: () => clock,
    ...over,
  };
  return {
    seen,
    down,
    tick: (ms: number) => (clock += ms),
    run: (r: Request) => failover(r, opts, down),
  };
}

const get = (path = "/", headers: Record<string, string> = {}) =>
  new Request(`https://paribelle.in${path}`, { headers: { "cf-connecting-ip": "203.0.113.7", ...headers } });
const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("https://paribelle.in/checkout", {
    method: "POST",
    body,
    headers: { "content-type": "text/plain", "content-length": String(Buffer.byteLength(body)), "cf-connecting-ip": "203.0.113.7", ...headers },
  });
const standby = () => new Response("catching up", { status: 503, headers: { "x-paribelle-standby": "1", "retry-after": "5" } });

test("the ThinkPad's answer is used, and it gets the key, the site's host and the visitor", async () => {
  const h = harness(() => new Response("hi from the ThinkPad", { status: 200, headers: { "set-cookie": "a=1" } }));
  const res = await h.run(get("/products/x?y=1", { "x-paribelle-client-ip": "6.6.6.6", "x-paribelle-edge-key": "guess" }));
  assert.equal(await res.text(), "hi from the ThinkPad");
  assert.equal(res.headers.get("x-paribelle-served-by"), "thinkpad");
  assert.equal(res.headers.get("set-cookie"), "a=1");
  const sent = h.seen.primary[0];
  assert.equal(sent.url, `${PRIMARY}/products/x?y=1`);
  assert.equal(sent.headers.get("x-paribelle-edge-key"), KEY);
  assert.equal(sent.headers.get("x-paribelle-host"), "paribelle.in");
  assert.equal(sent.headers.get("x-paribelle-client-ip"), "203.0.113.7", "the visitor can't pick their own address");
  assert.equal(sent.headers.get("host"), null, "Host comes from the tunnel's URL");
  assert.equal(sent.redirect, "manual");
  assert.equal(h.seen.fallback.length, 0);
});

test("redirects and errors from the app itself are passed on, not retried", async () => {
  const h = harness((r) =>
    r.url.endsWith("/old") ? new Response(null, { status: 302, headers: { location: "/new" } }) : new Response("boom", { status: 500 }),
  );
  const moved = await h.run(get("/old"));
  assert.equal(moved.status, 302);
  assert.equal(moved.headers.get("location"), "/new");
  assert.equal((await h.run(get("/broken"))).status, 500);
  assert.equal(h.seen.fallback.length, 0);
  assert.equal(h.down.until, 0);
});

test("standby: any request goes to the fallback, body and all, and the ThinkPad is left alone for Retry-After", async () => {
  const h = harness(standby);
  const res = await h.run(post("order #1"));
  assert.equal(await res.text(), "fallback POST order #1");
  assert.equal(res.headers.get("x-paribelle-served-by"), "fallback");
  h.tick(4000);
  await h.run(get());
  assert.equal(h.seen.primary.length, 1, "within Retry-After: straight to the fallback");
  h.tick(1500);
  await h.run(get());
  assert.equal(h.seen.primary.length, 2, "after it: the ThinkPad is asked again");
});

test("tunnel down (530) or the gate's own errors: POSTs go to the fallback too", async () => {
  for (const answer of [
    () => new Response("", { status: 530 }),
    () => new Response("502 Bad Gateway", { status: 502, headers: { "x-paribelle-gate": "unreachable" } }),
    () => new Response("forbidden", { status: 403, headers: { "x-paribelle-gate": "forbidden" } }),
  ]) {
    const h = harness(answer);
    const res = await h.run(post("pay"));
    assert.equal(await res.text(), "fallback POST pay");
    assert.ok(h.down.until > 0);
  }
});

test("a 502/503/504 without the gate's word: GET goes to the fallback, POST gets the error", async () => {
  for (const status of [502, 503, 504]) {
    const h = harness(() => new Response("oops", { status }));
    assert.equal(await (await h.run(get())).text(), "fallback GET ");
    const h2 = harness(() => new Response("oops", { status }));
    const res = await h2.run(post("pay"));
    assert.equal(res.status, status, "it may have reached the app: never sent twice");
    assert.equal(h2.seen.fallback.length, 0);
  }
});

test("a network error: GET goes to the fallback, POST gets a 502 and is not repeated", async () => {
  const h = harness(() => {
    throw new TypeError("network connection lost");
  });
  assert.equal(await (await h.run(get())).text(), "fallback GET ");
  const h2 = harness(() => {
    throw new TypeError("network connection lost");
  });
  const res = await h2.run(post("pay"));
  assert.equal(res.status, 502);
  assert.equal(h2.seen.fallback.length, 0);
  assert.ok(h2.down.until > 0, "and the next request skips the ThinkPad");
  await h2.run(post("pay again"));
  assert.deepEqual(h2.seen.fallback, [{ method: "POST", body: "pay again" }]);
});

test("a hung ThinkPad: GET gives up after the timeout; POST waits", async () => {
  const hang = (r: Request) =>
    new Promise<Response>((resolve, reject) => {
      const t = setTimeout(() => resolve(new Response("late but fine")), 300);
      r.signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(r.signal.reason);
      });
    });
  const h = harness(hang, { timeoutMs: 50 });
  const t0 = Date.now();
  assert.equal(await (await h.run(get())).text(), "fallback GET ");
  assert.ok(Date.now() - t0 < 250);
  const h2 = harness(hang, { timeoutMs: 50 });
  assert.equal(await (await h2.run(post("slow label"))).text(), "late but fine");
});

test("the timeout stops at the response headers: a long download isn't cut off", async () => {
  const h = harness(
    () =>
      new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(new TextEncoder().encode("part one, "));
            await new Promise((r) => setTimeout(r, 150));
            c.enqueue(new TextEncoder().encode("part two"));
            c.close();
          },
        }),
      ),
    { timeoutMs: 50 },
  );
  assert.equal(await (await h.run(get("/big.pdf"))).text(), "part one, part two");
});

test("a body too big to keep: streamed to the ThinkPad; if it never got there, the client retries on the fallback", async () => {
  const big = "x".repeat(2000);
  const h = harness(standby, { maxBufferBytes: 1000 });
  const res = await h.run(post(big));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "1");
  assert.equal(h.seen.fallback.length, 0);
  await h.run(post(big));
  assert.equal(h.seen.fallback[0].body.length, 2000, "the retry goes straight to the fallback");

  const ok = harness(async (r) => new Response(`got ${(await r.text()).length}`), { maxBufferBytes: 1000 });
  assert.equal(await (await ok.run(post(big))).text(), "got 2000");
});

test("without a key or a ThinkPad configured, everything goes to the fallback", async () => {
  const h = harness(() => new Response("never"), { edgeKey: "" });
  assert.equal(await (await h.run(get())).text(), "fallback GET ");
  assert.equal(h.seen.primary.length, 0);
});

test("relaying: the visitor's address is always the connection's, never one the request brings", async () => {
  const { relay } = await import("../failover.ts");
  const from = (headers: Record<string, string>) => relay(new Request("https://api.paribelle.in/api/v1/x", { headers }), "https://render.example", KEY);
  const sent = from({ "cf-connecting-ip": "2a06:98c0::1", "x-paribelle-client-ip": "198.51.100.4", "x-paribelle-edge-key": KEY });
  assert.equal(sent.headers.get("x-paribelle-client-ip"), "2a06:98c0::1");
  assert.equal(sent.url, "https://render.example/api/v1/x");
  assert.equal(from({}).headers.get("x-paribelle-client-ip"), null);
});
