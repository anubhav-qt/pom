import "server-only";

import { Type } from "@paribelle/pi-ai";

import {
  accountInfo,
  InstagramError,
  instagramContext,
  mediaComments,
  mediaOne,
  publishPost,
  recentMedia,
  type PostItem,
  type PostType,
} from "../instagram";
import { addPublished, getVideo, publishedOf, type VideoRow, type VideoVersion } from "../media/library";
import { publicOrigin, publicVideoUrl, stagePublic } from "../media/public";
import { toJpeg } from "./images";
import { imageOf } from "./photo";
import { finalOf, generated } from "./publish";
import { defineTool, ToolError, type ToolContext } from "./types";
import { optional, StringEnum } from "./util";

/**
 * Instagram: posting (reels, photos, carousels, stories; each one asks first) and reading
 * the account, its posts and their numbers. Through the Meta connection (meta.ts).
 */

/** Instagram fetches the files itself; the links outlive a slow processing queue. */
const LINK_SECONDS = 2 * 60 * 60;
/** Feed photos and carousel items: from 4:5 (portrait) to 1.91:1 (landscape). */
const FEED_ASPECT = { min: 0.8, max: 1.91 };
/** Instagram takes photos up to 1440 px wide. */
const MAX_WIDTH = 1440;

const VIDEO_REF = /^video:(\d{1,9})(?:@(\d{1,5}))?$/;

const wrap = (err: unknown): never => {
  if (err instanceof InstagramError) throw new ToolError(err.message);
  throw err;
};

type Prepared = { item: PostItem; ref: string; video?: { row: VideoRow; version: VideoVersion }; aspect: number | null; generated: boolean };

async function prepare(ref: string, type: PostType, ctx: ToolContext): Promise<Prepared> {
  const r = ref.trim();
  const v = VIDEO_REF.exec(r);
  if (v) {
    if (type === "photo") throw new ToolError(`A photo post takes a picture, not ${r}; post a video as a reel.`);
    const row = await getVideo(Number(v[1]));
    if (!row) throw new ToolError(`There's no video:${v[1]}. video_library list shows them.`);
    let version: VideoVersion;
    try {
      version = finalOf(row, v[2] ? Number(v[2]) : undefined);
    } catch (err) {
      throw new ToolError(err instanceof Error ? err.message : String(err));
    }
    if (version.seconds < 3) throw new ToolError(`${r} is ${version.seconds} s; Instagram takes videos of 3 seconds or more.`);
    if (type !== "reel" && version.seconds > 60) throw new ToolError(`${r} is ${version.seconds} s; stories and carousel videos are up to 60 s.`);
    return {
      item: { kind: "video", url: publicVideoUrl(row.id, version.version, LINK_SECONDS) },
      ref: `video:${row.id}@${version.version}`,
      video: { row, version },
      aspect: version.width / version.height,
      generated: false,
    };
  }
  if (/^asset:\d+$/.test(r) || /^chat:\d+$/.test(r)) {
    if (type === "reel") throw new ToolError(`A reel takes a library video (video:<id>), not ${r}. Make one with video_render first.`);
    let image;
    try {
      image = await imageOf(r, ctx);
    } catch (err) {
      if (err instanceof ToolError && /isn't an image/.test(err.message)) {
        throw new ToolError(`${r} isn't a picture. Clips go up as library videos: render a final with video_render, then post video:<id>.`);
      }
      throw err;
    }
    const { loadImage } = await import("@napi-rs/canvas");
    const img = await loadImage(image.bytes);
    const aspect = img.width / img.height;
    if (type !== "story" && (aspect < FEED_ASPECT.min - 0.005 || aspect > FEED_ASPECT.max + 0.005)) {
      throw new ToolError(
        `${r} is ${img.width}x${img.height} (${aspect.toFixed(2)}:1); feed posts take 4:5 portrait to 1.91:1 landscape. Crop it first (photo_edit crop, e.g. aspect 4:5) or post it as a story.`,
      );
    }
    if (img.width < 320) throw new ToolError(`${r} is ${img.width} px wide; Instagram needs at least 320.`);
    const longEdge = img.width > MAX_WIDTH ? Math.round((MAX_WIDTH * Math.max(img.width, img.height)) / img.width) : Math.max(img.width, img.height);
    const jpeg = await toJpeg(image.bytes, longEdge, 90);
    if (jpeg.length > 8 * 1024 * 1024) throw new ToolError(`${r} is over Instagram's 8 MB even as a JPEG.`);
    return { item: { kind: "image", url: await stagePublic({ bytes: jpeg, ext: "jpg" }, LINK_SECONDS) }, ref: r, aspect, generated: await generated(r) };
  }
  throw new ToolError(`"${ref}" isn't something to post: use video:<id>[@<version>] for a video, chat:<n> or asset:<id> for a picture.`);
}

const COUNTS = { reel: [1, 1], photo: [1, 1], story: [1, 1], carousel: [2, 10] } as const;

export const instagramPost = defineTool({
  name: "instagram_post",
  label: "Post on Instagram",
  description: [
    "Post on the shop's Instagram account (the one linked to its Facebook Page, set in Seelie's settings). Always asks the owner first; post only what they asked for.",
    "type 'reel': one final library video (video:<id>[@<version>], 3 s+); shareToFeed (default true); coverAt: the cover's moment in seconds.",
    "'photo': one picture (chat:<n> or asset:<id>), 4:5 to 1.91:1 (crop with photo_edit first), altText for screen readers.",
    "'carousel': 2-10 pictures and/or final videos (60 s max each); Instagram crops every item to the first one's shape, so make them the same aspect.",
    "'story': one picture or final video (60 s max), 9:16 is best; stories have no caption.",
    "caption: up to 2,200 characters, 30 hashtags, 20 @mentions; write it like the brand (warm, short, a call to shop paribelle.in), hashtags at the end.",
    "collaborators: up to 3 usernames invited as co-authors (feed posts and reels).",
    "aiGenerated: Meta's 'AI info' label; set automatically when a picture came from the image model (photoshoot), set it yourself when a video uses such pictures.",
    "Music: reels posted through the API can't use Instagram's music library, and a commercial song inside the video may get it muted; say so when a video carries a library song.",
    "A video version goes up once per type; again: true to post it again. The answer has the post's link and mediaId (ads_create can promote it).",
  ].join(" "),
  parameters: Type.Object({
    type: StringEnum(["reel", "photo", "carousel", "story"]),
    media: Type.Array(Type.String(), { minItems: 1, maxItems: 10 }),
    caption: optional(Type.String({ maxLength: 2200 })),
    altText: optional(Type.String({ maxLength: 1000 })),
    collaborators: optional(Type.Array(Type.String({ pattern: "^@?[A-Za-z0-9._]{1,30}$" }), { maxItems: 3 })),
    shareToFeed: optional(Type.Boolean()),
    coverAt: optional(Type.Number({ minimum: 0 })),
    aiGenerated: optional(Type.Boolean()),
    again: optional(Type.Boolean()),
  }),
  kind: "publish",
  ownerOnly: true,
  summary: (a) =>
    `Post a ${a.type} on Instagram (${a.media.join(", ")})${a.caption ? `: "${a.caption.slice(0, 100)}${a.caption.length > 100 ? "…" : ""}"` : ""}`,
  async execute(a, ctx) {
    const type = a.type as PostType;
    const [min, max] = COUNTS[type];
    if (a.media.length < min || a.media.length > max) {
      throw new ToolError(type === "carousel" ? "A carousel takes 2 to 10 items." : `A ${type} takes one ${type === "photo" ? "picture" : type === "reel" ? "video" : "picture or video"}.`);
    }
    const origin = publicOrigin();
    if (/^https?:\/\/(localhost|127\.|\[::1\])/i.test(origin)) {
      throw new ToolError(`Instagram fetches the files from ${origin}, which it can't reach. Set SEELIE_PUBLIC_URL to the OMS's public address.`);
    }
    const caption = (a.caption ?? "").trim();
    if (type === "story" && caption) throw new ToolError("Stories have no caption through the API; put the words in the picture or video.");
    if ((caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > 30) throw new ToolError("Instagram allows up to 30 hashtags.");
    if ((caption.match(/(^|\s)@[A-Za-z0-9._]+/g) ?? []).length > 20) throw new ToolError("Instagram allows up to 20 @mentions.");
    if (a.altText && type !== "photo") throw new ToolError("altText is for single photo posts.");
    if (a.coverAt !== undefined && type !== "reel") throw new ToolError("coverAt is for reels.");

    // Checked before anything is prepared, so a missing connection says so plainly.
    await instagramContext().catch(wrap);

    const items: Prepared[] = [];
    for (const [i, ref] of a.media.entries()) {
      ctx.progress(`Preparing ${a.media.length > 1 ? `item ${i + 1} of ${a.media.length}` : ref}…`);
      items.push(await prepare(ref, type, ctx));
    }
    if (type === "carousel") {
      const first = items[0].aspect!;
      const off = items.filter((it) => it.item.kind === "image" && Math.abs(it.aspect! - first) / first > 0.02);
      if (off.length) {
        throw new ToolError(`Carousel items must share the first one's shape (${first.toFixed(2)}:1); ${off.map((o) => `${o.ref} is ${o.aspect!.toFixed(2)}:1`).join(", ")}. Crop them to match first.`);
      }
    }
    if (type === "reel" && a.coverAt !== undefined && a.coverAt > items[0].video!.version.seconds) {
      throw new ToolError(`coverAt is past the end (${items[0].video!.version.seconds} s).`);
    }
    if (!a.again) {
      for (const it of items) {
        if (!it.video) continue;
        const before = publishedOf(it.video.row).find((p) => p.to === "instagram" && p.version === it.video!.version.version && (p.as ?? "reel") === type);
        if (before?.to === "instagram") {
          throw new ToolError(`${it.ref} is already on Instagram as a ${before.as ?? "reel"}${before.permalink ? ` (${before.permalink})` : ""}. again: true posts it once more.`);
        }
      }
    }

    const aiGenerated = a.aiGenerated ?? items.some((it) => it.generated);
    const out = await publishPost({
      type,
      items: items.map((it) => it.item),
      caption,
      altText: a.altText,
      collaborators: a.collaborators?.map((c) => c.replace(/^@/, "")),
      shareToFeed: a.shareToFeed,
      coverAtMs: a.coverAt !== undefined ? a.coverAt * 1000 : undefined,
      aiGenerated,
      signal: ctx.signal,
      progress: ctx.progress,
    }).catch(wrap);

    for (const it of items) {
      if (!it.video) continue;
      await addPublished(it.video.row.id, {
        to: "instagram",
        version: it.video.version.version,
        // Only reels, carousels and stories carry videos.
        as: type as "reel" | "carousel" | "story",
        mediaId: out.mediaId,
        permalink: out.permalink,
        caption,
        at: new Date().toISOString(),
        by: ctx.user.id,
      });
    }
    return {
      data: {
        posted: type,
        account: `@${out.username}`,
        link: out.permalink,
        mediaId: out.mediaId,
        items: items.map((it) => it.ref),
        ...(aiGenerated ? { label: "AI info" } : {}),
      },
    };
  },
});

export const instagram = defineTool({
  name: "instagram",
  label: "Instagram",
  description: [
    "Read the shop's Instagram account. action 'account': the profile (followers, posts) and the last `days` (1-30, default 7) of reach, views, engaged accounts, interactions and link taps,",
    "plus how many of the 100 API posts a day are used. 'media': the latest posts (limit, default 12, max 50) with likes and comments; insights: true adds reach, views, saves and shares per post.",
    "'post': one post (mediaId) with its numbers. 'comments': a post's latest comments (mediaId, limit).",
    "Use it to judge what works before suggesting posts or which post to promote with ads.",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["account", "media", "post", "comments"]),
    days: optional(Type.Integer({ minimum: 1, maximum: 30 })),
    limit: optional(Type.Integer({ minimum: 1, maximum: 50 })),
    insights: optional(Type.Boolean()),
    mediaId: optional(Type.String({ pattern: "^\\d{5,30}$" })),
  }),
  kind: "read",
  ownerOnly: true,
  summary: (a) => `Instagram ${a.action}${a.mediaId ? ` ${a.mediaId}` : ""}`,
  async execute(a, ctx) {
    const ig = await instagramContext().catch(wrap);
    switch (a.action) {
      case "account":
        return { data: { account: `@${ig.instagram.username}`, ...(await accountInfo(ig, a.days ?? 7, ctx.signal).catch(wrap)) } };
      case "media":
        return { data: await recentMedia(ig, a.limit ?? 12, a.insights ?? false, ctx.signal).catch(wrap) };
      case "post":
        if (!a.mediaId) throw new ToolError("Which post (mediaId)?");
        return { data: await mediaOne(ig, a.mediaId, ctx.signal).catch(wrap) };
      case "comments":
        if (!a.mediaId) throw new ToolError("Which post (mediaId)?");
        return { data: await mediaComments(ig, a.mediaId, a.limit ?? 20, ctx.signal).catch(wrap) };
    }
  },
});
