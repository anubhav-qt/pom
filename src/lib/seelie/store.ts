import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { seelieSettings, type User } from "@/db/schema";

import { seal, unseal, type Sealed } from "./sealed";

/**
 * paribelle.in, the storefront, as Seelie reaches it: its NestJS API, signed in as
 * the owner's admin account.
 *
 * The owner signs in once, in Seelie's settings. The email and password are kept
 * (the password encrypted with a key derived from AUTH_SECRET) so Seelie can sign
 * in again by itself whenever the API's 7-day token runs out; it only asks again
 * when the password stops working. The token itself lives in memory.
 *
 * Without PARIBELLE_API_URL (the Vercel fallback, a laptop without the shop) the
 * store tools are hidden.
 */

const SETTINGS_KEY = "store";
/** The store's own vendor row, which every product it sells belongs to. */
export const STORE_VENDOR_ID = process.env.PARIBELLE_STORE_VENDOR_ID?.trim() || "00000000-0000-0000-0000-000000000001";
const ADMIN_ROLES = ["super_admin", "vendor_admin"];
const TIMEOUT_MS = 60_000;

export function storeApiUrl(): string | null {
  const url = process.env.PARIBELLE_API_URL?.trim().replace(/\/+$/, "");
  return url || null;
}

/** Where the API describes itself (Swagger): /api/docs-json beside /api/v1. */
function docsUrl(api: string) {
  return api.replace(/\/api\/v\d+$/, "") + "/api/docs-json";
}

/* -------------------------------------------------------------------------- */
/* The saved login                                                            */
/* -------------------------------------------------------------------------- */

interface StoredLogin {
  email: string;
  password: Sealed;
  name: string | null;
  role: string | null;
  /** Set when a silent sign-in was refused: the password changed. */
  failedAt: string | null;
  savedAt: string;
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

/* -------------------------------------------------------------------------- */
/* Signing in                                                                 */
/* -------------------------------------------------------------------------- */

const tokens: Map<string, { token: string; expiresAt: number }> = ((globalThis as { __seelieStoreTokens?: Map<string, { token: string; expiresAt: number }> }).__seelieStoreTokens ??=
  new Map());

export class StoreError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

function expiryOf(token: string) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { exp?: number };
    if (payload.exp) return payload.exp * 1000;
  } catch {
    // Not a JWT we can read; assume a day.
  }
  return Date.now() + 86_400_000;
}

async function login(api: string, email: string, password: string) {
  let res: Response;
  try {
    res = await fetch(`${api}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new StoreError(`paribelle.in's API can't be reached (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (res.status === 401) return null;
  const body = (await res.json().catch(() => null)) as { access_token?: string; user?: { firstName?: string; lastName?: string; role?: string } } | null;
  if (!res.ok || !body?.access_token) {
    throw new StoreError(`paribelle.in refused the sign-in (${res.status}).`, res.status);
  }
  const name = [body.user?.firstName, body.user?.lastName].filter(Boolean).join(" ") || null;
  return { token: body.access_token, role: body.user?.role ?? null, name };
}

export interface StoreStatus {
  /** PARIBELLE_API_URL is set here. */
  configured: boolean;
  signedIn: boolean;
  email: string | null;
  name: string | null;
  role: string | null;
  /** The saved password stopped working: sign in again. */
  needsSignIn: boolean;
  savedAt: string | null;
}

export async function storeStatus(): Promise<StoreStatus> {
  const configured = storeApiUrl() !== null;
  const saved = await readLogin();
  return {
    configured,
    signedIn: !!saved && !saved.failedAt,
    email: saved?.email ?? null,
    name: saved?.name ?? null,
    role: saved?.role ?? null,
    needsSignIn: !!saved?.failedAt,
    savedAt: saved?.savedAt ?? null,
  };
}

/** Whether the store tools can work at all here (the API is set and a login is saved). */
export async function storeReady() {
  if (!storeApiUrl()) return false;
  const saved = await readLogin();
  return !!saved && !saved.failedAt;
}

/** The owner signs Seelie in. Checked against the API before anything is saved. */
export async function signInStore(user: User, email: string, password: string): Promise<StoreStatus> {
  const api = storeApiUrl();
  if (!api) throw new StoreError("paribelle.in isn't connected on this server (PARIBELLE_API_URL is unset).");
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !password) throw new StoreError("Enter the email and password.");
  const result = await login(api, cleanEmail, password);
  if (!result) throw new StoreError("That email and password don't sign in to paribelle.in.");
  if (!result.role || !ADMIN_ROLES.includes(result.role)) {
    throw new StoreError("That account isn't a paribelle.in admin, so it can't change products.");
  }
  await writeLogin(
    { email: cleanEmail, password: seal(password, "store"), name: result.name, role: result.role, failedAt: null, savedAt: new Date().toISOString() },
    user.id,
  );
  tokens.set(api, { token: result.token, expiresAt: expiryOf(result.token) });
  return storeStatus();
}

export async function signOutStore() {
  await db.delete(seelieSettings).where(eq(seelieSettings.key, SETTINGS_KEY));
  tokens.clear();
}

async function token(api: string, fresh = false): Promise<string> {
  const cached = tokens.get(api);
  if (!fresh && cached && cached.expiresAt > Date.now() + 5 * 60_000) return cached.token;

  const saved = await readLogin();
  if (!saved) throw new StoreError("Seelie isn't signed in to paribelle.in. The owner signs it in from Seelie's settings.");
  if (saved.failedAt) throw new StoreError("paribelle.in's password changed. The owner signs Seelie in again from its settings.");

  let password: string;
  try {
    password = unseal(saved.password, "store");
  } catch {
    throw new StoreError("The saved paribelle.in login can't be read (AUTH_SECRET changed). Sign in again from Seelie's settings.");
  }
  const result = await login(api, saved.email, password);
  if (!result) {
    await writeLogin({ ...saved, failedAt: new Date().toISOString() }, null);
    tokens.delete(api);
    throw new StoreError("paribelle.in's password changed. The owner signs Seelie in again from its settings.");
  }
  tokens.set(api, { token: result.token, expiresAt: expiryOf(result.token) });
  return result.token;
}

/* -------------------------------------------------------------------------- */
/* Calling the API                                                            */
/* -------------------------------------------------------------------------- */

export type StoreMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface StoreRequest {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** A multipart upload instead of a JSON body (rebuilt for a retry, so a function). */
  form?: () => FormData;
  signal?: AbortSignal;
  /** Longer than the usual minute, for a big upload. */
  timeoutMs?: number;
}

function cleanPath(path: string) {
  const p = path.trim();
  if (!p.startsWith("/") || p.includes("..") || /^\/\//.test(p) || /[\s#]/.test(p)) {
    throw new StoreError(`"${path}" isn't an API path (it starts with / under /api/v1, e.g. /products).`);
  }
  return p.replace(/^\/api\/v1(?=\/)/, "");
}

function errorText(body: unknown, status: number) {
  if (body && typeof body === "object") {
    const m = (body as { message?: unknown }).message;
    if (Array.isArray(m)) return m.join("; ");
    if (typeof m === "string") return m;
  }
  if (typeof body === "string" && body.trim()) return body.slice(0, 500);
  return `HTTP ${status}`;
}

/** One API call as the signed-in admin. Answers the parsed body; throws StoreError on failure. */
export async function storeFetch<T = unknown>(method: StoreMethod, path: string, req: StoreRequest = {}): Promise<T> {
  const api = storeApiUrl();
  if (!api) throw new StoreError("paribelle.in isn't connected on this server.");
  const url = new URL(api + cleanPath(path));
  for (const [k, v] of Object.entries(req.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const send = async (bearer: string) => {
    const limit = AbortSignal.timeout(req.timeoutMs ?? TIMEOUT_MS);
    const signal = req.signal ? AbortSignal.any([req.signal, limit]) : limit;
    return fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: "application/json",
        ...(req.body !== undefined && !req.form ? { "content-type": "application/json" } : {}),
      },
      body: req.form ? req.form() : req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal,
    });
  };

  let res: Response;
  try {
    res = await send(await token(api));
    if (res.status === 401) res = await send(await token(api, true));
  } catch (err) {
    if (err instanceof StoreError) throw err;
    throw new StoreError(`paribelle.in's API can't be reached (${err instanceof Error ? err.message : String(err)}).`);
  }

  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON; keep the text.
  }
  if (!res.ok) throw new StoreError(`${method} ${path}: ${errorText(body, res.status)}`, res.status);
  return body as T;
}

/** The API's own description of its routes (Swagger), read once per process. */
let docs: Promise<OpenApiDoc> | null = null;

export interface OpenApiDoc {
  paths: Record<string, Record<string, { summary?: string; tags?: string[]; parameters?: { name: string; in: string; required?: boolean; description?: string }[]; requestBody?: unknown }>>;
  components?: { schemas?: Record<string, unknown> };
}

export function storeDocs(): Promise<OpenApiDoc> {
  const api = storeApiUrl();
  if (!api) return Promise.reject(new StoreError("paribelle.in isn't connected on this server."));
  docs ??= fetch(docsUrl(api), { signal: AbortSignal.timeout(20_000) })
    .then(async (res) => {
      if (!res.ok) throw new StoreError(`The API's route list isn't available (${res.status}).`);
      return (await res.json()) as OpenApiDoc;
    })
    .catch((err) => {
      docs = null;
      throw err;
    });
  return docs;
}
