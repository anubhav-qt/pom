import "server-only";

/**
 * Find Your Pick is open to anyone, and runs on the same model accounts as Seelie,
 * whose limits are hidden and shared. These keep a burst of shoppers (or a script)
 * from spending them: a few journeys an hour per visitor, a ceiling a day for the
 * whole shop, and only so many model calls at once. Counted in memory, which is
 * right for the one ThinkPad process that serves it; a restart forgives everyone.
 */

const PER_VISITOR_WINDOW_MS = 60 * 60_000;
/** Steps (model calls) a visitor gets in an hour: about six full journeys. */
const PER_VISITOR_STEPS = 36;
/** Steps the whole shop gets in a day. */
const DAILY_STEPS = 2500;
/** Model calls in flight at once. */
const CONCURRENT = 6;

type Limits = { visitors: Map<string, number[]>; day: string; dayCount: number; inFlight: number };
const state: Limits = ((globalThis as { __pickLimits?: Limits }).__pickLimits ??= { visitors: new Map(), day: "", dayCount: 0, inFlight: 0 });

export type Refusal = { status: 429 | 503; error: string; retryAfter?: number };

/** Takes a step for this visitor, or says why not. Call `release` when the model call ends. */
export function takeStep(visitor: string): { release: () => void } | Refusal {
  const now = Date.now();
  const today = new Date(now + 5.5 * 3_600_000).toISOString().slice(0, 10);
  if (state.day !== today) {
    state.day = today;
    state.dayCount = 0;
  }
  if (state.dayCount >= DAILY_STEPS) return { status: 503, error: "Find Your Pick is resting for today. The whole shop is still open." };
  if (state.inFlight >= CONCURRENT) return { status: 429, error: "Lots of people are finding their pick right now. Try again in a moment.", retryAfter: 5 };

  const recent = (state.visitors.get(visitor) ?? []).filter((t) => now - t < PER_VISITOR_WINDOW_MS);
  if (recent.length >= PER_VISITOR_STEPS) {
    const retryAfter = Math.ceil((recent[0] + PER_VISITOR_WINDOW_MS - now) / 1000);
    return { status: 429, error: "That's a lot of picking for one hour. Have a look around the shop and come back a little later.", retryAfter };
  }
  recent.push(now);
  state.visitors.set(visitor, recent);
  state.dayCount++;
  state.inFlight++;

  // Visitors who went quiet don't need remembering.
  if (state.visitors.size > 5000) {
    for (const [key, times] of state.visitors) if (!times.some((t) => now - t < PER_VISITOR_WINDOW_MS)) state.visitors.delete(key);
  }

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      state.inFlight--;
    },
  };
}

/** Who's asking: the address Cloudflare or Caddy saw, else whatever the socket says. */
export function visitorOf(request: Request) {
  const h = request.headers;
  return (
    h.get("cf-connecting-ip")?.trim() ||
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    h.get("x-real-ip")?.trim() ||
    "unknown"
  );
}
