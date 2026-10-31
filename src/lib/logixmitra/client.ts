import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { seelieSettings, type User } from "@/db/schema";
import { seal, unseal, type Sealed } from "@/lib/seelie/sealed";

/**
 * Logixmitra (admin.logixmitra.com), the courier aggregator paribelle.in ships
 * through, reached through the seller API its panel documents: sign in with the
 * panel's email and password for a 7-day token, push orders, book a courier,
 * track by AWB.
 *
 * The owner saves the login once, in Seelie's settings. The password is kept
 * encrypted (like the store's) so the OMS can sign in again whenever the token
 * runs out; the token itself lives in memory.
 */

const SETTINGS_KEY = "logixmitra";
const TIMEOUT_MS = 60_000;

export function logixmitraApiUrl() {
  return (process.env.LOGIXMITRA_API_URL?.trim() || "https://api.logixmitra.com/api").replace(/\/+$/, "");
}

export class LogixmitraError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

/* -------------------------------------------------------------------------- */
/* The saved login                                                            */
/* -------------------------------------------------------------------------- */

interface StoredLogin {
  email: string;
  password: Sealed;
  /** The seller's id in Logixmitra, sent with pushes and bookings. */
  sellerId: number;
  name: string | null;
  /** Orders placed before this aren't sent: only new ones go to Logixmitra. */
  savedAt: string;
  /** Set when a silent sign-in was refused: the password changed. */
  failedAt: string | null;
}

async function readLogin(): Promise<StoredLogin | null> {
  const [row] = await db.select().from(seelieSettings).where(eq(seelieSettings.key, SETTINGS_KEY)).limit(1);
  return (row?.value as StoredLogin | undefined) ?? null;
}

async function writeLogin(value: StoredLogin, userId: number | null) {
  await db
    .insert(seelieSettings)
    .values({ key: SETTINGS_KEY, value, updatedBy: userId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: seelieSettings.key, set: { value, updatedBy: userId, updatedAt: new Date() } });
}

const cache = ((globalThis as { __logixmitraToken?: { token: string | null; expiresAt: number } }).__logixmitraToken ??= {
  token: null,
  expiresAt: 0,
});

function expiryOf(token: string) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { exp?: number };
    if (payload.exp) return payload.exp * 1000;
  } catch {
    // Not a JWT we can read; assume a day.
  }
  return Date.now() + 86_400_000;
}

async function login(email: string, password: string) {
  let res: Response;
  try {
    res = await fetch(`${logixmitraApiUrl()}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new LogixmitraError(`Logixmitra can't be reached (${err instanceof Error ? err.message : String(err)}).`);
  }
  const body = (await res.json().catch(() => null)) as {
    success?: boolean;
    message?: string;
    data?: { token?: string; user?: { id?: number; name?: string } };
  } | null;
  const token = body?.data?.token;
  const sellerId = body?.data?.user?.id;
  if (!token || typeof sellerId !== "number") {
    if (res.status === 400 || res.status === 401 || res.status === 403 || body?.success === false) return null;
    throw new LogixmitraError(`Logixmitra refused the sign-in (${res.status}).`, res.status, body);
  }
  return { token, sellerId, name: body?.data?.user?.name ?? null };
}

export interface LogixmitraStatus {
  signedIn: boolean;
  email: string | null;
  name: string | null;
  /** The saved password stopped working: sign in again. */
  needsSignIn: boolean;
  savedAt: string | null;
}

export async function logixmitraStatus(): Promise<LogixmitraStatus> {
  const saved = await readLogin();
  return {
    signedIn: !!saved && !saved.failedAt,
    email: saved?.email ?? null,
    name: saved?.name ?? null,
    needsSignIn: !!saved?.failedAt,
    savedAt: saved?.savedAt ?? null,
  };
}

/** The saved login, when it works: the seller and the moment new orders started going over. */
export async function logixmitraAccount(): Promise<{ sellerId: number; since: Date } | null> {
  const saved = await readLogin();
  if (!saved || saved.failedAt) return null;
  return { sellerId: saved.sellerId, since: new Date(saved.savedAt) };
}

/** The owner saves the Logixmitra login. Checked against Logixmitra before anything is kept. */
export async function signInLogixmitra(user: User, email: string, password: string): Promise<LogixmitraStatus> {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !password) throw new LogixmitraError("Enter the email and password.");
  const result = await login(cleanEmail, password);
  if (!result) throw new LogixmitraError("That email and password don't sign in to Logixmitra.");
  const before = await readLogin();
  await writeLogin(
    {
      email: cleanEmail,
      password: seal(password, SETTINGS_KEY),
      sellerId: result.sellerId,
      name: result.name,
      // Signing in again after a password change keeps the first start: orders in between still go.
      savedAt: before && before.sellerId === result.sellerId ? before.savedAt : new Date().toISOString(),
      failedAt: null,
    },
    user.id,
  );
  cache.token = result.token;
  cache.expiresAt = expiryOf(result.token);
  return logixmitraStatus();
}

export async function signOutLogixmitra() {
  await db.delete(seelieSettings).where(eq(seelieSettings.key, SETTINGS_KEY));
  cache.token = null;
  cache.expiresAt = 0;
}

async function token(fresh = false): Promise<string> {
  if (!fresh && cache.token && cache.expiresAt > Date.now() + 5 * 60_000) return cache.token;
  const saved = await readLogin();
  if (!saved) throw new LogixmitraError("Logixmitra isn't connected. The owner signs in from Seelie's settings.");
  if (saved.failedAt) throw new LogixmitraError("Logixmitra's password changed. The owner signs in again from Seelie's settings.");
  let password: string;
  try {
    password = unseal(saved.password, SETTINGS_KEY);
  } catch {
    throw new LogixmitraError("The saved Logixmitra login can't be read (AUTH_SECRET changed). Sign in again from Seelie's settings.");
  }
  const result = await login(saved.email, password);
  if (!result) {
    await writeLogin({ ...saved, failedAt: new Date().toISOString() }, null);
    cache.token = null;
    throw new LogixmitraError("Logixmitra's password changed. The owner signs in again from Seelie's settings.");
  }
  cache.token = result.token;
  cache.expiresAt = expiryOf(result.token);
  return result.token;
}

/* -------------------------------------------------------------------------- */
/* Calling the API                                                            */
/* -------------------------------------------------------------------------- */

function messageOf(body: unknown, status: number) {
  if (body && typeof body === "object") {
    const m = (body as { message?: unknown; error?: unknown }).message ?? (body as { error?: unknown }).error;
    if (typeof m === "string" && m.trim()) return m.trim();
  }
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 300);
  return `HTTP ${status}`;
}

/** One call to Logixmitra's API as the saved seller. Answers the parsed body; throws LogixmitraError. */
export async function logixmitraFetch<T = unknown>(
  method: "GET" | "POST" | "PUT" | "PATCH",
  path: string,
  body?: unknown,
  query?: Record<string, string | number | undefined>,
): Promise<T> {
  const url = new URL(`${logixmitraApiUrl()}/${path.replace(/^\/+/, "")}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  const send = async (bearer: string) => {
    try {
      return await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new LogixmitraError(`Logixmitra can't be reached (${err instanceof Error ? err.message : String(err)}).`);
    }
  };
  let res = await send(await token());
  if (res.status === 401) res = await send(await token(true));
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON; keep the text.
  }
  if (!res.ok && res.status !== 207) throw new LogixmitraError(`${method} ${path}: ${messageOf(parsed, res.status)}`, res.status, parsed);
  return parsed as T;
}
