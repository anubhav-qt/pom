import "server-only";

import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { reelTracks, seelieAssets, seelieMessages } from "@/db/schema";
import { withBasePath } from "@/lib/base-path";

import { adsCall, adsContext, capRoom, fromMinor, type CapRoom } from "./ads";
import { metaContext } from "./meta";
import { getVideo, versionOf, videoLinks } from "./media/library";
import { imageBudget } from "./studio/budget";
import { getGarment, getShoot, type ShootLook } from "./studio/shoots";
import type { AdRoom, ApprovalCard, CardMedia } from "./types";

/**
 * What an approval card shows, by what's asked: for a post, the reel or pictures as they'll
 * go up with the caption and account; for an ad, the creative, budget, length, audience and
 * what's left under the monthly cap; for a photoshoot, the product, each look and the image
 * budget. Read when the card is drawn, so it's current; the call's own arguments stay one
 * tap below it. Anything that can't be read (Meta not connected) is left out, never fatal.
 */

type Args = Record<string, unknown>;
const record = (v: unknown): Args => (v && typeof v === "object" && !Array.isArray(v) ? (v as Args) : {});
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/* -------------------------------------------------------------------------- */
/* Media                                                                      */
/* -------------------------------------------------------------------------- */

/** Where the screen shows a chat image from: the n-th picture sent in the chat (chat:<n>). */
async function chatImage(chatId: string, n: number): Promise<string | null> {
  const rows = await db
    .select({ seq: seelieMessages.seq, message: seelieMessages.message })
    .from(seelieMessages)
    .where(and(eq(seelieMessages.chatId, chatId), eq(seelieMessages.role, "user")))
    .orderBy(asc(seelieMessages.seq));
  let seen = 0;
  for (const row of rows) {
    const content = (row.message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const [index, block] of content.entries()) {
      if ((block as { type?: string }).type !== "image") continue;
      if (++seen === n) return withBasePath(`/api/seelie/chats/${chatId}/images/${row.seq}/${index}`);
    }
  }
  return null;
}

/** A ref (video:12@3, asset:5, chat:2) as the card shows it. */
export async function refMedia(chatId: string, ref: string): Promise<CardMedia> {
  const r = ref.trim();
  try {
    const video = /^video:(\d+)(?:@(\d+))?$/.exec(r);
    if (video) {
      const row = await getVideo(Number(video[1]));
      if (row && row.version > 0) {
        const v = versionOf(row, video[2] ? Number(video[2]) : undefined);
        const links = videoLinks(row.id, v.version);
        return { ref: r, kind: "video", src: v.pruned ? null : links.video, poster: v.pruned ? null : links.poster, seconds: v.seconds };
      }
      return { ref: r, kind: "video", src: null };
    }
    const asset = /^asset:(\d+)$/.exec(r);
    if (asset) {
      const [row] = await db.select({ id: seelieAssets.id, kind: seelieAssets.kind, duration: seelieAssets.duration }).from(seelieAssets).where(eq(seelieAssets.id, Number(asset[1]))).limit(1);
      if (!row) return { ref: r, kind: "image", src: null };
      return row.kind === "video"
        ? { ref: r, kind: "video", src: withBasePath(`/api/seelie/assets/${row.id}`), seconds: row.duration ?? undefined }
        : { ref: r, kind: "image", src: withBasePath(`/api/seelie/assets/${row.id}?w=480`) };
    }
    const chat = /^chat:(\d+)$/.exec(r);
    if (chat) return { ref: r, kind: "image", src: await chatImage(chatId, Number(chat[1])) };
  } catch {
    // A ref that can't be read shows as a blank tile with its name.
  }
  return { ref: r, kind: "image", src: null };
}

/** The library song inside a video, which Instagram may mute. */
async function songOf(ref: string): Promise<string | null> {
  const m = /^video:(\d+)(?:@(\d+))?$/.exec(ref.trim());
  if (!m) return null;
  const row = await getVideo(Number(m[1])).catch(() => null);
  if (!row || row.version === 0) return null;
  const song = versionOf(row, m[2] ? Number(m[2]) : undefined).song;
  if (!song) return null;
  const [track] = await db.select({ title: reelTracks.title, artist: reelTracks.artist }).from(reelTracks).where(eq(reelTracks.id, song)).limit(1);
  return track ? `${track.title} · ${track.artist}` : null;
}

/* -------------------------------------------------------------------------- */
/* Ads                                                                        */
/* -------------------------------------------------------------------------- */

/** What's left under the monthly cap, read at most once a minute (five Graph calls). */
let roomCache: { at: number; room: CapRoom | null } | null = null;

async function room(): Promise<CapRoom | null> {
  if (roomCache && Date.now() - roomCache.at < 60_000) return roomCache.room;
  const ctx = await adsContext().catch(() => null);
  const out = ctx ? await capRoom(ctx).catch(() => null) : null;
  roomCache = { at: Date.now(), room: out };
  return out;
}

const adRoom = (r: CapRoom | null): AdRoom | null =>
  r ? { cap: r.cap, spentThisMonth: r.spentThisMonth, committed: r.committedTotal, room: r.room } : null;

function audienceLine(a: Args): string {
  const aud = record(a.audience);
  const names = (v: unknown) =>
    Array.isArray(v)
      ? v
          .map((x) => str(record(x).name) ?? str(record(x).key))
          .filter(Boolean)
          .join(", ")
      : "";
  const where = names(aud.cities) || names(aud.regions) || (Array.isArray(aud.countries) && aud.countries.length ? (aud.countries as string[]).join(", ") : "India");
  const ages = aud.ageMin || aud.ageMax ? `${num(aud.ageMin) ?? 18}-${num(aud.ageMax) ?? "65+"}` : null;
  const who = aud.genders === "women" || aud.genders === "men" ? aud.genders : null;
  const interests = names(aud.interests);
  return [where, [who, ages].filter(Boolean).join(" ") || null, interests ? `into ${interests}` : null].filter(Boolean).join(" · ");
}

const OBJECTIVE: Record<string, string> = {
  traffic: "Visits to the shop",
  engagement: "Likes, comments and saves",
  video_views: "Video views",
  reach: "Reach as many people as possible",
};

/* -------------------------------------------------------------------------- */
/* Cards                                                                      */
/* -------------------------------------------------------------------------- */

/** The card for a call that asks (or asked), by what it does; null for anything else. */
export async function approvalCard(chatId: string, tool: string, rawArgs: unknown): Promise<ApprovalCard | null> {
  const a = record(rawArgs);
  switch (tool) {
    case "instagram_post": {
      const refs = Array.isArray(a.media) ? (a.media as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const [items, ctx, songs] = await Promise.all([
        Promise.all(refs.map((r) => refMedia(chatId, r))),
        metaContext().catch(() => null),
        Promise.all(refs.map((r) => songOf(r).catch(() => null))),
      ]);
      const post = (["reel", "photo", "carousel", "story"] as const).find((t) => t === a.type) ?? "photo";
      const generated = await Promise.all(
        refs.map(async (r) => {
          const m = /^asset:(\d+)$/.exec(r);
          if (!m) return false;
          const [row] = await db.select({ source: seelieAssets.source }).from(seelieAssets).where(eq(seelieAssets.id, Number(m[1]))).limit(1);
          return row?.source === "photoshoot" || row?.source === "generated";
        }),
      );
      return {
        type: "post",
        post,
        account: ctx?.instagram ? `@${ctx.instagram.username}` : null,
        items,
        caption: str(a.caption) ?? "",
        collaborators: Array.isArray(a.collaborators) ? (a.collaborators as string[]).map((c) => `@${String(c).replace(/^@/, "")}`) : [],
        shareToFeed: a.shareToFeed !== false,
        aiLabel: a.aiGenerated === true || (a.aiGenerated === undefined && generated.some(Boolean)),
        song: songs.find(Boolean) ?? null,
      };
    }

    case "ads_create": {
      const media = str(a.media);
      const [r, creative] = await Promise.all([room(), media ? refMedia(chatId, media) : Promise.resolve(null)]);
      return {
        type: "ad",
        name: str(a.name) ?? "Ad",
        objective: OBJECTIVE[String(a.objective)] ?? String(a.objective ?? ""),
        creative,
        post: str(a.post),
        text: str(a.text),
        headline: str(a.headline),
        link: str(a.link),
        budget: num(a.budget) ?? 0,
        currency: r?.currency ?? "INR",
        days: num(a.days),
        until: str(a.end),
        audience: audienceLine(a),
        placements: a.placements === "automatic" ? "Facebook and Instagram" : "Instagram (feed, stories, reels)",
        room: adRoom(r),
        balance: r?.prepaid?.balance ?? null,
      };
    }

    case "ads_manage": {
      const action = a.action;
      if (action !== "resume" && action !== "raise_budget" && action !== "extend" && action !== "archive") return null;
      const level = a.level === "adset" ? "ad set" : String(a.level ?? "ad");
      const id = str(a.id) ?? "?";
      const [r, ctx] = await Promise.all([room(), adsContext().catch(() => null)]);
      const meta = ctx
        ? await adsCall<{ name?: string; daily_budget?: string; lifetime_budget?: string }>(ctx, "GET", `/${id}`, { fields: a.level === "ad" ? "name" : "name,daily_budget,lifetime_budget" }).catch(
            () => null,
          )
        : null;
      const currency = r?.currency ?? ctx?.adAccount.currency ?? "INR";
      const was = meta ? Number(meta.lifetime_budget ?? 0) || Number(meta.daily_budget ?? 0) : 0;
      return {
        type: "ad-change",
        action,
        what: meta?.name ? `${meta.name} (${level})` : `${level} ${id}`,
        was: was > 0 ? fromMinor(was, currency) : null,
        budget: num(a.budget),
        end: str(a.end),
        currency,
        room: adRoom(r),
        balance: r?.prepaid?.balance ?? null,
      };
    }

    case "photoshoot": {
      if (a.action !== "shoot") return null;
      const s = num(a.shoot) ? await getShoot(num(a.shoot)!) : null;
      if (!s) return null;
      const ids = Array.isArray(a.lookIds) ? (a.lookIds as string[]) : [];
      const looks = ids.length ? s.looks.filter((l) => ids.includes(l.id)) : s.looks.filter((l) => l.status === "planned" || l.status === "waiting" || l.status === "failed");
      const [garment, budget] = await Promise.all([s.garmentKey ? getGarment(s.garmentKey) : null, imageBudget().catch(() => null)]);
      const photo = garment?.photos.find((p) => /\bfront\b/i.test(p.view)) ?? garment?.photos[0];
      return {
        type: "shoot",
        title: s.title,
        product: photo ? await refMedia(chatId, photo.ref) : null,
        looks: looks.map((l) => ({ id: l.id, line: lookWords(l, str(a.size)) })),
        images: looks.length,
        left: budget ? budget.left : null,
        capacity: budget ? budget.capacity : null,
        comesBack: budget?.blockedUntil ?? (budget && budget.left < looks.length ? budget.resetAt : null),
        blocked: !!budget?.blockedUntil,
      };
    }

    default:
      return null;
  }
}

const KIND_WORDS: Record<string, string> = {
  "on-model": "On a model",
  "flat-lay": "Flat lay",
  ghost: "Ghost mannequin",
  detail: "Close-up",
  recast: "Recast",
};

/** A look in everyday words: "On a model · full length, garden, golden light · 3:4". */
function lookWords(l: ShootLook, size: string | null) {
  const b = l.brief as ShootLook["brief"] & Record<string, unknown>;
  const bits = [b.framing, b.fullLength ? "full length" : null, b.angle, b.pose, b.setting, b.light, b.detail]
    .map((x) => (typeof x === "string" ? x.trim() : x))
    .filter((x): x is string => typeof x === "string" && x.length > 0)
    .slice(0, 4);
  return [KIND_WORDS[b.kind] ?? b.kind, bits.join(", ") || null, `${b.aspect ?? "3:4"}${(size ?? b.size) === "4K" ? " · 4K" : ""}`].filter(Boolean).join(" · ");
}
