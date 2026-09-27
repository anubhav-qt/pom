import { failover, relay, type DownState } from "./failover.ts";

/**
 * paribelle-edge: puts the ThinkPad in front of what already serves Paribelle.
 *
 *   www.paribelle.in/*   the storefront, and the OMS under /pom. The ThinkPad first; when it
 *                        can't answer, the request goes on to where it always went: this
 *                        zone's DNS record for www, which is Vercel. Same address, same
 *                        cookies, so a visitor never notices which one answered.
 *   api.paribelle.in     the API. The ThinkPad first, then Render.
 *
 * It only passes requests along, about a millisecond of CPU each, so the free plan covers
 * it: 100,000 requests a day. Past that Cloudflare skips the Worker for the rest of the day
 * (the routes' "fail open"), and www goes straight to Vercel, as before the ThinkPad.
 *
 * Without the EDGE_KEY secret every request goes to the fallback: deleting it is the way to
 * take the ThinkPad out of service by hand.
 */

export interface Env {
  /** The tunnel to the ThinkPad's gate: https://laptop.paribelle.in */
  THINKPAD_ORIGIN: string;
  /** Render's own address (api.paribelle.in is this Worker). */
  RENDER_ORIGIN: string;
  API_HOST: string;
  EDGE_KEY?: string;
  /** Only for trying the Worker locally, where no DNS record stands behind www. */
  WWW_FALLBACK_ORIGIN?: string;
}

// The ThinkPad serves two databases' worth of apps, each ready on its own (the shop: the
// storefront and the API; the OMS). One catching up shouldn't send the other away.
type Downs = Record<"shop" | "oms", DownState>;
const isolate: Downs = { shop: { until: 0 }, oms: { until: 0 } };

export function isOms(path: string) {
  return path === "/pom" || path.startsWith("/pom/");
}

export default {
  fetch: (req: Request, env: Env) => handle(req, env),
};

/** `fetcher` and `down` are for tests. */
export function handle(req: Request, env: Env, fetcher: typeof fetch = fetch, down: Downs = isolate): Promise<Response> {
  const url = new URL(req.url);
  const edgeKey = env.EDGE_KEY ?? "";

  if (url.host === env.API_HOST) {
    return failover(
      req,
      { primary: env.THINKPAD_ORIGIN, edgeKey, fetch: fetcher, fallback: (r) => fetcher(relay(r, env.RENDER_ORIGIN, edgeKey)) },
      down.shop,
    );
  }

  // Redirects (Vercel's own, www's) go back to the browser as they are.
  const toVercel = (r: Request) =>
    fetcher(new Request(env.WWW_FALLBACK_ORIGIN ? new URL(url.pathname + url.search, env.WWW_FALLBACK_ORIGIN) : r.url, new Request(r, { redirect: "manual" })));
  // Vercel renews its certificate for www over plain HTTP: that's between it and Let's Encrypt.
  if (url.pathname.startsWith("/.well-known/acme-challenge/")) return toVercel(req);

  const oms = isOms(url.pathname);
  return failover(
    req,
    // The OMS's pages (reports, PDFs) can take a while even when all is well.
    { primary: env.THINKPAD_ORIGIN, edgeKey, fetch: fetcher, timeoutMs: oms ? 15_000 : 8000, fallback: toVercel },
    oms ? down.oms : down.shop,
  );
}
