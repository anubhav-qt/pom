import "server-only";

/**
 * Gemini calls over a pool of API keys and a model ladder, one call at a time.
 *
 * Modelled on spoin's load balancer (spoin_bundle/apps/api/src/spoin/generation/
 * load_balancer.py), cut down to what a sequential caller needs:
 *
 * - Keys come from `GEMINI_API_KEYS` (comma separated), falling back to the
 *   single `GEMINI_API_KEY`. Each call starts at the key after the last one
 *   used, so the keys share the load.
 * - The ladder is tried in order, strongest-trusted first: `GEMINI_REEL_MODELS`
 *   or 3.6 → 3.7 → 3.8 flash. Every usable key is tried on a model before the
 *   next model is.
 * - Not every error means the same thing, and each is answered on the thing it
 *   is about:
 *     429 per minute   → that key on that model rests for the `RetryInfo` delay;
 *     429 per day      → that key on that model is done until Google's reset;
 *     401/403/bad key  → the key is set aside for six hours;
 *     404              → the model is set aside for a day (retired or unknown);
 *     5xx / timeout    → the model is benched. 3.7 and 3.8 have been throwing
 *                        5xx often, so one is enough to bench them for 20
 *                        minutes. 3.6 gets one retry before a short bench.
 *     other 400        → our request is wrong; switching keys cannot fix it.
 * - It keeps going until a call succeeds or nothing is left to try. When the
 *   only obstacle is a short per-minute rest, it waits it out instead of
 *   giving up.
 *
 * The scope rule for a 429 is spoin's (ADR-0058/0060): a `RetryInfo` delay of a
 * minute or less means per-minute whatever the quota id says; `PerDay` in the
 * quota id means per-day; an unknown 429 is per-minute, because guessing "day"
 * wrongly retires a key for hours.
 *
 * State is in memory, per server instance. A fresh instance may spend one call
 * rediscovering a key that is out for the day, which is cheap.
 */

const DEFAULT_LADDER = ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.8-flash"];
const API = "https://generativelanguage.googleapis.com/v1beta/models";

const MINUTE_FALLBACK_MS = 60_000;
const DEAD_KEY_MS = 6 * 3600_000;
const MISSING_MODEL_MS = 24 * 3600_000;
const BENCH_MS = 20 * 60_000;
const FIRST_RUNG_BENCH_MS = 3 * 60_000;
const CALL_TIMEOUT_MS = 75_000;
/** Longest per-minute rest worth waiting for rather than giving up. */
const MAX_WAIT_MS = 45_000;
/** Google's free-tier day resets at midnight Pacific: 07:00 UTC under PDT. */
const DAY_RESET_HOUR_UTC = 7;

export function geminiKeys(): string[] {
  const list = (process.env.GEMINI_API_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  if (list.length) return list;
  return process.env.GEMINI_API_KEY ? [process.env.GEMINI_API_KEY.trim()] : [];
}

export function geminiLadder(): string[] {
  const list = (process.env.GEMINI_REEL_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_LADDER;
}

const dayOf = (ms: number) => Math.floor((ms - DAY_RESET_HOUR_UTC * 3600_000) / 86_400_000);

const state = {
  /** `${key}:${model}` → resting until (ms). */
  resting: new Map<string, number>(),
  /** `${key}:${model}` → the provider day it ran out on. */
  spent: new Map<string, number>(),
  /** key index → set aside until (ms). */
  deadKey: new Map<number, number>(),
  /** model → benched until (ms). */
  benched: new Map<string, number>(),
  nextKey: 0,
};

export class GeminiRequestError extends Error {}
export class GeminiUnavailableError extends Error {
  constructor(
    message: string,
    readonly attempts: Attempt[],
  ) {
    super(message);
  }
}

export interface Attempt {
  key: number;
  model: string;
  outcome: "ok" | "minute" | "day" | "key" | "missing" | "server" | "output";
  status?: number;
  detail?: string;
}

type Outcome =
  | { ok: true; text: string }
  | { ok: false; kind: Exclude<Attempt["outcome"], "ok">; status?: number; retryMs?: number; detail: string }
  | { ok: false; kind: "request"; status: number; detail: string };

interface GeminiBody {
  systemInstruction?: { parts: { text: string }[] };
  contents: { role: "user"; parts: ({ text: string } | { inlineData: { mimeType: string; data: string } })[] }[];
  generationConfig?: Record<string, unknown>;
}

function parseDelay(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^([\d.]+)s$/.exec(v.trim());
  return m ? Number(m[1]) * 1000 : undefined;
}

/** Read one HTTP response into what it means for the pool. */
async function classify(res: Response): Promise<Outcome> {
  const raw = await res.text();
  if (res.ok) {
    try {
      const json = JSON.parse(raw);
      const cand = json.candidates?.[0];
      const text = (cand?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join("");
      if (!text) {
        const why = json.promptFeedback?.blockReason ?? cand?.finishReason ?? "empty answer";
        return { ok: false, kind: "output", status: 200, detail: String(why) };
      }
      return { ok: true, text };
    } catch {
      return { ok: false, kind: "output", status: 200, detail: "unreadable answer" };
    }
  }

  let error: { message?: string; status?: string; details?: Record<string, unknown>[] } = {};
  try {
    error = JSON.parse(raw).error ?? {};
  } catch {
    // Not JSON: a proxy or gateway page. The status code is all there is.
  }
  const message = (error.message ?? raw).slice(0, 300);
  const status = res.status;

  if (status === 429) {
    let retryMs: number | undefined;
    const quotaIds: string[] = [];
    for (const d of error.details ?? []) {
      if (String(d["@type"] ?? "").endsWith("RetryInfo")) retryMs = parseDelay(d.retryDelay);
      const violations = Array.isArray(d.violations) ? (d.violations as Record<string, unknown>[]) : [];
      for (const c of [d, ...violations]) if (c.quotaId) quotaIds.push(String(c.quotaId));
    }
    const ids = quotaIds.join(" ").toLowerCase();
    if (retryMs !== undefined && retryMs <= 60_000) return { ok: false, kind: "minute", status, retryMs, detail: message };
    if (ids.includes("perday")) return { ok: false, kind: "day", status, detail: message };
    if (ids.includes("perminute")) return { ok: false, kind: "minute", status, retryMs, detail: message };
    if (retryMs !== undefined) return { ok: false, kind: "day", status, detail: message };
    return { ok: false, kind: "minute", status, detail: message };
  }
  const badKey =
    status === 401 ||
    status === 403 ||
    (status === 400 && /api key not valid|API_KEY_INVALID|API key expired/i.test(raw));
  if (badKey) return { ok: false, kind: "key", status, detail: message };
  if (status === 404) return { ok: false, kind: "missing", status, detail: message };
  if (status >= 500 || status === 408) return { ok: false, kind: "server", status, detail: message };
  return { ok: false, kind: "request", status, detail: message };
}

async function callOnce(key: string, model: string, body: GeminiBody, signal?: AbortSignal): Promise<Outcome> {
  const timeout = AbortSignal.timeout(CALL_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const res = await fetch(`${API}/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: combined,
    });
    return await classify(res);
  } catch (e) {
    if (signal?.aborted) throw e;
    // A timeout or a dropped connection: the model's side, like a 504.
    return { ok: false, kind: "server", detail: e instanceof Error ? e.message : "network error" };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One Gemini `generateContent` call that answers in JSON, retried across keys
 * and models as described at the top of this file.
 */
export async function geminiJson<T>(
  body: GeminiBody,
  opts: { signal?: AbortSignal; deadlineMs?: number; log?: (line: string) => void } = {},
): Promise<{ data: T; model: string; attempts: Attempt[] }> {
  const keys = geminiKeys();
  if (keys.length === 0) throw new GeminiRequestError("No Gemini API key is set (GEMINI_API_KEYS).");
  const ladder = geminiLadder();
  const deadline = Date.now() + (opts.deadlineMs ?? 150_000);
  const attempts: Attempt[] = [];
  const log = opts.log ?? (() => {});

  for (let round = 0; round < 6; round++) {
    let triedAny = false;

    for (const [rung, model] of ladder.entries()) {
      const now = Date.now();
      if ((state.benched.get(model) ?? 0) > now) continue;

      const start = state.nextKey % keys.length;
      for (let step = 0; step < keys.length; step++) {
        const k = (start + step) % keys.length;
        const cell = `${k}:${model}`;
        const t = Date.now();
        if ((state.deadKey.get(k) ?? 0) > t) continue;
        if (state.spent.get(cell) === dayOf(t)) continue;
        if ((state.resting.get(cell) ?? 0) > t) continue;
        if (t > deadline) break;

        triedAny = true;
        state.nextKey = k + 1;
        let out = await callOnce(keys[k], model, body, opts.signal);

        // The first rung is the one we trust; a single 5xx earns it one retry.
        if (!out.ok && out.kind === "server" && rung === 0) {
          attempts.push({ key: k, model, outcome: "server", status: out.status, detail: out.detail });
          log(`gemini key ${k} ${model}: ${out.status ?? "timeout"}, retrying once`);
          await sleep(2000);
          out = await callOnce(keys[k], model, body, opts.signal);
        }

        if (out.ok) {
          try {
            const data = JSON.parse(out.text) as T;
            attempts.push({ key: k, model, outcome: "ok" });
            return { data, model, attempts };
          } catch {
            out = { ok: false, kind: "output", status: 200, detail: "answer was not valid JSON" };
          }
        }
        if (out.kind === "request") {
          throw new GeminiRequestError(`Gemini rejected the request (${out.status}): ${out.detail}`);
        }

        attempts.push({ key: k, model, outcome: out.kind, status: out.status, detail: out.detail });
        log(`gemini key ${k} ${model}: ${out.kind} ${out.status ?? ""} ${out.detail.slice(0, 120)}`);

        const at = Date.now();
        if (out.kind === "minute") {
          state.resting.set(cell, at + (out.retryMs ?? MINUTE_FALLBACK_MS));
          continue;
        }
        if (out.kind === "day") {
          state.spent.set(cell, dayOf(at));
          continue;
        }
        if (out.kind === "key") {
          state.deadKey.set(k, at + DEAD_KEY_MS);
          continue;
        }
        if (out.kind === "missing") {
          state.benched.set(model, at + MISSING_MODEL_MS);
          break;
        }
        if (out.kind === "server") {
          state.benched.set(model, at + (rung === 0 ? FIRST_RUNG_BENCH_MS : BENCH_MS));
          break;
        }
        // "output": a malformed or empty answer. Not the key's fault and not
        // an outage; the next model gets the turn.
        break;
      }
    }

    // Nothing answered. If a key is only resting for a short while, wait for it.
    const now = Date.now();
    let soonest = Infinity;
    for (const model of ladder) {
      if ((state.benched.get(model) ?? 0) > now) continue;
      for (let k = 0; k < keys.length; k++) {
        const cell = `${k}:${model}`;
        if ((state.deadKey.get(k) ?? 0) > now || state.spent.get(cell) === dayOf(now)) continue;
        soonest = Math.min(soonest, Math.max(now, state.resting.get(cell) ?? now));
      }
    }
    const wait = soonest - now;
    if (soonest === Infinity || wait > MAX_WAIT_MS || now + wait > deadline) break;
    if (!triedAny || wait > 0) {
      log(`gemini: every key is resting, waiting ${Math.ceil(wait / 1000)}s`);
      await sleep(wait + 250);
    }
  }

  const last = attempts[attempts.length - 1];
  throw new GeminiUnavailableError(
    attempts.length
      ? `Gemini did not answer after ${attempts.length} tries across ${keys.length} key${keys.length === 1 ? "" : "s"} and ${ladder.length} models (last: ${last.model}, ${last.outcome}${last.status ? ` ${last.status}` : ""}).`
      : "Every Gemini key and model is resting or out of quota right now. Try again later.",
    attempts,
  );
}
