import "server-only";

import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { seelieImageCalls, seelieSettings, seelieShoots } from "@/db/schema";

import { listCredentials } from "../cliproxy";
import { GeminiError, generateContent, IMAGE_MODEL, type GeminiRequest } from "../gemini";

/**
 * The image budget. The Antigravity account makes about 9 images and then answers 429
 * "You have exhausted your capacity on this model. Your quota will reset after 2h12m7s":
 * a window of ~5 hours per account that Google's quota APIs don't show (they still read
 * 87% left). So every image call is written to a ledger (seelie_image_calls), and the
 * budget is worked out from it: how many each account makes per window (learned from
 * where the 429s land), times the accounts connected, minus what the window has used.
 * A 429 with its reset time is the final word until that time passes.
 */

export const WINDOW_MS = 5 * 3600_000;
/** Measured on the Google AI Pro account (2026-10-02). Learned from the ledger after that. */
const FIRST_GUESS = 9;
/** A 429 that resets sooner than this is a rate limit (too many at once), not the window. */
const RATE_LIMIT_MS = 3 * 60_000;
const SETTINGS_KEY = "image_cap";

/** A ledger row whose 429 named the window's reset (not a rate limit). */
const longWait = sql`${seelieImageCalls.resetAt} - ${seelieImageCalls.at} >= ${`${RATE_LIMIT_MS / 1000} seconds`}::interval`;

interface CapSettings {
  /** Images per account per window. */
  perAccount: number;
  /** Antigravity accounts last seen, for when CLIProxyAPI can't be asked. */
  accounts: number;
  learnedAt?: string;
}

/**
 * The wait a 429 names, in ms: "reset after 2h12m7s", "retry in 34.5s",
 * or a google.rpc.RetryInfo `"retryDelay": "7920s"`. Null if it names none.
 */
export function parseResetMs(message: string): number | null {
  const near = /(?:reset|retry)[^0-9]{0,24}((?:\d+(?:\.\d+)?\s*(?:h|m(?!s)|s|ms)\s*)+)/i.exec(message);
  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  if (near) {
    let ms = 0;
    for (const m of near[1].matchAll(/(\d+(?:\.\d+)?)\s*(ms|h|m|s)/gi)) {
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      ms += unit === "h" ? n * 3600_000 : unit === "m" ? n * 60_000 : unit === "s" ? n * 1000 : n;
    }
    if (ms > 0) return Math.round(ms);
  }
  if (delay) return Math.round(Number(delay[1]) * 1000);
  return null;
}

async function readSettings(): Promise<CapSettings> {
  const [row] = await db.select({ value: seelieSettings.value }).from(seelieSettings).where(eq(seelieSettings.key, SETTINGS_KEY)).limit(1);
  const v = (row?.value ?? {}) as Partial<CapSettings>;
  return { perAccount: v.perAccount && v.perAccount > 0 ? v.perAccount : FIRST_GUESS, accounts: v.accounts && v.accounts > 0 ? v.accounts : 1, learnedAt: v.learnedAt };
}

async function writeSettings(value: CapSettings) {
  await db
    .insert(seelieSettings)
    .values({ key: SETTINGS_KEY, value })
    .onConflictDoUpdate({ target: seelieSettings.key, set: { value, updatedAt: new Date() } });
}

/** Antigravity accounts switched on in CLIProxyAPI (each has its own window). */
async function antigravityAccounts(saved: number): Promise<number> {
  try {
    const creds = await listCredentials();
    const n = creds.filter((c) => c.provider === "antigravity" && !c.disabled).length;
    return Math.max(1, n);
  } catch {
    return saved;
  }
}

export interface ImageBudget {
  /** Images the connected accounts make per window, as learned. */
  capacity: number;
  perAccount: number;
  accounts: number;
  /** Made in the current window. */
  used: number;
  left: number;
  /** A 429 said no more until then. */
  blockedUntil: string | null;
  /** When the window frees up again (the 429's time, or ~5 h after its first image). */
  resetAt: string | null;
  /** Looks waiting in shoots for the budget to come back. */
  waiting: number;
}

/** When the latest window-ending 429 said the images come back (past or still ahead). */
async function latestReset(): Promise<Date | null> {
  const [lastLimit] = await db
    .select({ resetAt: seelieImageCalls.resetAt })
    .from(seelieImageCalls)
    .where(and(eq(seelieImageCalls.outcome, "limit"), longWait))
    .orderBy(desc(seelieImageCalls.resetAt))
    .limit(1);
  return lastLimit?.resetAt ?? null;
}

/** Looks waiting in shoots for the budget to come back. */
async function waitingLooks(): Promise<number> {
  const [waiting] = await db
    .select({ n: sql<number>`coalesce(sum(jsonb_array_length(jsonb_path_query_array(${seelieShoots.looks}, '$[*] ? (@.status == "waiting")'))), 0)::int` })
    .from(seelieShoots)
    .where(eq(seelieShoots.status, "waiting"));
  return Number(waiting?.n ?? 0);
}

export async function imageBudget(): Promise<ImageBudget> {
  const settings = await readSettings();
  const accounts = await antigravityAccounts(settings.accounts);
  if (accounts !== settings.accounts) await writeSettings({ ...settings, accounts }).catch(() => {});
  const now = Date.now();

  const lastReset = await latestReset();
  const blocked = lastReset && lastReset.getTime() > now ? lastReset : null;

  const since = new Date(Math.max(now - WINDOW_MS, lastReset && !blocked ? lastReset.getTime() : 0));
  const [usage] = await db
    .select({ n: sql<number>`count(*)::int`, first: sql<Date | null>`min(${seelieImageCalls.at})` })
    .from(seelieImageCalls)
    .where(and(eq(seelieImageCalls.outcome, "ok"), gte(seelieImageCalls.at, since)));
  const used = blocked ? 0 : Number(usage?.n ?? 0);
  const first = usage?.first ? new Date(usage.first) : null;

  const capacity = settings.perAccount * accounts;
  const waiting = await waitingLooks();

  return {
    capacity,
    perAccount: settings.perAccount,
    accounts,
    used,
    left: blocked ? 0 : Math.max(0, capacity - used),
    blockedUntil: blocked ? blocked.toISOString() : null,
    resetAt: blocked ? blocked.toISOString() : first ? new Date(first.getTime() + WINDOW_MS).toISOString() : null,
    waiting,
  };
}

export interface ImageReset {
  /** The limit is used up until then. */
  blockedUntil: string | null;
  /** The latest time the limit came back, if it has. */
  cameBack: string | null;
  waiting: number;
  /** The chat of this user's newest shoot with looks waiting. */
  waitingChat: string | null;
}

/** For the OMS-wide note that photoshoots are back. Ledger only: cheap enough to ask often. */
export async function imageReset(userId: number): Promise<ImageReset> {
  const [reset, waiting, [shoot]] = await Promise.all([
    latestReset(),
    waitingLooks(),
    db
      .select({ chatId: seelieShoots.chatId })
      .from(seelieShoots)
      .where(and(eq(seelieShoots.status, "waiting"), eq(seelieShoots.userId, userId), isNotNull(seelieShoots.chatId)))
      .orderBy(desc(seelieShoots.updatedAt))
      .limit(1),
  ]);
  const ahead = !!reset && reset.getTime() > Date.now();
  return {
    blockedUntil: ahead ? reset.toISOString() : null,
    cameBack: reset && !ahead ? reset.toISOString() : null,
    waiting,
    waitingChat: shoot?.chatId ?? null,
  };
}

/** After a 429 that names the window's reset: how many the window held, per account. */
async function learnFromLimit(resetAt: Date) {
  const settings = await readSettings();
  const windowStart = new Date(resetAt.getTime() - WINDOW_MS);
  // The previous window's reset (a long 429 already past), if it fell inside this window.
  const [prev] = await db
    .select({ resetAt: seelieImageCalls.resetAt })
    .from(seelieImageCalls)
    .where(
      and(
        eq(seelieImageCalls.outcome, "limit"),
        sql`${seelieImageCalls.resetAt} <= now()`,
        longWait,
      ),
    )
    .orderBy(desc(seelieImageCalls.resetAt))
    .limit(1);
  const from = new Date(Math.max(windowStart.getTime(), prev?.resetAt?.getTime() ?? 0));
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(seelieImageCalls)
    .where(and(eq(seelieImageCalls.outcome, "ok"), gte(seelieImageCalls.at, from)));
  const made = Number(row?.n ?? 0);
  if (made < 1) return;
  const perAccount = Math.max(1, Math.round(made / settings.accounts));
  if (perAccount !== settings.perAccount) await writeSettings({ ...settings, perAccount, learnedAt: new Date().toISOString() });
}

/** More images went through in a window than we thought it held: it holds at least that many. */
async function learnFromSuccess(budget: ImageBudget) {
  if (budget.used <= budget.capacity) return;
  const settings = await readSettings();
  const perAccount = Math.ceil(budget.used / budget.accounts);
  if (perAccount > settings.perAccount) await writeSettings({ ...settings, perAccount, learnedAt: new Date().toISOString() });
}

/* -------------------------------------------------------------------------- */
/* Calling the image model                                                    */
/* -------------------------------------------------------------------------- */

/** The image model said no more for now. */
export class CapError extends Error {
  constructor(
    message: string,
    readonly resetAt: string | null,
  ) {
    super(message);
    this.name = "CapError";
  }
}

/** At most this many image calls at once per process (more trips a rate limit, and each holds ~10 MB). */
const PARALLEL = 2;
let running = 0;
const waiters: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  while (running >= PARALLEL) await new Promise<void>((ok) => waiters.push(ok));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiters.shift()?.();
  }
}

export interface ImageCall {
  chatId: string | null;
  shootId?: number | null;
  look?: string | null;
  size?: string;
  aspect?: string;
  refs: number;
}

export interface MadeImage {
  bytes: Buffer;
  mimeType: string;
  /** What the model said alongside it, if anything. */
  text: string;
  ms: number;
}

/**
 * One image from the image model, written to the ledger whatever happens. Refuses
 * without calling while a 429's reset is still ahead (the call would only fail).
 */
export async function makeImage(body: GeminiRequest, call: ImageCall, signal: AbortSignal): Promise<MadeImage> {
  const before = await imageBudget();
  if (before.blockedUntil) throw new CapError("The image model's limit is used up.", before.blockedUntil);
  return slot(async () => {
    const started = Date.now();
    const log = (outcome: string, extra: { resetAt?: Date | null; error?: string } = {}) =>
      db
        .insert(seelieImageCalls)
        .values({
          chatId: call.chatId,
          shootId: call.shootId ?? null,
          look: call.look ?? null,
          model: IMAGE_MODEL,
          size: call.size ?? null,
          aspect: call.aspect ?? null,
          refs: call.refs,
          outcome,
          resetAt: extra.resetAt ?? null,
          ms: Date.now() - started,
          error: extra.error?.slice(0, 1000) ?? null,
        })
        .catch((err) => console.error("[seelie] image ledger", err));
    try {
      const res = await generateContent(IMAGE_MODEL, body, { signal, timeoutMs: 240_000 });
      const image = res.images[0];
      if (!image) {
        await log("empty", { error: res.text.slice(0, 500) || "no image" });
        throw new GeminiError(`No image came back${res.text ? `; the model said: ${res.text.slice(0, 300)}` : ""}.`, 200);
      }
      await log("ok");
      await learnFromSuccess(await imageBudget()).catch(() => {});
      return { bytes: image.bytes, mimeType: image.mimeType, text: res.text, ms: Date.now() - started };
    } catch (err) {
      if (err instanceof GeminiError && err.status === 429) {
        const wait = parseResetMs(err.message);
        const resetAt = new Date(Date.now() + (wait ?? 60_000));
        await log("limit", { resetAt, error: err.message });
        if (wait !== null && wait >= RATE_LIMIT_MS) {
          await learnFromLimit(resetAt).catch(() => {});
          throw new CapError("The image model's limit is used up.", resetAt.toISOString());
        }
        throw new CapError("The image model is busy (too many at once).", resetAt.toISOString());
      }
      if (err instanceof GeminiError && err.status !== 200) await log("error", { error: err.message });
      throw err;
    }
  });
}

/** One line for the system prompt. */
export function budgetLine(b: ImageBudget, fmt: (iso: string) => string) {
  const accounts = b.accounts > 1 ? ` across ${b.accounts} accounts` : "";
  const waiting = b.waiting ? ` ${b.waiting} look${b.waiting === 1 ? " is" : "s are"} waiting for it.` : "";
  if (b.blockedUntil) return `Image generation: used up; it comes back at about ${fmt(b.blockedUntil)}.${waiting}`;
  const reset = b.resetAt ? `, the window frees up at about ${fmt(b.resetAt)}` : "";
  return `Image generation: about ${b.left} of ~${b.capacity} images left${accounts}${reset}.${waiting}`;
}
