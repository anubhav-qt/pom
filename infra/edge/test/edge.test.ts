import assert from "node:assert/strict";
import { test } from "node:test";

import { handle, type Env } from "../edge.ts";

const env: Env = {
  THINKPAD_ORIGIN: "https://laptop.paribelle.in",
  RENDER_ORIGIN: "https://render.example",
  API_HOST: "api.paribelle.in",
  EDGE_KEY: "k".repeat(64),
};

/** Every request the Worker makes, answered by `answer` (by host). */
function net(answer: (r: Request) => Response) {
  const sent: Request[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = new Request(input as Request, init);
    sent.push(r);
    return answer(r);
  }) as typeof fetch;
  return { sent, fetcher, down: { shop: { until: 0 }, oms: { until: 0 } } };
}

const thinkpadDown = (r: Request) =>
  new URL(r.url).host === "laptop.paribelle.in" ? new Response("", { status: 530 }) : new Response(`origin ${new URL(r.url).host}`);

test("www: the ThinkPad answers, told which site and page it's for", async () => {
  const n = net(() => new Response("thinkpad"));
  const res = await handle(new Request("https://www.paribelle.in/products/x?y=1"), env, n.fetcher, n.down);
  assert.equal(await res.text(), "thinkpad");
  assert.equal(n.sent[0].url, "https://laptop.paribelle.in/products/x?y=1");
  assert.equal(n.sent[0].headers.get("x-paribelle-host"), "www.paribelle.in");
  assert.equal(n.sent[0].headers.get("x-paribelle-edge-key"), env.EDGE_KEY);
});

test("www: with the ThinkPad away, the request itself goes on to Vercel, same address and body", async () => {
  const n = net(thinkpadDown);
  const res = await handle(
    new Request("https://www.paribelle.in/pom/login", { method: "POST", body: "email=a", headers: { "content-length": "7" } }),
    env,
    n.fetcher,
    n.down,
  );
  assert.equal(await res.text(), "origin www.paribelle.in");
  assert.equal(res.headers.get("x-paribelle-served-by"), "fallback");
  const toVercel = n.sent[1];
  assert.equal(toVercel.url, "https://www.paribelle.in/pom/login");
  assert.equal(toVercel.method, "POST");
  assert.equal(await toVercel.text(), "email=a");
  assert.equal(toVercel.redirect, "manual", "Vercel's redirects reach the browser");
  assert.ok(n.down.oms.until > 0);
  assert.equal(n.down.shop.until, 0, "the storefront still tries the ThinkPad");
});

test("api: with the ThinkPad away, Render, with the key and the visitor's address", async () => {
  const n = net(thinkpadDown);
  const res = await handle(new Request("https://api.paribelle.in/api/v1/cart", { headers: { "cf-connecting-ip": "203.0.113.9" } }), env, n.fetcher, n.down);
  assert.equal(await res.text(), "origin render.example");
  const toRender = n.sent[1];
  assert.equal(toRender.url, "https://render.example/api/v1/cart");
  assert.equal(toRender.headers.get("x-paribelle-edge-key"), env.EDGE_KEY);
  assert.equal(toRender.headers.get("x-paribelle-client-ip"), "203.0.113.9");
});

test("no EDGE_KEY: everything goes where it went before the ThinkPad", async () => {
  const n = net(thinkpadDown);
  const noKey = { ...env, EDGE_KEY: undefined };
  assert.equal(await (await handle(new Request("https://www.paribelle.in/"), noKey, n.fetcher, n.down)).text(), "origin www.paribelle.in");
  assert.equal(await (await handle(new Request("https://api.paribelle.in/api/v1/x"), noKey, n.fetcher, n.down)).text(), "origin render.example");
  assert.ok(n.sent.every((r) => new URL(r.url).host !== "laptop.paribelle.in"));
});

test("certificate renewals go straight to Vercel", async () => {
  const n = net(() => new Response("token"));
  await handle(new Request("https://www.paribelle.in/.well-known/acme-challenge/abc"), env, n.fetcher, n.down);
  assert.deepEqual(n.sent.map((r) => r.url), ["https://www.paribelle.in/.well-known/acme-challenge/abc"]);
});

test("trying it locally: WWW_FALLBACK_ORIGIN stands in for the DNS record", async () => {
  const n = net(thinkpadDown);
  const res = await handle(new Request("http://localhost:8787/cart?x=1"), { ...env, WWW_FALLBACK_ORIGIN: "http://vercel.test:3000" }, n.fetcher, n.down);
  assert.equal(await res.text(), "origin vercel.test:3000");
  assert.equal(n.sent[1].url, "http://vercel.test:3000/cart?x=1");
});

test("a failed OMS page checks the OMS's health before sending everyone to Vercel", async () => {
  const n = net((r) => {
    const { host, pathname } = new URL(r.url);
    if (host !== "laptop.paribelle.in") return new Response(`origin ${host}`);
    return pathname === "/pom/api/health" ? new Response("ok") : new Response("oops", { status: 504 });
  });
  const res = await handle(new Request("https://www.paribelle.in/pom/finance"), env, n.fetcher, n.down);
  assert.equal(await res.text(), "origin www.paribelle.in");
  const check = n.sent.find((r) => new URL(r.url).pathname === "/pom/api/health");
  assert.ok(check, "the health check was made");
  assert.equal(check.headers.get("x-paribelle-edge-key"), env.EDGE_KEY);
  assert.equal(check.headers.get("x-paribelle-host"), "www.paribelle.in");
  assert.equal(n.down.oms.until, 0, "the OMS stays on the ThinkPad");
});

test("Seelie's API stays on the ThinkPad: its own errors are passed on", async () => {
  const n = net((r) => (new URL(r.url).host === "laptop.paribelle.in" ? new Response("busy", { status: 503 }) : new Response("vercel")));
  const res = await handle(new Request("https://www.paribelle.in/pom/api/seelie/runs/abc/stream"), env, n.fetcher, n.down);
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("x-paribelle-served-by"), "thinkpad");
  assert.ok(n.sent.every((r) => new URL(r.url).host === "laptop.paribelle.in"));
});
