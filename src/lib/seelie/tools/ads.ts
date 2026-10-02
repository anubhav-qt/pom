import "server-only";

import { readFile } from "node:fs/promises";

import { Type } from "@paribelle/pi-ai";

import {
  accountLine,
  adsCall,
  adsContext,
  AdsError,
  campaignsOverview,
  capRoom,
  changeAd,
  createAd,
  CTAS,
  insights,
  managerLink,
  money,
  OBJECTIVES,
  prepaidOf,
  type Change,
  type CreativeSource,
  type Level,
} from "../ads";
import { videoFile } from "../media/files";
import { getVideo } from "../media/library";
import { publicOrigin, publicVideoUrl } from "../media/public";
import { metaStatus } from "../meta";
import { toJpeg } from "./images";
import { imageOf } from "./photo";
import { finalOf } from "./publish";
import { defineTool, ToolError, type ToolContext } from "./types";
import { optional, StringEnum } from "./util";

/**
 * Meta ads: reading the account and results freely; making an ad, switching one back on or
 * giving it more money always asks (kind "ads"), and must fit under the owner's monthly
 * cap (ads.ts checks it). Pausing an ad or lowering its budget only saves money, so those
 * run without asking.
 */

const wrap = (err: unknown): never => {
  if (err instanceof AdsError) throw new ToolError(err.message);
  throw err;
};

const DATE_PRESETS = ["today", "yesterday", "last_3d", "last_7d", "last_14d", "last_30d", "this_month", "last_month", "maximum"] as const;
const BREAKDOWNS = ["age", "gender", "publisher_platform", "platform_position", "region", "device_platform"] as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 30;

const currencyNow = async () => {
  const s = await metaStatus().catch(() => null);
  return { currency: s?.adAccount?.currency ?? "INR", cap: s?.monthlyCap ?? null };
};

/** For an approval card: the prepaid balance, and whether `upTo` more fits in it ("" when the account pays as it goes, or Meta is slow). */
async function fundsNote(upTo?: number) {
  const ads = await adsContext().catch(() => null);
  if (!ads) return "";
  const p = await prepaidOf(ads, AbortSignal.timeout(5_000));
  if (!p || p.balance === null) return "";
  const m = (n: number) => money(n, ads.adAccount.currency);
  return upTo !== undefined && p.balance < upTo ? `. Only ${m(p.balance)} is left on the prepaid balance, so it stops early unless you add money` : `. ${m(p.balance)} prepaid left`;
}

/* -------------------------------------------------------------------------- */
/* ads_report                                                                 */
/* -------------------------------------------------------------------------- */

export const adsReport = defineTool({
  name: "ads_report",
  label: "Ads report",
  description: [
    "Read the shop's Meta ads (Instagram and Facebook). action 'overview': the ad account, the monthly cap and how much of it is spent or held by what's running",
    "(room = what a new ad may spend), the prepaid balance when the account runs on prepaid funds (only the owner can add money, at the topUp link; Seelie can't pay),",
    "and every live or paused campaign with its budget and last 30 days.",
    "'insights': results by level (account, campaign, adset, ad; ids to narrow), datePreset or since/until (YYYY-MM-DD), breakdowns (age, gender, publisher_platform,",
    "platform_position, region, device_platform), daily: true for a row per day. Spend is in the account's currency; ctr in %; thruplays are 15 s+ video plays.",
    "'ad': one ad (id) with its review status, issues, a preview link and its last 7 days.",
    "'geo_search': find places to target (q, geoType country/region/city, countryCode default IN); the keys go in ads_create audience.",
    "'interest_search': find interests to target (q), with audience sizes; their ids go in ads_create audience.interests.",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["overview", "insights", "ad", "geo_search", "interest_search"]),
    level: optional(StringEnum(["account", "campaign", "adset", "ad"])),
    ids: optional(Type.Array(Type.String({ pattern: "^\\d{5,30}$" }), { maxItems: 50 })),
    datePreset: optional(StringEnum(DATE_PRESETS)),
    since: optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    until: optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    breakdowns: optional(Type.Array(StringEnum(BREAKDOWNS), { maxItems: 2 })),
    daily: optional(Type.Boolean()),
    id: optional(Type.String({ pattern: "^\\d{5,30}$" })),
    q: optional(Type.String({ minLength: 1, maxLength: 100 })),
    geoType: optional(StringEnum(["country", "region", "city"])),
    countryCode: optional(Type.String({ pattern: "^[A-Za-z]{2}$" })),
  }),
  kind: "read",
  ownerOnly: true,
  summary: (a) => `Ads ${a.action}${a.id ? ` ${a.id}` : ""}${a.q ? ` "${a.q}"` : ""}`,
  async execute(a, ctx) {
    const ads = await adsContext().catch(wrap);
    const m = (n: number) => money(n, ads.adAccount.currency);
    switch (a.action) {
      case "overview": {
        const [room, campaigns] = await Promise.all([capRoom(ads, ctx.signal), campaignsOverview(ads, ctx.signal)]).catch(wrap);
        return {
          data: {
            account: { ...accountLine(ads), status: room.accountStatus },
            month: {
              cap: room.cap === null ? "not set (no ad may spend)" : m(room.cap),
              spent: m(room.spentThisMonth),
              heldByRunning: m(room.committedTotal),
              room: m(room.room),
              running: room.committed.map((c) => ({ ...c, upTo: m(c.upTo) })),
            },
            funds: room.prepaid
              ? {
                  prepaidBalance: room.prepaid.balance === null ? "Meta didn't say" : m(room.prepaid.balance),
                  metaSays: room.prepaid.meta,
                  low: room.fundsLow,
                  topUp: room.prepaid.topUp,
                }
              : "pays as it goes (no prepaid balance)",
            campaigns,
          },
        };
      }
      case "insights": {
        if ((a.since && !a.until) || (!a.since && a.until)) throw new ToolError("since and until go together.");
        const rows = await insights(ads, { level: a.level ?? "campaign", ids: a.ids, datePreset: a.datePreset, since: a.since, until: a.until, breakdowns: a.breakdowns, daily: a.daily }, ctx.signal).catch(wrap);
        return { data: { currency: ads.adAccount.currency, rows } };
      }
      case "ad": {
        if (!a.id) throw new ToolError("Which ad (id)?");
        const ad = await adsCall<Record<string, unknown>>(
          ads,
          "GET",
          `/${a.id}`,
          {
            fields:
              "name,effective_status,configured_status,ad_review_feedback,issues_info,preview_shareable_link,creative{id,name,effective_instagram_media_id},adset{id,name,lifetime_budget,budget_remaining,end_time},campaign{id,name,objective}",
          },
          ctx.signal,
        ).catch(wrap);
        const last7 = await insights(ads, { level: "ad", ids: [a.id], datePreset: "last_7d" }, ctx.signal).catch(() => []);
        return { data: { ...ad, last7Days: last7[0] ?? null } };
      }
      case "geo_search": {
        if (!a.q) throw new ToolError("What place (q)?");
        const r = await adsCall<{ data?: Record<string, unknown>[] }>(
          ads,
          "GET",
          "/search",
          { type: "adgeolocation", q: a.q, location_types: [a.geoType ?? "city"], country_code: (a.countryCode ?? "IN").toUpperCase(), limit: 10 },
          ctx.signal,
        ).catch(wrap);
        return { data: (r.data ?? []).map((g) => ({ key: g.key, name: g.name, type: g.type, region: g.region, country: g.country_code })) };
      }
      case "interest_search": {
        if (!a.q) throw new ToolError("What interest (q)?");
        const r = await adsCall<{ data?: Record<string, unknown>[] }>(ads, "GET", "/search", { type: "adinterest", q: a.q, limit: 15 }, ctx.signal).catch(wrap);
        return {
          data: (r.data ?? []).map((i) => ({
            id: i.id,
            name: i.name,
            audience: i.audience_size_lower_bound ? `${i.audience_size_lower_bound}-${i.audience_size_upper_bound}` : undefined,
            path: i.path,
          })),
        };
      }
    }
  },
});

/* -------------------------------------------------------------------------- */
/* ads_create                                                                 */
/* -------------------------------------------------------------------------- */

const Audience = Type.Object({
  countries: optional(Type.Array(Type.String({ pattern: "^[A-Za-z]{2}$" }), { maxItems: 25 })),
  regions: optional(Type.Array(Type.Object({ key: Type.String(), name: optional(Type.String()) }), { maxItems: 50 })),
  cities: optional(Type.Array(Type.Object({ key: Type.String(), name: optional(Type.String()), radiusKm: optional(Type.Integer({ minimum: 10, maximum: 80 })) }), { maxItems: 100 })),
  ageMin: optional(Type.Integer({ minimum: 18, maximum: 65 })),
  ageMax: optional(Type.Integer({ minimum: 18, maximum: 65 })),
  genders: optional(StringEnum(["women", "men", "all"])),
  interests: optional(Type.Array(Type.Object({ id: Type.String(), name: optional(Type.String()) }), { maxItems: 25 })),
  advantage: optional(Type.Boolean({ description: "Advantage+ audience (default true): Meta may go past the age, gender and interests as it learns." })),
});

/** When the ad runs: from `start` (default in 10 minutes) for `days`, or to `end` (a day ends at midnight IST). */
function window(a: { days?: number; start?: string; end?: string }) {
  const parse = (v: string, endOfDay: boolean) => {
    const d = DAY.test(v) ? new Date(`${v}T${endOfDay ? "23:59:59" : "00:00:00"}+05:30`) : new Date(v);
    if (Number.isNaN(d.getTime())) throw new ToolError(`"${v}" isn't a date (YYYY-MM-DD, or a full ISO time).`);
    return d;
  };
  let start = a.start ? parse(a.start, false) : new Date(Date.now() + 10 * 60_000);
  if (start.getTime() < Date.now()) start = new Date(Date.now() + 5 * 60_000);
  const end = a.end ? parse(a.end, true) : a.days ? new Date(start.getTime() + a.days * 86_400_000) : null;
  if (!end) throw new ToolError("How long should it run (days, or end)?");
  const days = (end.getTime() - start.getTime()) / 86_400_000;
  if (days < 1) throw new ToolError("An ad runs a day at least.");
  if (days > MAX_DAYS + 0.01) throw new ToolError(`Seelie's ads run ${MAX_DAYS} days at most; make another after.`);
  return { start, end, days: Math.round(days * 10) / 10 };
}

async function creativeSource(a: { post?: string; media?: string }, ctx: ToolContext): Promise<CreativeSource> {
  if (a.post && a.media) throw new ToolError("Promote an Instagram post (post) or make a new ad from media, not both.");
  if (a.post) return { kind: "post", mediaId: a.post };
  if (!a.media) throw new ToolError("What should the ad show: an Instagram post (post: its mediaId) or media (video:<id> or a picture)?");
  const v = /^video:(\d{1,9})(?:@(\d{1,5}))?$/.exec(a.media.trim());
  if (v) {
    const origin = publicOrigin();
    if (/^https?:\/\/(localhost|127\.|\[::1\])/i.test(origin)) throw new ToolError(`Meta fetches the video from ${origin}, which it can't reach. Set SEELIE_PUBLIC_URL.`);
    const row = await getVideo(Number(v[1]));
    if (!row) throw new ToolError(`There's no video:${v[1]}.`);
    let version;
    try {
      version = finalOf(row, v[2] ? Number(v[2]) : undefined);
    } catch (err) {
      throw new ToolError(err instanceof Error ? err.message : String(err));
    }
    const poster = await readFile(videoFile(row.id, version.version, "poster")).catch(() => null);
    if (!poster) throw new ToolError(`video:${row.id}@${version.version} has no cover picture on disk; render it again.`);
    return { kind: "video", videoUrl: publicVideoUrl(row.id, version.version, 2 * 60 * 60), poster, name: `${row.title ?? `video ${row.id}`} v${version.version}` };
  }
  const image = await imageOf(a.media, ctx);
  return { kind: "photo", image: await toJpeg(image.bytes, 1600, 90), name: image.name };
}

export const adsCreate = defineTool({
  name: "ads_create",
  label: "Run an ad",
  description: [
    "Make and start a Meta ad (Instagram by default). It spends real money: always asks the owner, who sees the budget, and it must fit under the monthly cap",
    "(ads_report overview shows the room). Suggest one first (what, who, how much, how long, why) and make it only when the owner wants it.",
    "Source: post = an Instagram post's mediaId to promote (keeps its likes and comments; posts with a licensed song may be refused), or media = video:<id>[@<v>] (a final)",
    "or a picture (chat:<n>/asset:<id>) for a new ad. objective: traffic (visits to `link`, a paribelle.in product or collection page; needs link),",
    "engagement (likes, comments, saves on the post), video_views (15 s plays; a video), reach (as many people as possible).",
    "budget: the most it may spend in all, in the account's currency; days (1-30) or end (YYYY-MM-DD, IST); start (default: in 10 minutes).",
    "audience: countries (default IN), regions and cities (keys from ads_report geo_search), ageMin/ageMax, genders, interests (ids from ads_report interest_search);",
    "advantage (default true) lets Meta go beyond them as it learns. placements: instagram (feed, stories, reels; default) or automatic (Facebook and Instagram).",
    "text: the words above the ad (new ads; keep the first 125 characters strong), headline (photo and video ads, ~40 characters), cta (default SHOP_NOW, with link).",
    "Meta reviews every ad before it shows (minutes to a day); ads_report ad tells. The answer has the ids and an Ads Manager link.",
  ].join(" "),
  parameters: Type.Object({
    name: Type.String({ minLength: 3, maxLength: 80 }),
    objective: StringEnum(OBJECTIVES),
    budget: Type.Number({ exclusiveMinimum: 0 }),
    days: optional(Type.Integer({ minimum: 1, maximum: MAX_DAYS })),
    start: optional(Type.String()),
    end: optional(Type.String()),
    post: optional(Type.String({ pattern: "^\\d{5,30}$" })),
    media: optional(Type.String()),
    text: optional(Type.String({ maxLength: 2200 })),
    headline: optional(Type.String({ maxLength: 255 })),
    link: optional(Type.String({ pattern: "^https://" })),
    cta: optional(StringEnum(CTAS)),
    audience: optional(Audience),
    placements: optional(StringEnum(["instagram", "automatic"])),
  }),
  kind: "ads",
  ownerOnly: true,
  async summary(a) {
    const { currency, cap } = await currencyNow();
    const how = a.days ? `${a.days} day${a.days === 1 ? "" : "s"}` : a.end ? `until ${a.end}` : "?";
    const what = a.post ? `Instagram post ${a.post}` : (a.media ?? "?");
    const who = a.audience
      ? [
          a.audience.cities?.length ? a.audience.cities.map((c) => c.name ?? c.key).join(", ") : a.audience.regions?.length ? a.audience.regions.map((r) => r.name ?? r.key).join(", ") : (a.audience.countries ?? ["IN"]).join(", "),
          a.audience.genders && a.audience.genders !== "all" ? a.audience.genders : null,
          a.audience.ageMin || a.audience.ageMax ? `${a.audience.ageMin ?? 18}-${a.audience.ageMax ?? "65+"}` : null,
        ]
          .filter(Boolean)
          .join(", ")
      : "India";
    return `Spend up to ${money(a.budget, currency)} over ${how} on "${a.name}": ${a.objective.replace("_", " ")} ad from ${what}, for ${who}${cap !== null ? ` (monthly cap ${money(cap, currency)})` : ""}${await fundsNote(a.budget)}`;
  },
  async execute(a, ctx) {
    const ads = await adsContext().catch(wrap);
    const when = window(a);
    if (a.objective === "video_views" && !a.post && !(a.media && a.media.startsWith("video:"))) throw new ToolError("video_views needs a video (a reel's mediaId or video:<id>).");
    if (a.audience?.ageMin && a.audience.ageMax && a.audience.ageMin > a.audience.ageMax) throw new ToolError("ageMin is above ageMax.");
    if (a.link && !/^https:\/\/([a-z0-9-]+\.)*paribelle\.in(\/|$)/i.test(a.link)) {
      throw new ToolError("Ads link to paribelle.in pages only (the shop's own site).");
    }
    const creative = await creativeSource(a, ctx);
    const name = `Seelie · ${a.name}`;
    const made = await createAd(
      ads,
      {
        name,
        objective: a.objective,
        budget: a.budget,
        start: when.start,
        end: when.end,
        audience: a.audience ?? {},
        placements: a.placements ?? "instagram",
        creative,
        text: a.text,
        headline: a.headline,
        link: a.link,
        cta: a.cta,
      },
      ctx.progress,
      ctx.signal,
    ).catch(wrap);
    return {
      text: `The ad is made and switched on; Meta reviews it before it shows.${made.funds ? ` ${made.funds}` : ""}`,
      data: {
        ...made,
        name,
        budget: money(a.budget, ads.adAccount.currency),
        runs: { from: when.start.toISOString(), to: when.end.toISOString(), days: when.days },
        adsManager: managerLink(ads, made.campaignId),
      },
    };
  },
});

/* -------------------------------------------------------------------------- */
/* ads_manage                                                                 */
/* -------------------------------------------------------------------------- */

const ACTIONS = ["pause", "resume", "lower_budget", "raise_budget", "extend", "archive"] as const;

export const adsManage = defineTool({
  name: "ads_manage",
  label: "Change an ad",
  description: [
    "Change a campaign, ad set or ad (level + id, from ads_report). pause and lower_budget only save money and run without asking: pause an ad that wastes money",
    "(spending with no results, or far worse than the others) and tell the owner why. resume, raise_budget (budget: the new total, or the new daily budget",
    "for daily ones) and extend (end: YYYY-MM-DD, IST; ad sets) can spend more, so they ask and must fit under the monthly cap. archive asks too (it can't be undone).",
  ].join(" "),
  parameters: Type.Object({
    level: StringEnum(["campaign", "adset", "ad"]),
    id: Type.String({ pattern: "^\\d{5,30}$" }),
    action: StringEnum(ACTIONS),
    budget: optional(Type.Number({ exclusiveMinimum: 0 })),
    end: optional(Type.String()),
  }),
  kind: (a) => (a.action === "pause" || a.action === "lower_budget" ? "read" : a.action === "archive" ? "write" : "ads"),
  ownerOnly: true,
  async summary(a) {
    const { currency } = await currencyNow();
    const what = `${a.level === "adset" ? "ad set" : a.level} ${a.id}`;
    switch (a.action) {
      case "pause":
        return `Pause ${what}`;
      case "resume":
        return `Switch ${what} back on (it can spend again)${await fundsNote()}`;
      case "lower_budget":
        return `Lower ${what}'s budget to ${a.budget !== undefined ? money(a.budget, currency) : "?"}`;
      case "raise_budget":
        return `Raise ${what}'s budget to ${a.budget !== undefined ? money(a.budget, currency) : "?"}${await fundsNote()}`;
      case "extend":
        return `Run ${what} until ${a.end ?? "?"}`;
      case "archive":
        return `Archive ${what}`;
    }
  },
  async execute(a, ctx) {
    const ads = await adsContext().catch(wrap);
    let change: Change;
    if (a.action === "lower_budget" || a.action === "raise_budget") {
      if (a.budget === undefined) throw new ToolError("What should the budget be (budget)?");
      change = { action: a.action, budget: a.budget };
    } else if (a.action === "extend") {
      if (!a.end) throw new ToolError("Until when (end: YYYY-MM-DD)?");
      const end = DAY.test(a.end) ? new Date(`${a.end}T23:59:59+05:30`) : new Date(a.end);
      if (Number.isNaN(end.getTime())) throw new ToolError(`"${a.end}" isn't a date.`);
      change = { action: "extend", end };
    } else {
      change = { action: a.action };
    }
    return { data: await changeAd(ads, a.level as Level, a.id, change, ctx.signal).catch(wrap) };
  },
});
