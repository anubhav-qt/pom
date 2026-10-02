import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { seelieSettings, type User } from "@/db/schema";

import { seal, unseal, type Sealed } from "./sealed";

/**
 * Meta: Instagram posts, ads and their numbers, through one system-user token from the
 * shop's Business portfolio (Business Settings → Users → System users → Generate token),
 * which doesn't expire. The owner pastes it once in Seelie's settings; it is kept sealed
 * (sealed.ts), never shown again. With it Seelie finds the Facebook Page, the Instagram
 * account linked to it and the ad accounts the system user was given, and the owner
 * picks which to use when there is more than one.
 *
 * Ads spend real money, so the owner also sets a monthly cap here: every ad Seelie starts
 * must fit under it (ads.ts), and nothing starts without one.
 */

const SETTINGS_KEY = "meta";
export const GRAPH = "https://graph.facebook.com/v25.0";

/** What posting and ads need the token to carry. */
export const NEEDED_PERMISSIONS = [
  "business_management",
  "pages_show_list",
  "pages_read_engagement",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_insights",
  "ads_management",
  "ads_read",
] as const;

export interface MetaPage {
  id: string;
  name: string;
  instagram: { id: string; username: string } | null;
}

export interface MetaAdAccount {
  /** act_<id> */
  id: string;
  name: string;
  currency: string;
  timezone: string;
  /** 1 active, 2 disabled, 3 unsettled, 7 pending review, 9 in grace period, 101 closed… */
  status: number;
}

interface StoredMeta {
  token: Sealed;
  systemUser: { id: string; name: string };
  permissions: string[];
  pages: MetaPage[];
  adAccounts: MetaAdAccount[];
  pageId: string | null;
  adAccountId: string | null;
  /** The most ads may spend in a calendar month (in the ad account's timezone), in its currency. */
  monthlyCap: number | null;
  savedAt: string;
  checkedAt: string;
  /** Set when Meta refused the token: paste a new one. */
  failedAt: string | null;
}

export interface MetaStatus {
  connected: boolean;
  needsToken: boolean;
  systemUser: string | null;
  missingPermissions: string[];
  pages: MetaPage[];
  page: MetaPage | null;
  adAccounts: MetaAdAccount[];
  adAccount: MetaAdAccount | null;
  monthlyCap: number | null;
  checkedAt: string | null;
}

export class MetaError extends Error {
  constructor(
    message: string,
    readonly expired = false,
    readonly code: number | null = null,
  ) {
    super(message);
    this.name = "MetaError";
  }
}

async function read(): Promise<StoredMeta | null> {
  const [row] = await db.select().from(seelieSettings).where(eq(seelieSettings.key, SETTINGS_KEY)).limit(1);
  return (row?.value as StoredMeta | undefined) ?? null;
}

async function write(value: StoredMeta, userId: number | null) {
  await db
    .insert(seelieSettings)
    .values({ key: SETTINGS_KEY, value, updatedBy: userId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: seelieSettings.key, set: { value, updatedBy: userId, updatedAt: new Date() } });
}

type GraphError = {
  error?: { message?: string; code?: number; error_subcode?: number; error_user_title?: string; error_user_msg?: string; fbtrace_id?: string };
};

/** Graph takes objects and lists as JSON strings. */
function encode(params: Record<string, unknown>) {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    out.set(k, typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v));
  }
  return out;
}

/** One Graph call. The token goes in the request, as the API takes it; it's never logged. */
export async function graphCall<T>(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, unknown>,
  token: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const url = new URL(path.startsWith("https://") ? path : `${GRAPH}${path.startsWith("/") ? "" : "/"}${path}`);
  const body = encode({ ...params, access_token: token });
  if (method !== "POST") url.search = body.toString();
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      body: method === "POST" ? body : undefined,
      signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
      cache: "no-store",
    });
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new MetaError(`Meta can't be reached (${err instanceof Error ? err.message : String(err)}).`);
  }
  const json = (await res.json().catch(() => null)) as (T & GraphError) | null;
  if (!res.ok || !json || json.error) {
    const e = json?.error;
    const expired = e?.code === 190;
    const what = e?.error_user_msg ? `${e.error_user_title ? `${e.error_user_title}: ` : ""}${e.error_user_msg}` : (e?.message ?? `HTTP ${res.status}`);
    throw new MetaError(
      expired ? "Meta refused the saved token (expired, revoked or the system user lost access): paste a new one in Seelie's settings." : `Meta: ${what}`,
      expired,
      e?.code ?? null,
    );
  }
  return json;
}

/** Every page of a Graph list, up to `max` items. */
export async function graphList<T>(path: string, params: Record<string, unknown>, token: string, max = 500, signal?: AbortSignal): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = null;
  let first = true;
  while (out.length < max && (first || next)) {
    const page: { data?: T[]; paging?: { next?: string } } = first
      ? await graphCall("GET", path, { limit: 100, ...params }, token, { signal })
      : await graphCall("GET", next!, {}, token, { signal });
    first = false;
    out.push(...(page.data ?? []));
    next = page.paging?.next ?? null;
  }
  return out.slice(0, max);
}

/** What the token can reach: who it is, what it may do, and the Pages, Instagram accounts and ad accounts it was given. */
async function discover(token: string) {
  const me = await graphCall<{ id: string; name?: string }>("GET", "/me", { fields: "id,name" }, token);
  const permissions = await graphList<{ permission: string; status: string }>("/me/permissions", {}, token)
    .then((rows) => rows.filter((r) => r.status === "granted").map((r) => r.permission))
    .catch(() => [] as string[]);
  const pages = await graphList<{ id: string; name: string; instagram_business_account?: { id: string; username?: string } }>(
    "/me/accounts",
    { fields: "id,name,instagram_business_account{id,username}" },
    token,
  ).catch(() => []);
  const adAccounts = await graphList<{ id: string; name?: string; currency?: string; timezone_name?: string; account_status?: number }>(
    "/me/adaccounts",
    { fields: "id,name,currency,timezone_name,account_status" },
    token,
  ).catch(() => []);
  return {
    systemUser: { id: me.id, name: me.name ?? me.id },
    permissions,
    pages: pages.map((p) => ({
      id: p.id,
      name: p.name,
      instagram: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username ?? p.instagram_business_account.id } : null,
    })),
    adAccounts: adAccounts.map((a) => ({
      id: a.id,
      name: a.name ?? a.id,
      currency: a.currency ?? "INR",
      timezone: a.timezone_name ?? "Asia/Kolkata",
      status: a.account_status ?? 0,
    })),
  };
}

function status(saved: StoredMeta | null): MetaStatus {
  if (!saved) {
    return { connected: false, needsToken: false, systemUser: null, missingPermissions: [], pages: [], page: null, adAccounts: [], adAccount: null, monthlyCap: null, checkedAt: null };
  }
  return {
    connected: !saved.failedAt,
    needsToken: !!saved.failedAt,
    systemUser: saved.systemUser.name,
    // Only when Meta listed them: a token that can't list its permissions isn't held to them here.
    missingPermissions: saved.permissions.length ? NEEDED_PERMISSIONS.filter((p) => !saved.permissions.includes(p)) : [],
    pages: saved.pages,
    page: saved.pages.find((p) => p.id === saved.pageId) ?? null,
    adAccounts: saved.adAccounts,
    adAccount: saved.adAccounts.find((a) => a.id === saved.adAccountId) ?? null,
    monthlyCap: saved.monthlyCap,
    checkedAt: saved.checkedAt,
  };
}

/** The Page to use: the one chosen, else the only one with Instagram linked, else the only one. */
function pickPage(pages: MetaPage[], current: string | null) {
  if (current && pages.some((p) => p.id === current)) return current;
  const withInstagram = pages.filter((p) => p.instagram);
  if (withInstagram.length === 1) return withInstagram[0].id;
  return pages.length === 1 ? pages[0].id : null;
}

function pickAdAccount(accounts: MetaAdAccount[], current: string | null) {
  if (current && accounts.some((a) => a.id === current)) return current;
  const active = accounts.filter((a) => a.status === 1);
  if (active.length === 1) return active[0].id;
  return accounts.length === 1 ? accounts[0].id : null;
}

export async function metaStatus(): Promise<MetaStatus> {
  return status(await read());
}

/** The owner pastes a system-user token; it's checked with Meta before it's kept. */
export async function connectMeta(user: User, raw: string): Promise<MetaStatus> {
  const plain = raw.trim();
  if (!/^[A-Za-z0-9_|.-]{40,}$/.test(plain)) throw new MetaError("That doesn't look like a Meta access token.");
  const found = await discover(plain);
  const before = await read();
  const now = new Date().toISOString();
  await write(
    {
      token: seal(plain, "meta"),
      ...found,
      pageId: pickPage(found.pages, before?.pageId ?? null),
      adAccountId: pickAdAccount(found.adAccounts, before?.adAccountId ?? null),
      monthlyCap: before?.monthlyCap ?? null,
      savedAt: now,
      checkedAt: now,
      failedAt: null,
    },
    user.id,
  );
  return status(await read());
}

/** Look again for Pages and ad accounts (after one is added in Business Settings). */
export async function refreshMeta(user: User | null): Promise<MetaStatus> {
  const saved = await read();
  if (!saved) return status(null);
  try {
    const found = await discover(unsealToken(saved));
    await write(
      {
        ...saved,
        ...found,
        pageId: pickPage(found.pages, saved.pageId),
        adAccountId: pickAdAccount(found.adAccounts, saved.adAccountId),
        checkedAt: new Date().toISOString(),
        failedAt: null,
      },
      user?.id ?? null,
    );
  } catch (err) {
    if (err instanceof MetaError && err.expired) await write({ ...saved, failedAt: new Date().toISOString() }, user?.id ?? null);
    throw err;
  }
  return status(await read());
}

/** The owner's choices: which Page, which ad account, and the monthly cap (null: no ads). */
export async function chooseMeta(user: User, input: { pageId?: string; adAccountId?: string; monthlyCap?: number | null }): Promise<MetaStatus> {
  const saved = await read();
  if (!saved) throw new MetaError("Meta isn't connected.");
  const next = { ...saved };
  if (input.pageId !== undefined) {
    if (!saved.pages.some((p) => p.id === input.pageId)) throw new MetaError("The token can't reach that Page.");
    next.pageId = input.pageId;
  }
  if (input.adAccountId !== undefined) {
    if (!saved.adAccounts.some((a) => a.id === input.adAccountId)) throw new MetaError("The token can't reach that ad account.");
    next.adAccountId = input.adAccountId;
  }
  if (input.monthlyCap !== undefined) {
    if (input.monthlyCap !== null && (!Number.isFinite(input.monthlyCap) || input.monthlyCap < 0 || input.monthlyCap > 10_000_000)) {
      throw new MetaError("The monthly cap must be a sum of money (0 to stop all ads).");
    }
    next.monthlyCap = input.monthlyCap === null ? null : Math.round(input.monthlyCap);
  }
  await write(next, user.id);
  return status(await read());
}

export async function disconnectMeta() {
  await db.delete(seelieSettings).where(eq(seelieSettings.key, SETTINGS_KEY));
}

function unsealToken(saved: StoredMeta) {
  try {
    return unseal(saved.token, "meta");
  } catch {
    throw new MetaError("The saved Meta token can't be read (AUTH_SECRET changed): paste it again in Seelie's settings.");
  }
}

/** What the Instagram and ad tools work with. */
export interface MetaContext {
  token: string;
  page: MetaPage | null;
  instagram: { id: string; username: string } | null;
  adAccount: MetaAdAccount | null;
  monthlyCap: number | null;
  /** Mark the token refused, so the settings ask for a new one. */
  expired: () => Promise<void>;
}

export async function metaContext(): Promise<MetaContext> {
  const saved = await read();
  if (!saved) throw new MetaError("Meta isn't connected: the owner pastes a system-user token in Seelie's settings (the Meta panel).");
  if (saved.failedAt) throw new MetaError("Meta stopped taking the saved token: the owner pastes a new one in Seelie's settings (the Meta panel).");
  const s = status(saved);
  return {
    token: unsealToken(saved),
    page: s.page,
    instagram: s.page?.instagram ?? null,
    adAccount: s.adAccount,
    monthlyCap: saved.monthlyCap,
    expired: async () => {
      const now = await read();
      if (now) await write({ ...now, failedAt: new Date().toISOString() }, null);
    },
  };
}

/** A Graph call with the saved token that marks it refused when Meta says so. */
export async function metaCall<T>(
  ctx: MetaContext,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, unknown> = {},
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  try {
    return await graphCall<T>(method, path, params, ctx.token, opts);
  } catch (err) {
    if (err instanceof MetaError && err.expired) await ctx.expired();
    throw err;
  }
}

export async function metaReady() {
  const saved = await read();
  return !!saved && !saved.failedAt;
}
