/**
 * Serves a request from the ThinkPad when it can, and from the fallback when it can't
 * (Vercel for the storefront and the OMS, Render for the API; see edge.ts).
 *
 * The ThinkPad is reached through its Cloudflare Tunnel with the shared EDGE_KEY, which is
 * what gets a request past its gate. Its answer is used unless it says it didn't handle
 * the request:
 *   x-paribelle-standby   the sync says it's catching up, or an app is restarting
 *   x-paribelle-gate      the gate turned it away (wrong key) or the app didn't answer
 *   530                   the tunnel is down: laptop asleep or offline, cloudflared stopped
 * None of those reached the app, so any request can go to the fallback instead. GET and
 * HEAD also go there on a 502/503/504, a timeout or a network error, since running them
 * twice is harmless. A POST that may have reached the app is never sent twice.
 *
 * After a failure this isolate leaves the ThinkPad alone for a while (downMs, or a
 * standby's Retry-After) so visitors don't each wait out the same timeout. A request that
 * did reach the app and failed (one slow report, one process restarting) only does that
 * when the ThinkPad then fails a quick health check too (`probe`): otherwise everyone
 * would spend the next 20 s on the fallback, where Seelie is offline, over one page.
 */

export interface FailoverOptions {
  /** The ThinkPad's tunnel origin, e.g. https://laptop.paribelle.in. Empty: always the fallback. */
  primary: string | undefined;
  edgeKey: string | undefined;
  fallback: (req: Request) => Promise<Response>;
  /** GET/HEAD: stop waiting for the ThinkPad's response headers after this long. */
  timeoutMs?: number;
  /** After a failure, go straight to the fallback for this long. */
  downMs?: number;
  /** Request bodies up to this size are kept so they can be replayed on the fallback. */
  maxBufferBytes?: number;
  /**
   * Whether the ThinkPad is up, asked after a request that reached it failed. Without one,
   * any failure leaves the ThinkPad alone for downMs.
   */
  probe?: () => Promise<boolean>;
  /**
   * Only the ThinkPad can serve this (Seelie: its chats and media aren't in the cloud). No
   * timeout, and once the app has it, its answer stands; the fallback only gets what never
   * reached it, or a failure while the ThinkPad is down.
   */
  primaryOnly?: boolean;
  /** For tests. */
  fetch?: typeof fetch;
  now?: () => number;
}

export interface DownState {
  until: number;
}

const isolate: DownState = { until: 0 };
const REPLAYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAYBE_DOWN = new Set([502, 503, 504]);

export const SERVED_BY = "x-paribelle-served-by";

/**
 * The request as the ThinkPad's gate (or Render) expects it: the key, the site's host, and
 * the visitor's address, which the API limits requests by.
 */
export function relay(req: Request, origin: string, edgeKey: string, body?: BodyInit | null): Request {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  // The tunnel picks its route by Host, so it must be the origin's; the site's goes in X-Paribelle-Host.
  headers.delete("host");
  if (edgeKey) headers.set("x-paribelle-edge-key", edgeKey);
  else headers.delete("x-paribelle-edge-key");
  headers.set("x-paribelle-host", url.host);
  const visitor = req.headers.get("cf-connecting-ip");
  if (visitor) headers.set("x-paribelle-client-ip", visitor);
  else headers.delete("x-paribelle-client-ip");
  const init: RequestInit & { duplex?: "half" } = { method: req.method, headers, redirect: "manual" };
  if (body !== undefined) init.body = body;
  else if (req.body) {
    init.body = req.body;
    init.duplex = "half";
  }
  return new Request(new URL(url.pathname + url.search, origin), init);
}

export async function failover(req: Request, o: FailoverOptions, down: DownState = isolate): Promise<Response> {
  const now = o.now ?? Date.now;
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? 8000;
  const downMs = o.downMs ?? 20_000;
  const maxBuffer = o.maxBufferBytes ?? 25 * 1024 * 1024;

  const fallback = async (r: Request) => tag(await o.fallback(r), "fallback");
  if (!o.primary || !o.edgeKey || now() < down.until) return fallback(req);

  const websocket = req.headers.get("upgrade")?.toLowerCase() === "websocket";
  const safe = REPLAYABLE_METHODS.has(req.method) && !websocket;

  // Keep the body when it fits, so the request can still go to the fallback afterwards.
  let body: ArrayBuffer | null | undefined;
  let replayable = true;
  if (req.body && !websocket) {
    const length = Number(req.headers.get("content-length") ?? Number.NaN);
    if (Number.isFinite(length) && length <= maxBuffer) body = await req.arrayBuffer();
    else replayable = false;
  }
  const again = () => (body === undefined ? req : new Request(req, { body }));
  const markDown = (ms: number) => {
    down.until = Math.max(down.until, now() + ms);
  };
  // It reached the ThinkPad and failed: left alone only if the ThinkPad fails the check too.
  const stillUp = async () => {
    const up = o.probe ? await o.probe().catch(() => false) : false;
    if (!up) markDown(downMs);
    return up;
  };

  const ctl = new AbortController();
  const timer = safe && !o.primaryOnly ? setTimeout(() => ctl.abort(new Error("timed out")), timeoutMs) : undefined;
  let res: Response;
  try {
    res = await doFetch(relay(req, o.primary, o.edgeKey, body), { signal: ctl.signal });
  } catch (e) {
    const up = await stillUp();
    if (safe && replayable && !(o.primaryOnly && up)) return fallback(again());
    console.error("ThinkPad unreachable mid-request", req.method, new URL(req.url).pathname, String(e));
    return new Response("The ThinkPad did not answer. Please try again.", { status: 502, headers: { "retry-after": "1" } });
  } finally {
    clearTimeout(timer);
  }

  const standby = res.headers.has("x-paribelle-standby");
  const gate = res.headers.get("x-paribelle-gate");
  if (standby || gate !== null || res.status === 530) {
    if (gate === "forbidden") console.error("The ThinkPad's gate refused the edge key: is EDGE_KEY the same on both?");
    markDown(standby ? retryAfterMs(res, downMs) : downMs);
    await res.body?.cancel();
    if (replayable) return fallback(again());
    // It never reached the app, but the body is gone: the client's retry lands on the fallback.
    return new Response("Please try again.", { status: 503, headers: { "retry-after": "1" } });
  }
  if (safe && !o.primaryOnly && MAYBE_DOWN.has(res.status)) {
    await res.body?.cancel();
    await stillUp();
    return fallback(again());
  }
  return tag(res, "thinkpad");
}

function retryAfterMs(res: Response, cap: number): number {
  const s = Number(res.headers.get("retry-after"));
  return Number.isFinite(s) && s > 0 ? Math.min(s * 1000, cap) : 5000;
}

function tag(res: Response, by: "thinkpad" | "fallback"): Response {
  if (res.status === 101) return res; // a WebSocket: its headers can't be copied into a new Response
  const out = new Response(res.body, res);
  out.headers.set(SERVED_BY, by);
  return out;
}
