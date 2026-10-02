import "server-only";

import { graphList, MetaError, metaCall, metaContext, type MetaAdAccount, type MetaContext, type MetaPage } from "./meta";

/**
 * Ads on Instagram (and Facebook, when asked) through Meta's Marketing API, on the ad
 * account chosen in Seelie's settings.
 *
 * Money rules (the owner's):
 *  - Nothing spends without the owner's approval (the tools' "ads" kind always asks), and
 *    nothing starts without a monthly cap.
 *  - The cap is checked in code before anything that can raise spending: this month's
 *    spend so far, plus everything that can still be spent by what's running (a lifetime
 *    budget's remainder, a daily budget for every day left in the month), plus the new
 *    budget, must fit under it. That overcounts on purpose.
 *  - Seelie's ad sets have lifetime budgets and an end date, so Meta can never spend more
 *    than was approved.
 *  - Everything is created paused and switched on last, so a step that fails midway
 *    leaves nothing spending (and is deleted).
 */

export class AdsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdsError";
  }
}

export interface AdsContext extends MetaContext {
  adAccount: MetaAdAccount;
  page: MetaPage;
}

const ACCOUNT_STATUS: Record<number, string> = {
  1: "active",
  2: "disabled",
  3: "unsettled (a payment failed)",
  7: "pending risk review",
  8: "pending settlement",
  9: "in grace period",
  100: "pending closure",
  101: "closed",
};

export async function adsContext(): Promise<AdsContext> {
  const ctx = await metaContext().catch((err: unknown) => {
    throw new AdsError(err instanceof Error ? err.message : String(err));
  });
  if (!ctx.adAccount) {
    throw new AdsError(
      "No ad account is chosen in Seelie's settings (the Meta panel). The owner creates one in Business Settings → Accounts → Ad accounts, adds a payment method, assigns it to the system user, then presses Check again.",
    );
  }
  if (!ctx.page) throw new AdsError("No Facebook Page is chosen in Seelie's settings (the Meta panel); Meta runs every ad from a Page.");
  return ctx as AdsContext;
}

export async function adsCall<T>(
  ctx: MetaContext,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  try {
    return await metaCall<T>(ctx, method, path, params, { signal, timeoutMs: 120_000 });
  } catch (err) {
    if (err instanceof MetaError) throw new AdsError(err.message);
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Money                                                                      */
/* -------------------------------------------------------------------------- */

/** Currencies Meta counts in whole units; every other is in hundredths. */
const WHOLE_UNITS = new Set(["CLP", "COP", "CRC", "HUF", "ISK", "IDR", "JPY", "KRW", "PYG", "TWD", "VND"]);

export const toMinor = (amount: number, currency: string) => Math.round(amount * (WHOLE_UNITS.has(currency) ? 1 : 100));
export const fromMinor = (minor: number | string | null | undefined, currency: string) => Number(minor ?? 0) / (WHOLE_UNITS.has(currency) ? 1 : 100);

export function money(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: amount % 1 ? 2 : 0 }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** The calendar day (YYYY-MM-DD) and its last day of the month, in a timezone. */
function today(timezone: string) {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [y, m] = day.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { day, y, m, d: Number(day.slice(8)), last };
}

/** Days of this month, today included, on which a daily budget can still spend. */
function daysLeftThisMonth(timezone: string, end?: string | null) {
  const t = today(timezone);
  let lastDay = t.last;
  if (end) {
    const endDay = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(end));
    const [ey, em, ed] = endDay.split("-").map(Number);
    if (ey < t.y || (ey === t.y && em < t.m)) return 0;
    if (ey === t.y && em === t.m) lastDay = Math.min(lastDay, ed);
  }
  return Math.max(0, lastDay - t.d + 1);
}

/** Ad sets and campaigns that are running (or about to): what they can still spend counts against the cap. */
const LIVE = ["ACTIVE", "IN_PROCESS", "WITH_ISSUES"];

type BudgetRow = {
  id: string;
  name: string;
  effective_status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  budget_remaining?: string;
  end_time?: string;
  stop_time?: string;
  campaign_id?: string;
};

/** What a campaign or ad set can still spend this month, at most. */
function stillToSpend(row: BudgetRow, ctx: AdsContext) {
  const cur = ctx.adAccount.currency;
  if (Number(row.lifetime_budget ?? 0) > 0) return fromMinor(row.budget_remaining, cur);
  if (Number(row.daily_budget ?? 0) > 0) return fromMinor(row.daily_budget, cur) * daysLeftThisMonth(ctx.adAccount.timezone, row.end_time ?? row.stop_time);
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Prepaid funds                                                              */
/* -------------------------------------------------------------------------- */

/**
 * An account on prepaid funds spends what the owner has added and stops when it runs out.
 * Only the owner can add money (in Billing, with their OTP or UPI app): Meta has no API
 * for it, so Seelie reads the balance, warns, and links to the top-up page.
 */
export interface Prepaid {
  /** What's left to spend (null when Meta doesn't say). */
  balance: number | null;
  /** Meta's own words for the payment method, e.g. "Available balance (₹1,000.00 INR)". */
  meta: string | null;
  /** Where to add money. */
  topUp: string;
}

export const topUpLink = (ctx: AdsContext) => `https://business.facebook.com/billing_hub/payment_settings/?asset_id=${ctx.adAccount.id.replace(/^act_/, "")}`;

/** The first amount in a display string: "₹1,00,000.50 INR" → 100000.5, "R$ 1.234,56" → 1234.56. */
export function amountIn(text: string): number | null {
  const m = /\d[\d.,]*/.exec(text);
  if (!m) return null;
  let s = m[0].replace(/[.,]+$/, "");
  const dot = s.lastIndexOf(".");
  const comma = s.lastIndexOf(",");
  if (comma > dot && /,\d{1,2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

type FundingRow = {
  is_prepay_account?: boolean;
  spend_cap?: string;
  amount_spent?: string;
  funding_source_details?: { id?: string; display_string?: string; type?: number };
};

/** The prepaid balance, or null when the account pays as it goes (or Meta won't say how it pays). */
export async function prepaidOf(ctx: AdsContext, signal?: AbortSignal): Promise<Prepaid | null> {
  const row = await adsCall<FundingRow>(ctx, "GET", `/${ctx.adAccount.id}`, { fields: "is_prepay_account,spend_cap,amount_spent,funding_source_details" }, signal).catch(
    () => null,
  );
  if (!row) return null;
  const words = row.funding_source_details?.display_string?.trim() || null;
  const saysBalance = !!words && /balance/i.test(words);
  if (!row.is_prepay_account && !saysBalance) return null;
  const cur = ctx.adAccount.currency;
  let balance = saysBalance ? amountIn(words!) : null;
  // Otherwise Meta keeps a prepaid account's funds as its spend cap.
  if (balance === null && Number(row.spend_cap ?? 0) > 0) balance = Math.max(0, fromMinor(row.spend_cap, cur) - fromMinor(row.amount_spent, cur));
  return { balance, meta: words, topUp: topUpLink(ctx) };
}

/** A warning when the prepaid funds can't cover `upTo` (what could be spent), else null. */
export function fundsWarning(prepaid: Prepaid | null, upTo: number, currency: string): string | null {
  if (!prepaid) return null;
  const m = (n: number) => money(n, currency);
  if (prepaid.balance === null) return `The account runs on prepaid funds and Meta didn't say how much is left; the owner can check (and add money) at ${prepaid.topUp}.`;
  if (prepaid.balance >= upTo - 0.005) return null;
  return `Only ${m(prepaid.balance)} is left on the prepaid balance, and up to ${m(upTo)} could be spent: Meta stops the ads when it runs out. Only the owner can add money (Seelie can't pay): ${prepaid.topUp}`;
}

export interface CapRoom {
  currency: string;
  accountStatus: string;
  accountActive: boolean;
  cap: number | null;
  spentThisMonth: number;
  /** What running campaigns and ad sets can still spend, at most. */
  committed: { id: string; name: string; level: "campaign" | "adset"; upTo: number }[];
  committedTotal: number;
  /** What a new or bigger budget may be, at most (0 when there's no cap). */
  room: number;
  /** Prepaid funds left, when the account runs on them. */
  prepaid: Prepaid | null;
  /** The prepaid balance can't cover what's running, or is under a tenth of the cap. */
  fundsLow: boolean;
}

export async function capRoom(ctx: AdsContext, signal?: AbortSignal): Promise<CapRoom> {
  const act = ctx.adAccount.id;
  const cur = ctx.adAccount.currency;
  const [account, spend, campaigns, adsets, prepaid] = await Promise.all([
    adsCall<{ account_status?: number }>(ctx, "GET", `/${act}`, { fields: "account_status" }, signal),
    adsCall<{ data?: { spend?: string }[] }>(ctx, "GET", `/${act}/insights`, { date_preset: "this_month", level: "account", fields: "spend" }, signal),
    graphList<BudgetRow>(`/${act}/campaigns`, { fields: "id,name,effective_status,daily_budget,lifetime_budget,budget_remaining,stop_time", effective_status: LIVE }, ctx.token, 500, signal),
    graphList<BudgetRow>(`/${act}/adsets`, { fields: "id,name,campaign_id,effective_status,daily_budget,lifetime_budget,budget_remaining,end_time", effective_status: LIVE }, ctx.token, 1000, signal),
    prepaidOf(ctx, signal),
  ]).catch((err: unknown) => {
    if (err instanceof MetaError) throw new AdsError(err.message);
    throw err;
  });
  const status = account.account_status ?? ctx.adAccount.status;
  const spentThisMonth = Number(spend.data?.[0]?.spend ?? 0);
  const committed: CapRoom["committed"] = [];
  const campaignBudget = new Set<string>();
  for (const c of campaigns) {
    if (Number(c.lifetime_budget ?? 0) > 0 || Number(c.daily_budget ?? 0) > 0) {
      campaignBudget.add(c.id);
      committed.push({ id: c.id, name: c.name, level: "campaign", upTo: stillToSpend(c, ctx) });
    }
  }
  const liveCampaigns = new Set(campaigns.map((c) => c.id));
  for (const s of adsets) {
    if (!s.campaign_id || campaignBudget.has(s.campaign_id) || !liveCampaigns.has(s.campaign_id)) continue;
    committed.push({ id: s.id, name: s.name, level: "adset", upTo: stillToSpend(s, ctx) });
  }
  const committedTotal = committed.reduce((sum, c) => sum + c.upTo, 0);
  const cap = ctx.monthlyCap;
  const balance = prepaid?.balance ?? null;
  return {
    currency: cur,
    accountStatus: ACCOUNT_STATUS[status] ?? `status ${status}`,
    accountActive: status === 1,
    cap,
    spentThisMonth,
    committed: committed.filter((c) => c.upTo > 0),
    committedTotal,
    room: cap === null ? 0 : Math.max(0, cap - spentThisMonth - committedTotal),
    prepaid,
    fundsLow: balance !== null && (balance <= 0 || balance < committedTotal - 0.005 || (cap !== null && cap > 0 && balance < cap / 10)),
  };
}

/** Refuse when `extra` more spending wouldn't fit under the monthly cap. */
export async function checkCap(ctx: AdsContext, extra: number, what: string, signal?: AbortSignal): Promise<CapRoom> {
  const room = await capRoom(ctx, signal);
  const m = (n: number) => money(n, room.currency);
  if (!room.accountActive) throw new AdsError(`The ad account is ${room.accountStatus}; Meta won't run ads on it until the owner sorts that out in Ads Manager (Billing).`);
  if (room.cap === null || room.cap <= 0) {
    throw new AdsError("There's no monthly ad cap yet, so no ad may spend: the owner sets one in Seelie's settings (the Meta panel).");
  }
  if (extra > room.room + 0.005) {
    throw new AdsError(
      `${what} could spend ${m(extra)}, but only ${m(room.room)} fits under the monthly cap of ${m(room.cap)} (${m(room.spentThisMonth)} spent this month, up to ${m(room.committedTotal)} more by what's running). Ask the owner to raise the cap, or make it smaller.`,
    );
  }
  return room;
}

/* -------------------------------------------------------------------------- */
/* Making an ad                                                               */
/* -------------------------------------------------------------------------- */

export const OBJECTIVES = ["traffic", "engagement", "video_views", "reach"] as const;
export type Objective = (typeof OBJECTIVES)[number];

const OBJECTIVE: Record<Objective, { objective: string; goal: string; destination?: string }> = {
  traffic: { objective: "OUTCOME_TRAFFIC", goal: "LINK_CLICKS", destination: "WEBSITE" },
  engagement: { objective: "OUTCOME_ENGAGEMENT", goal: "POST_ENGAGEMENT", destination: "ON_POST" },
  video_views: { objective: "OUTCOME_ENGAGEMENT", goal: "THRUPLAY", destination: "ON_VIDEO" },
  reach: { objective: "OUTCOME_AWARENESS", goal: "REACH" },
};

export const CTAS = ["SHOP_NOW", "LEARN_MORE", "ORDER_NOW", "BUY_NOW", "SEE_MORE", "SIGN_UP", "CONTACT_US"] as const;

export interface Audience {
  countries?: string[];
  regions?: { key: string; name?: string }[];
  cities?: { key: string; name?: string; radiusKm?: number }[];
  ageMin?: number;
  ageMax?: number;
  genders?: "women" | "men" | "all";
  interests?: { id: string; name?: string }[];
  /** Advantage+ audience: Meta may reach past the age, gender and interests given. */
  advantage?: boolean;
}

export type CreativeSource =
  | { kind: "post"; mediaId: string }
  | { kind: "video"; videoUrl: string; poster: Buffer; name: string }
  | { kind: "photo"; image: Buffer; name: string };

export interface NewAd {
  name: string;
  objective: Objective;
  /** Lifetime budget, in the account's currency. */
  budget: number;
  start: Date;
  end: Date;
  audience: Audience;
  placements: "instagram" | "automatic";
  creative: CreativeSource;
  text?: string;
  headline?: string;
  link?: string;
  cta?: (typeof CTAS)[number];
}

export function targetingOf(a: Audience, placements: NewAd["placements"]) {
  const geo: Record<string, unknown> = {};
  if (a.countries?.length) geo.countries = a.countries.map((c) => c.toUpperCase());
  if (a.regions?.length) geo.regions = a.regions.map((r) => ({ key: r.key }));
  if (a.cities?.length) geo.cities = a.cities.map((c) => ({ key: c.key, ...(c.radiusKm ? { radius: c.radiusKm, distance_unit: "kilometer" } : {}) }));
  if (!Object.keys(geo).length) geo.countries = ["IN"];
  return {
    geo_locations: geo,
    ...(a.ageMin ? { age_min: a.ageMin } : {}),
    ...(a.ageMax ? { age_max: a.ageMax } : {}),
    ...(a.genders && a.genders !== "all" ? { genders: [a.genders === "men" ? 1 : 2] } : {}),
    ...(a.interests?.length ? { flexible_spec: [{ interests: a.interests.map((i) => ({ id: i.id, ...(i.name ? { name: i.name } : {}) })) }] } : {}),
    ...(placements === "instagram" ? { publisher_platforms: ["instagram"], instagram_positions: ["stream", "story", "reels"] } : {}),
    targeting_automation: { advantage_audience: a.advantage === false ? 0 : 1 },
  };
}

/** A Meta time: ISO with the offset, in the account's zone as Meta reads it. */
const metaTime = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "+0000");

async function uploadImage(ctx: AdsContext, bytes: Buffer, signal?: AbortSignal): Promise<string> {
  const r = await adsCall<{ images?: Record<string, { hash?: string }> }>(ctx, "POST", `/${ctx.adAccount.id}/adimages`, { bytes: bytes.toString("base64") }, signal);
  const hash = Object.values(r.images ?? {})[0]?.hash;
  if (!hash) throw new AdsError("Meta took the image but gave no hash for it.");
  return hash;
}

async function uploadVideo(ctx: AdsContext, url: string, name: string, progress: (t: string) => void, signal?: AbortSignal): Promise<string> {
  const { id } = await adsCall<{ id: string }>(ctx, "POST", `/${ctx.adAccount.id}/advideos`, { file_url: url, name }, signal);
  const started = Date.now();
  for (;;) {
    const v = await adsCall<{ status?: { video_status?: string; processing_phase?: { status?: string; errors?: { message?: string }[] } } }>(
      ctx,
      "GET",
      `/${id}`,
      { fields: "status" },
      signal,
    );
    const s = v.status?.video_status;
    if (s === "ready") return id;
    if (s === "error") throw new AdsError(`Meta couldn't process the video: ${v.status?.processing_phase?.errors?.[0]?.message ?? "no reason given"}`);
    if (Date.now() - started > 10 * 60_000) throw new AdsError("Meta is still processing the video after 10 minutes; no ad was made.");
    if (signal?.aborted) throw new AdsError("Stopped before the ad was made.");
    progress(`Meta is processing the video (${Math.round((Date.now() - started) / 1000)} s)…`);
    await new Promise((ok) => setTimeout(ok, 4000));
  }
}

async function creativeOf(ctx: AdsContext, ad: NewAd, progress: (t: string) => void, signal?: AbortSignal) {
  const page = ctx.page.id;
  const ig = ctx.page.instagram?.id;
  const cta = ad.link ? { type: ad.cta ?? "SHOP_NOW", value: { link: ad.link } } : undefined;
  const src = ad.creative;
  if (src.kind === "post") {
    if (!ig) throw new AdsError("The Page has no Instagram account linked, so an Instagram post can't be used.");
    return { object_id: page, instagram_user_id: ig, source_instagram_media_id: src.mediaId, ...(cta ? { call_to_action: cta } : {}) };
  }
  if (src.kind === "video") {
    progress("Uploading the video to Meta…");
    const videoId = await uploadVideo(ctx, src.videoUrl, src.name, progress, signal);
    const imageHash = await uploadImage(ctx, src.poster, signal);
    return {
      object_story_spec: {
        page_id: page,
        ...(ig ? { instagram_user_id: ig } : {}),
        video_data: { video_id: videoId, image_hash: imageHash, ...(ad.text ? { message: ad.text } : {}), ...(ad.headline ? { title: ad.headline } : {}), ...(cta ? { call_to_action: cta } : {}) },
      },
    };
  }
  progress("Uploading the photo to Meta…");
  const imageHash = await uploadImage(ctx, src.image, signal);
  if (!ad.link) throw new AdsError("A photo ad needs a link (link: a paribelle.in page).");
  return {
    object_story_spec: {
      page_id: page,
      ...(ig ? { instagram_user_id: ig } : {}),
      link_data: { image_hash: imageHash, link: ad.link, ...(ad.text ? { message: ad.text } : {}), ...(ad.headline ? { name: ad.headline } : {}), call_to_action: cta },
    },
  };
}

export const managerLink = (ctx: AdsContext, campaignId: string) =>
  `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${ctx.adAccount.id.replace(/^act_/, "")}&selected_campaign_ids=${campaignId}`;

/** Make the campaign, ad set, creative and ad, all paused, then switch them on together. */
export async function createAd(ctx: AdsContext, ad: NewAd, progress: (t: string) => void, signal?: AbortSignal) {
  const act = ctx.adAccount.id;
  const o = OBJECTIVE[ad.objective];
  if (ad.objective === "traffic" && !ad.link) throw new AdsError("A traffic ad needs a link (link: the paribelle.in page it sends people to).");
  const room = await checkCap(ctx, ad.budget, `"${ad.name}"`, signal);
  const funds = fundsWarning(room.prepaid, room.committedTotal + ad.budget, ctx.adAccount.currency);

  const creative = await creativeOf(ctx, ad, progress, signal);
  progress("Making the campaign…");
  const campaign = await adsCall<{ id: string }>(
    ctx,
    "POST",
    `/${act}/campaigns`,
    { name: ad.name, objective: o.objective, status: "PAUSED", special_ad_categories: [], buying_type: "AUCTION", is_adset_budget_sharing_enabled: false },
    signal,
  );
  try {
    progress("Making the ad set…");
    const adset = await adsCall<{ id: string }>(
      ctx,
      "POST",
      `/${act}/adsets`,
      {
        name: ad.name,
        campaign_id: campaign.id,
        lifetime_budget: toMinor(ad.budget, ctx.adAccount.currency),
        start_time: metaTime(ad.start),
        end_time: metaTime(ad.end),
        billing_event: "IMPRESSIONS",
        optimization_goal: o.goal,
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        ...(o.destination ? { destination_type: o.destination } : {}),
        targeting: targetingOf(ad.audience, ad.placements),
        status: "PAUSED",
      },
      signal,
    );
    progress("Making the creative…");
    const made = await adsCall<{ id: string }>(ctx, "POST", `/${act}/adcreatives`, { name: ad.name, ...creative }, signal);
    const adRow = await adsCall<{ id: string }>(ctx, "POST", `/${act}/ads`, { name: ad.name, adset_id: adset.id, creative: { creative_id: made.id }, status: "PAUSED" }, signal);

    progress("Switching it on…");
    await adsCall(ctx, "POST", `/${adRow.id}`, { status: "ACTIVE" }, signal);
    await adsCall(ctx, "POST", `/${adset.id}`, { status: "ACTIVE" }, signal);
    await adsCall(ctx, "POST", `/${campaign.id}`, { status: "ACTIVE" }, signal);
    const state = await adsCall<{ effective_status?: string; preview_shareable_link?: string }>(ctx, "GET", `/${adRow.id}`, { fields: "effective_status,preview_shareable_link" }).catch(
      () => ({}) as { effective_status?: string; preview_shareable_link?: string },
    );
    return {
      campaignId: campaign.id,
      adsetId: adset.id,
      creativeId: made.id,
      adId: adRow.id,
      status: state.effective_status ?? null,
      preview: state.preview_shareable_link ?? null,
      ...(funds ? { funds } : {}),
    };
  } catch (err) {
    // Nothing half-made is left behind: deleting the campaign takes its ad set and ad with it.
    await adsCall(ctx, "DELETE", `/${campaign.id}`).catch(() => {});
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Changing an ad                                                             */
/* -------------------------------------------------------------------------- */

export type Level = "campaign" | "adset" | "ad";

type Row = BudgetRow & { status?: string; adset_id?: string };

async function rowOf(ctx: AdsContext, level: Level, id: string, signal?: AbortSignal): Promise<Row> {
  const fields =
    level === "ad"
      ? "id,name,status,effective_status,adset_id,campaign_id"
      : level === "adset"
        ? "id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,budget_remaining,end_time"
        : "id,name,status,effective_status,daily_budget,lifetime_budget,budget_remaining,stop_time";
  const row = await adsCall<Row & { account_id?: string }>(ctx, "GET", `/${id}`, { fields: `${fields},account_id` }, signal);
  if (row.account_id && `act_${row.account_id}` !== ctx.adAccount.id) throw new AdsError(`${id} belongs to another ad account.`);
  return row;
}

/** What switching this on again could spend this month, at most. */
async function resumeCost(ctx: AdsContext, level: Level, row: Row, signal?: AbortSignal): Promise<number> {
  if (level === "ad") {
    // An ad spends from its ad set's (or campaign's) budget; that's what can start spending.
    const adset = await rowOf(ctx, "adset", row.adset_id!, signal);
    if (adset.effective_status !== "ACTIVE" && adset.status !== "ACTIVE") return 0;
    return resumeCost(ctx, "adset", adset, signal);
  }
  if (level === "adset") {
    const own = stillToSpend(row, ctx);
    if (own > 0) return own;
    const campaign = await rowOf(ctx, "campaign", row.campaign_id!, signal);
    return stillToSpend(campaign, ctx);
  }
  const own = stillToSpend(row, ctx);
  if (own > 0) return own;
  const adsets = await graphList<BudgetRow & { status?: string }>(
    `/${row.id}/adsets`,
    { fields: "id,name,status,daily_budget,lifetime_budget,budget_remaining,end_time" },
    ctx.token,
    200,
    signal,
  );
  return adsets.filter((s) => s.status === "ACTIVE").reduce((sum, s) => sum + stillToSpend(s, ctx), 0);
}

export type Change =
  | { action: "pause" }
  | { action: "archive" }
  | { action: "resume" }
  | { action: "lower_budget"; budget: number }
  | { action: "raise_budget"; budget: number }
  | { action: "extend"; end: Date };

export async function changeAd(ctx: AdsContext, level: Level, id: string, change: Change, signal?: AbortSignal) {
  const row = await rowOf(ctx, level, id, signal);
  const cur = ctx.adAccount.currency;
  const m = (n: number) => money(n, cur);
  const live = row.effective_status === "ACTIVE" || row.effective_status === "IN_PROCESS" || row.effective_status === "WITH_ISSUES";

  switch (change.action) {
    case "pause":
      await adsCall(ctx, "POST", `/${id}`, { status: "PAUSED" }, signal);
      return { [level]: row.name, was: row.effective_status, now: "PAUSED" };
    case "archive":
      await adsCall(ctx, "POST", `/${id}`, { status: "ARCHIVED" }, signal);
      return { [level]: row.name, was: row.effective_status, now: "ARCHIVED" };
    case "resume": {
      if (live) return { [level]: row.name, now: row.effective_status, note: "It's already on." };
      const cost = await resumeCost(ctx, level, row, signal);
      const room = cost > 0 ? await checkCap(ctx, cost, `Switching "${row.name}" back on`, signal) : null;
      const funds = room ? fundsWarning(room.prepaid, room.committedTotal + cost, cur) : null;
      await adsCall(ctx, "POST", `/${id}`, { status: "ACTIVE" }, signal);
      const after = await adsCall<{ effective_status?: string }>(ctx, "GET", `/${id}`, { fields: "effective_status" }).catch(() => ({ effective_status: undefined }));
      return { [level]: row.name, was: row.effective_status, now: after.effective_status ?? "ACTIVE", canSpendUpTo: m(cost), ...(funds ? { funds } : {}) };
    }
    case "lower_budget":
    case "raise_budget": {
      if (level === "ad") throw new AdsError("An ad has no budget of its own; change its ad set's (or campaign's).");
      const field = Number(row.lifetime_budget ?? 0) > 0 ? "lifetime_budget" : Number(row.daily_budget ?? 0) > 0 ? "daily_budget" : null;
      if (!field) throw new AdsError(`"${row.name}" has no budget of its own${level === "adset" ? " (its campaign holds it)" : " (its ad sets hold them)"}.`);
      const before = fromMinor(row[field], cur);
      const next = change.budget;
      if (change.action === "lower_budget" && next >= before) throw new AdsError(`${m(next)} isn't lower than the current ${m(before)}; that's a raise, which asks first.`);
      if (change.action === "raise_budget" && next <= before) throw new AdsError(`${m(next)} isn't higher than the current ${m(before)}.`);
      let funds: string | null = null;
      if (change.action === "raise_budget" && live) {
        const extra = field === "lifetime_budget" ? next - before : (next - before) * daysLeftThisMonth(ctx.adAccount.timezone, row.end_time ?? row.stop_time);
        const room = await checkCap(ctx, extra, `Raising "${row.name}"`, signal);
        funds = fundsWarning(room.prepaid, room.committedTotal + extra, cur);
      }
      await adsCall(ctx, "POST", `/${id}`, { [field]: toMinor(next, cur) }, signal);
      return { [level]: row.name, budget: field === "lifetime_budget" ? "lifetime" : "daily", was: m(before), now: m(next), ...(funds ? { funds } : {}) };
    }
    case "extend": {
      if (level !== "adset") throw new AdsError("End dates belong to ad sets.");
      if (change.end.getTime() <= Date.now()) throw new AdsError("The new end is in the past.");
      let funds: string | null = null;
      if (Number(row.daily_budget ?? 0) > 0 && live) {
        const extraDays = daysLeftThisMonth(ctx.adAccount.timezone, change.end.toISOString()) - daysLeftThisMonth(ctx.adAccount.timezone, row.end_time);
        if (extraDays > 0) {
          const extra = fromMinor(row.daily_budget, cur) * extraDays;
          const room = await checkCap(ctx, extra, `Running "${row.name}" longer`, signal);
          funds = fundsWarning(room.prepaid, room.committedTotal + extra, cur);
        }
      }
      await adsCall(ctx, "POST", `/${id}`, { end_time: metaTime(change.end) }, signal);
      return { adset: row.name, was: row.end_time ?? null, now: change.end.toISOString(), ...(funds ? { funds } : {}) };
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

const INSIGHT_FIELDS = [
  "spend",
  "impressions",
  "reach",
  "frequency",
  "inline_link_clicks",
  "inline_link_click_ctr",
  "cost_per_inline_link_click",
  "cpm",
  "actions",
  "video_thruplay_watched_actions",
];

const KEEP_ACTIONS = new Set(["link_click", "landing_page_view", "post_engagement", "post_reaction", "comment", "post", "onsite_conversion.post_save", "video_view", "like", "follow"]);

/** One insights row, with the actions people took narrowed to the ones that matter here. */
export function cleanInsight(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k === "actions" && Array.isArray(v)) {
      out.actions = Object.fromEntries(
        (v as { action_type: string; value: string }[]).filter((a) => KEEP_ACTIONS.has(a.action_type)).map((a) => [a.action_type, Number(a.value)]),
      );
    } else if (k === "video_thruplay_watched_actions" && Array.isArray(v)) {
      out.thruplays = Number((v as { value: string }[])[0]?.value ?? 0);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function insights(
  ctx: AdsContext,
  q: { level: "account" | Level; ids?: string[]; datePreset?: string; since?: string; until?: string; breakdowns?: string[]; daily?: boolean },
  signal?: AbortSignal,
) {
  const params: Record<string, unknown> = {
    level: q.level,
    fields: [...(q.level === "account" ? [] : [`${q.level === "adset" ? "adset" : q.level}_id`, `${q.level === "adset" ? "adset" : q.level}_name`]), ...INSIGHT_FIELDS].join(","),
    ...(q.since && q.until ? { time_range: { since: q.since, until: q.until } } : { date_preset: q.datePreset ?? "last_7d" }),
    ...(q.breakdowns?.length ? { breakdowns: q.breakdowns.join(",") } : {}),
    ...(q.daily ? { time_increment: 1 } : {}),
    ...(q.ids?.length && q.level !== "account" ? { filtering: [{ field: `${q.level}.id`, operator: "IN", value: q.ids }] } : {}),
  };
  const rows = await graphList<Record<string, unknown>>(`/${ctx.adAccount.id}/insights`, params, ctx.token, 500, signal).catch((err: unknown) => {
    if (err instanceof MetaError) throw new AdsError(err.message);
    throw err;
  });
  return rows.map(cleanInsight);
}

export async function campaignsOverview(ctx: AdsContext, signal?: AbortSignal) {
  const cur = ctx.adAccount.currency;
  const campaigns = await graphList<Record<string, string>>(
    `/${ctx.adAccount.id}/campaigns`,
    {
      fields: "id,name,objective,effective_status,daily_budget,lifetime_budget,budget_remaining,start_time,stop_time,created_time",
      effective_status: ["ACTIVE", "PAUSED", "IN_PROCESS", "WITH_ISSUES"],
    },
    ctx.token,
    50,
    signal,
  ).catch((err: unknown) => {
    if (err instanceof MetaError) throw new AdsError(err.message);
    throw err;
  });
  const stats = await insights(ctx, { level: "campaign", datePreset: "last_30d" }, signal).catch(() => []);
  const byId = new Map(stats.map((s) => [String(s.campaign_id), s]));
  return campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    objective: c.objective,
    status: c.effective_status,
    ...(Number(c.lifetime_budget ?? 0) > 0 ? { lifetimeBudget: money(fromMinor(c.lifetime_budget, cur), cur), left: money(fromMinor(c.budget_remaining, cur), cur) } : {}),
    ...(Number(c.daily_budget ?? 0) > 0 ? { dailyBudget: money(fromMinor(c.daily_budget, cur), cur) } : {}),
    created: c.created_time,
    last30Days: byId.get(c.id) ?? null,
  }));
}

export function accountLine(ctx: AdsContext) {
  return {
    id: ctx.adAccount.id,
    name: ctx.adAccount.name,
    currency: ctx.adAccount.currency,
    timezone: ctx.adAccount.timezone,
    status: ACCOUNT_STATUS[ctx.adAccount.status] ?? `status ${ctx.adAccount.status}`,
    page: ctx.page.name,
    instagram: ctx.page.instagram ? `@${ctx.page.instagram.username}` : null,
  };
}
