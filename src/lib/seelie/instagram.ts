import "server-only";

import { MetaError, metaCall, metaContext, type MetaContext } from "./meta";

/**
 * Instagram, through the Instagram API with Facebook Login: the professional account
 * linked to the shop's Facebook Page, reached with the Meta system-user token (meta.ts).
 *
 * Posting: Instagram fetches each photo and video itself from a signed, short-lived link
 * to the OMS (media/public.ts), so the OMS must be reachable from the internet. A post is
 * a container that Instagram processes, then publishes; a carousel is one container per
 * item and a parent holding them.
 */

export class InstagramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstagramError";
  }
}

export interface InstagramContext extends MetaContext {
  instagram: { id: string; username: string };
}

/** The Meta connection with an Instagram account on its Page, or a plain reason why not. */
export async function instagramContext(): Promise<InstagramContext> {
  const ctx = await metaContext().catch((err: unknown) => {
    throw new InstagramError(err instanceof Error ? err.message : String(err));
  });
  if (!ctx.page) throw new InstagramError("No Facebook Page is chosen in Seelie's settings (the Meta panel).");
  if (!ctx.instagram) {
    throw new InstagramError(`The Page "${ctx.page.name}" has no Instagram professional account linked (Page settings → Linked accounts), or the token can't see it.`);
  }
  return ctx as InstagramContext;
}

async function call<T>(ctx: MetaContext, method: "GET" | "POST", path: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  try {
    return await metaCall<T>(ctx, method, path, params, { signal });
  } catch (err) {
    if (err instanceof MetaError) throw new InstagramError(err.message.replace(/^Meta: /, "Instagram: "));
    throw err;
  }
}

export type PostType = "reel" | "photo" | "carousel" | "story";
export type PostItem = { kind: "image" | "video"; url: string };

export interface PostInput {
  type: PostType;
  items: PostItem[];
  caption: string;
  altText?: string;
  collaborators?: string[];
  shareToFeed?: boolean;
  coverAtMs?: number;
  /** Meta's AI label: made or changed by AI in a way that looks real. */
  aiGenerated?: boolean;
  signal: AbortSignal;
  progress: (text: string) => void;
}

/** Wait for Instagram to fetch and process a container. */
async function ready(ctx: InstagramContext, id: string, what: string, input: Pick<PostInput, "signal" | "progress">) {
  const started = Date.now();
  for (;;) {
    const s = await call<{ status_code?: string; status?: string }>(ctx, "GET", `/${id}`, { fields: "status_code,status" }, input.signal);
    if (s.status_code === "FINISHED" || s.status_code === "PUBLISHED") return;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new InstagramError(`Instagram couldn't take ${what}: ${s.status ?? s.status_code}`);
    if (Date.now() - started > 10 * 60_000) throw new InstagramError(`Instagram is still processing ${what} after 10 minutes; nothing was posted.`);
    if (input.signal.aborted) throw new InstagramError("Stopped before posting.");
    input.progress(`Instagram is processing ${what} (${Math.round((Date.now() - started) / 1000)} s)…`);
    await new Promise((ok) => setTimeout(ok, 4000));
  }
}

/** How many posts the account may still publish through the API today (Instagram allows 100 in 24 hours). */
export async function publishingRoom(ctx: InstagramContext, signal?: AbortSignal): Promise<{ used: number; total: number } | null> {
  try {
    const r = await call<{ data?: { quota_usage?: number; config?: { quota_total?: number } }[] }>(
      ctx,
      "GET",
      `/${ctx.instagram.id}/content_publishing_limit`,
      { fields: "quota_usage,config" },
      signal,
    );
    const row = r.data?.[0];
    return row ? { used: row.quota_usage ?? 0, total: row.config?.quota_total ?? 100 } : null;
  } catch {
    return null;
  }
}

/** Post to Instagram: make the container(s), wait for processing, publish, read its link. */
export async function publishPost(input: PostInput): Promise<{ mediaId: string; permalink: string | null; username: string }> {
  const ctx = await instagramContext();
  const ig = ctx.instagram.id;
  const room = await publishingRoom(ctx, input.signal);
  if (room && room.used >= room.total) throw new InstagramError(`The account has used all ${room.total} API posts allowed in 24 hours; try later.`);

  const shared = {
    ...(input.collaborators?.length ? { collaborators: input.collaborators } : {}),
    ...(input.aiGenerated ? { is_ai_generated: true } : {}),
  };
  let container: string;

  if (input.type === "carousel") {
    const children: string[] = [];
    for (const [i, item] of input.items.entries()) {
      input.progress(`Sending item ${i + 1} of ${input.items.length} to Instagram…`);
      const child = await call<{ id: string }>(
        ctx,
        "POST",
        `/${ig}/media`,
        item.kind === "image" ? { image_url: item.url, is_carousel_item: true } : { media_type: "VIDEO", video_url: item.url, is_carousel_item: true },
        input.signal,
      );
      children.push(child.id);
    }
    for (const [i, id] of children.entries()) await ready(ctx, id, `item ${i + 1}`, input);
    input.progress("Putting the carousel together…");
    container = (
      await call<{ id: string }>(ctx, "POST", `/${ig}/media`, { media_type: "CAROUSEL", children: children.join(","), caption: input.caption, ...shared }, input.signal)
    ).id;
  } else {
    const item = input.items[0];
    input.progress(`Sending the ${item.kind === "image" ? "photo" : "video"} to Instagram…`);
    const params: Record<string, unknown> =
      input.type === "story"
        ? { media_type: "STORIES", ...(item.kind === "image" ? { image_url: item.url } : { video_url: item.url }) }
        : input.type === "reel"
          ? {
              media_type: "REELS",
              video_url: item.url,
              caption: input.caption,
              share_to_feed: input.shareToFeed ?? true,
              ...(input.coverAtMs !== undefined ? { thumb_offset: Math.round(input.coverAtMs) } : {}),
              ...shared,
            }
          : { image_url: item.url, caption: input.caption, ...(input.altText ? { alt_text: input.altText } : {}), ...shared };
    container = (await call<{ id: string }>(ctx, "POST", `/${ig}/media`, params, input.signal)).id;
  }

  await ready(ctx, container, input.type === "carousel" ? "the carousel" : `the ${input.type}`, input);
  input.progress("Publishing…");
  const media = await call<{ id: string }>(ctx, "POST", `/${ig}/media_publish`, { creation_id: container }, input.signal);
  const info = await call<{ permalink?: string }>(ctx, "GET", `/${media.id}`, { fields: "permalink" }).catch(() => ({ permalink: undefined }));
  return { mediaId: media.id, permalink: info.permalink ?? null, username: ctx.instagram.username };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

type Insight = { name: string; values?: { value: number }[]; total_value?: { value: number } };

const valueOf = (i: Insight) => i.total_value?.value ?? i.values?.at(-1)?.value ?? null;

export async function accountInfo(ctx: InstagramContext, days: number, signal?: AbortSignal) {
  const profile = await call<Record<string, unknown>>(
    ctx,
    "GET",
    `/${ctx.instagram.id}`,
    { fields: "username,name,biography,website,followers_count,follows_count,media_count" },
    signal,
  );
  const until = Math.floor(Date.now() / 1000);
  const since = until - Math.min(30, Math.max(1, days)) * 86_400;
  const insights = await call<{ data?: Insight[] }>(
    ctx,
    "GET",
    `/${ctx.instagram.id}/insights`,
    { metric: "reach,views,accounts_engaged,total_interactions,profile_links_taps", period: "day", metric_type: "total_value", since, until },
    signal,
  )
    .then((r) => Object.fromEntries((r.data ?? []).map((i) => [i.name, valueOf(i)])))
    .catch((err: unknown) => ({ unavailable: err instanceof Error ? err.message : String(err) }));
  return { profile, [`last${Math.min(30, Math.max(1, days))}Days`]: insights, publishing: await publishingRoom(ctx, signal) };
}

const MEDIA_FIELDS = "id,media_type,media_product_type,caption,permalink,timestamp,like_count,comments_count,thumbnail_url,media_url";

export async function recentMedia(ctx: InstagramContext, limit: number, withInsights: boolean, signal?: AbortSignal) {
  const r = await call<{ data?: Record<string, unknown>[] }>(ctx, "GET", `/${ctx.instagram.id}/media`, { fields: MEDIA_FIELDS, limit: Math.min(50, limit) }, signal);
  const media = r.data ?? [];
  if (!withInsights) return media.map(trimMedia);
  return Promise.all(media.map(async (m) => ({ ...trimMedia(m), insights: await mediaInsights(ctx, String(m.id), String(m.media_product_type ?? ""), signal) })));
}

function trimMedia(m: Record<string, unknown>) {
  const caption = typeof m.caption === "string" ? m.caption : "";
  return {
    id: m.id,
    type: m.media_product_type === "REELS" ? "reel" : m.media_type === "CAROUSEL_ALBUM" ? "carousel" : m.media_product_type === "STORY" ? "story" : String(m.media_type ?? "").toLowerCase(),
    at: m.timestamp,
    link: m.permalink,
    likes: m.like_count,
    comments: m.comments_count,
    caption: caption.length > 300 ? `${caption.slice(0, 297)}…` : caption,
  };
}

export async function mediaInsights(ctx: InstagramContext, mediaId: string, productType: string, signal?: AbortSignal) {
  const metric = productType === "STORY" ? "reach,views,replies,shares,total_interactions" : "reach,views,saved,shares,total_interactions";
  return call<{ data?: Insight[] }>(ctx, "GET", `/${mediaId}/insights`, { metric }, signal)
    .then((r) => Object.fromEntries((r.data ?? []).map((i) => [i.name, valueOf(i)])))
    .catch((err: unknown) => ({ unavailable: err instanceof Error ? err.message : String(err) }));
}

export async function mediaOne(ctx: InstagramContext, mediaId: string, signal?: AbortSignal) {
  const m = await call<Record<string, unknown>>(ctx, "GET", `/${mediaId}`, { fields: MEDIA_FIELDS }, signal);
  return { ...trimMedia(m), insights: await mediaInsights(ctx, mediaId, String(m.media_product_type ?? ""), signal) };
}

export async function mediaComments(ctx: InstagramContext, mediaId: string, limit: number, signal?: AbortSignal) {
  const r = await call<{ data?: { id: string; text?: string; username?: string; timestamp?: string; like_count?: number }[] }>(
    ctx,
    "GET",
    `/${mediaId}/comments`,
    { fields: "id,text,username,timestamp,like_count", limit: Math.min(50, limit) },
    signal,
  );
  return (r.data ?? []).map((c) => ({ by: c.username, at: c.timestamp, text: c.text, likes: c.like_count }));
}
