import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { seelieSettings, type User } from "@/db/schema";

import { seal, unseal, type Sealed } from "./sealed";

/**
 * Instagram, through the Instagram API with Instagram Login (graph.instagram.com):
 * a professional (business or creator) account's long-lived token, which the owner
 * pastes into Seelie's settings once. It lasts 60 days and is refreshed whenever it's
 * used or the settings are opened and it's over a week old, so it never runs out while
 * Seelie is in use. The token is kept sealed (sealed.ts), never shown again.
 *
 * Publishing a reel: Instagram fetches the video itself from a signed, hour-long link
 * to the OMS (media/public.ts), so the OMS must be reachable from the internet.
 */

const SETTINGS_KEY = "instagram";
const API = "https://graph.instagram.com/v23.0";
const REFRESH_AFTER_MS = 7 * 86_400_000;

interface StoredInstagram {
  token: Sealed;
  accountId: string;
  username: string;
  accountType: string | null;
  /** When the token stops working unless refreshed. */
  expiresAt: string | null;
  refreshedAt: string;
  savedAt: string;
  /** Set when Instagram refused the token: paste a new one. */
  failedAt: string | null;
}

export interface InstagramStatus {
  connected: boolean;
  username: string | null;
  accountType: string | null;
  expiresAt: string | null;
  needsToken: boolean;
  savedAt: string | null;
}

export class InstagramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstagramError";
  }
}

async function read(): Promise<StoredInstagram | null> {
  const [row] = await db.select().from(seelieSettings).where(eq(seelieSettings.key, SETTINGS_KEY)).limit(1);
  return (row?.value as StoredInstagram | undefined) ?? null;
}

async function write(value: StoredInstagram, userId: number | null) {
  await db
    .insert(seelieSettings)
    .values({ key: SETTINGS_KEY, value, updatedBy: userId, updatedAt: new Date() })
    .onConflictDoUpdate({ target: seelieSettings.key, set: { value, updatedBy: userId, updatedAt: new Date() } });
}

type GraphError = { error?: { message?: string; code?: number; error_subcode?: number; error_user_msg?: string } };

/** One Graph call. The token goes in the query, as the API takes it; it's never logged. */
async function graph<T>(method: "GET" | "POST", path: string, params: Record<string, string>, token: string, signal?: AbortSignal): Promise<T> {
  const url = new URL(path.startsWith("https://") ? path : `${API}${path}`);
  const body = new URLSearchParams({ ...params, access_token: token });
  if (method === "GET") url.search = body.toString();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      body: method === "POST" ? body : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
      cache: "no-store",
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new InstagramError(`Instagram can't be reached (${err instanceof Error ? err.message : String(err)}).`);
  }
  const json = (await res.json().catch(() => null)) as (T & GraphError) | null;
  if (!res.ok || !json || json.error) {
    const e = json?.error;
    const expired = e?.code === 190;
    throw Object.assign(new InstagramError(expired ? "Instagram's token has expired or was revoked: paste a new one in Seelie's settings." : `Instagram: ${e?.error_user_msg ?? e?.message ?? `HTTP ${res.status}`}`), { expired });
  }
  return json;
}

function status(saved: StoredInstagram | null): InstagramStatus {
  return {
    connected: !!saved && !saved.failedAt,
    username: saved?.username ?? null,
    accountType: saved?.accountType ?? null,
    expiresAt: saved?.expiresAt ?? null,
    needsToken: !!saved?.failedAt,
    savedAt: saved?.savedAt ?? null,
  };
}

/** The settings panel's view; refreshes a week-old token on the way. */
export async function instagramStatus(): Promise<InstagramStatus> {
  const saved = await read();
  if (saved && !saved.failedAt) await token(saved).catch(() => {});
  return status(await read());
}

/** The owner pastes a long-lived token; it's checked with Instagram before it's kept. */
export async function connectInstagram(user: User, raw: string): Promise<InstagramStatus> {
  const plain = raw.trim();
  if (!/^[A-Za-z0-9_|.-]{40,}$/.test(plain)) throw new InstagramError("That doesn't look like an Instagram access token.");
  const me = await graph<{ user_id?: string; id?: string; username: string; account_type?: string }>("GET", "/me", { fields: "user_id,username,account_type" }, plain);
  const accountId = me.user_id ?? me.id;
  if (!accountId) throw new InstagramError("Instagram didn't say which account the token is for.");
  if (me.account_type && !["BUSINESS", "MEDIA_CREATOR"].includes(me.account_type)) {
    throw new InstagramError(`@${me.username} is a personal account; publishing needs a business or creator account.`);
  }
  const now = new Date().toISOString();
  await write({ token: seal(plain, "instagram"), accountId, username: me.username, accountType: me.account_type ?? null, expiresAt: null, refreshedAt: now, savedAt: now, failedAt: null }, user.id);
  // A brand-new token can't be refreshed for a day; the expiry is learned at the first refresh.
  return status(await read());
}

export async function disconnectInstagram() {
  await db.delete(seelieSettings).where(eq(seelieSettings.key, SETTINGS_KEY));
}

/** The working token, refreshed when it's over a week old. */
async function token(saved: StoredInstagram): Promise<string> {
  if (saved.failedAt) throw new InstagramError("Instagram's token stopped working: the owner pastes a new one in Seelie's settings.");
  let plain: string;
  try {
    plain = unseal(saved.token, "instagram");
  } catch {
    throw new InstagramError("The saved Instagram token can't be read (AUTH_SECRET changed): paste it again in Seelie's settings.");
  }
  if (Date.now() - Date.parse(saved.refreshedAt) < REFRESH_AFTER_MS) return plain;
  try {
    const r = await graph<{ access_token: string; expires_in?: number }>("GET", "https://graph.instagram.com/refresh_access_token", { grant_type: "ig_refresh_token" }, plain);
    const now = new Date();
    await write({ ...saved, token: seal(r.access_token, "instagram"), refreshedAt: now.toISOString(), expiresAt: r.expires_in ? new Date(now.getTime() + r.expires_in * 1000).toISOString() : saved.expiresAt }, null);
    return r.access_token;
  } catch (err) {
    if ((err as { expired?: boolean }).expired) {
      await write({ ...saved, failedAt: new Date().toISOString() }, null);
      throw err;
    }
    // Refresh refused for another reason (too young): the old token still works.
    return plain;
  }
}

export async function instagramReady() {
  const saved = await read();
  return !!saved && !saved.failedAt;
}

/**
 * Posts a reel from a public video URL: make the container, wait for Instagram to
 * fetch and process the video, publish, then read its link.
 */
export async function publishReel(input: {
  videoUrl: string;
  caption: string;
  shareToFeed: boolean;
  coverAtMs?: number;
  signal: AbortSignal;
  progress: (text: string) => void;
}): Promise<{ mediaId: string; permalink: string | null; username: string }> {
  const saved = await read();
  if (!saved) throw new InstagramError("Instagram isn't connected: the owner adds the account's token in Seelie's settings.");
  const access = await token(saved);
  const fail = async (err: unknown): Promise<never> => {
    if ((err as { expired?: boolean }).expired) await write({ ...saved, failedAt: new Date().toISOString() }, null);
    throw err;
  };

  input.progress("Sending the video to Instagram…");
  const container = await graph<{ id: string }>(
    "POST",
    `/${saved.accountId}/media`,
    {
      media_type: "REELS",
      video_url: input.videoUrl,
      caption: input.caption,
      share_to_feed: String(input.shareToFeed),
      ...(input.coverAtMs !== undefined ? { thumb_offset: String(Math.round(input.coverAtMs)) } : {}),
    },
    access,
    input.signal,
  ).catch(fail);

  const started = Date.now();
  for (;;) {
    const s = await graph<{ status_code: string; status?: string }>("GET", `/${container.id}`, { fields: "status_code,status" }, access, input.signal).catch(fail);
    if (s.status_code === "FINISHED") break;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new InstagramError(`Instagram couldn't take the video: ${s.status ?? s.status_code}`);
    if (Date.now() - started > 10 * 60_000) throw new InstagramError("Instagram is still processing the video after 10 minutes; nothing was posted.");
    input.progress(`Instagram is processing the video (${Math.round((Date.now() - started) / 1000)} s)…`);
    await new Promise((ok) => setTimeout(ok, 5000));
    if (input.signal.aborted) throw new InstagramError("Stopped before posting.");
  }

  input.progress("Publishing…");
  const media = await graph<{ id: string }>("POST", `/${saved.accountId}/media_publish`, { creation_id: container.id }, access, input.signal).catch(fail);
  const info = await graph<{ permalink?: string }>("GET", `/${media.id}`, { fields: "permalink" }, access).catch(() => ({ permalink: undefined }));
  return { mediaId: media.id, permalink: info.permalink ?? null, username: saved.username };
}
