import "server-only";

import { Type } from "@paribelle/pi-ai";

import { STORE_VENDOR_ID } from "../store";
import { call, enabled, getProduct, rehost, slugify } from "./store";
import { defineTool, ToolError, type ToolContext } from "./types";
import { plural, StringEnum } from "./util";

/**
 * paribelle.in's admin, screen by screen, for Seelie: the shop's settings, footer,
 * business details and policies (store_settings), its custom pages (store_pages),
 * categories and their filters (store_categories) and HSN codes (store_hsn). Each
 * reads and writes exactly what the admin screen does, through the same API routes;
 * products and the homepage hero have their own tools in store.ts. Every change is a
 * "store" call, so it always asks.
 */

const SITE = "https://paribelle.in";

/** A photo for the store: a URL, chat:N or asset:N, moved onto the store's image host. */
async function hosted(ref: string, ctx: ToolContext) {
  return (await rehost([ref], ctx)).get(ref) ?? ref;
}

const clean = (s: string | undefined) => (s === undefined ? undefined : s.trim());

/* -------------------------------------------------------------------------- */
/* store_settings                                                             */
/* -------------------------------------------------------------------------- */

/** The admin's Store settings screen: settings keys, with the descriptions it saves them under. */
const SHOP_KEYS = {
  name: { key: "marketplace_name", description: "Store name shown in the header, at checkout and on invoices" },
  logo: { key: "marketplace_logo", description: "Store logo URL" },
  exchangeWindowDays: { key: "exchange_window_days", description: "Days after delivery a customer can ask for an exchange" },
  exchangeCourierCharge: {
    key: "exchange_courier_charge",
    description: "Flat courier charge for sending an exchange replacement out. 0 disables the charge.",
  },
  thumbnailLayout: { key: "thumbnailLayout", description: 'Product photo thumbnails: "vertical" (beside the photo) or "horizontal" (under it)' },
} as const;

const SOCIAL = ["instagram", "facebook", "youtube", "twitter", "linkedin"] as const;

const BUSINESS = ["storeName", "businessName", "gstNumber", "panNumber", "contactEmail", "contactPhone", "address", "city", "state", "postalCode"] as const;

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN = /^[A-Z]{5}\d{4}[A-Z]$/;

interface FooterSettings {
  aboutText?: string;
  socialLinks?: { platform: string; url: string; enabled?: boolean }[];
  customSections?: unknown[];
  contactInfo?: { phone?: string; email?: string; address?: string };
  copyrightText?: string;
  showCategories?: boolean;
  maxCategoriesDisplay?: number;
}

interface ReturnPolicy {
  enabled: boolean;
  days?: number;
  text: string;
}
interface CancellationPolicy {
  enabled: boolean;
  text: string;
}

type Vendor = Record<string, unknown> & { returnPolicy?: ReturnPolicy | null; cancellationPolicy?: CancellationPolicy | null };

async function readVendor(): Promise<Vendor> {
  const res = await call<Vendor & { data?: Vendor }>("GET", `/vendors/${STORE_VENDOR_ID}`);
  return (res?.data ?? res ?? {}) as Vendor;
}

/** A public setting's value, or null when it isn't set. */
async function publicSetting(key: string) {
  const res = await call<{ value?: unknown } | null>("GET", `/settings/${key}`).catch(() => null);
  return res?.value ?? null;
}

async function readSettings() {
  const [list, footer, vendor, defaultReturns, defaultCancellation] = await Promise.all([
    call<{ key: string; value: unknown }[]>("GET", "/settings/admin/all"),
    call<FooterSettings | null>("GET", "/footer-settings"),
    readVendor(),
    publicSetting("return_policy"),
    publicSetting("cancellation_policy"),
  ]);
  const get = (k: string) => (list ?? []).find((s) => s.key === k)?.value;
  const footerSocial = Object.fromEntries((footer?.socialLinks ?? []).filter((l) => l.url && l.enabled !== false).map((l) => [l.platform.toLowerCase(), l.url]));
  return {
    footer: footer ?? {},
    vendor,
    view: {
      shop: {
        name: String(get("marketplace_name") ?? "PariBelle"),
        logo: (get("marketplace_logo") as string) || null,
        exchangeWindowDays: Number(get("exchange_window_days") ?? 7),
        exchangeCourierCharge: Number(get("exchange_courier_charge") ?? 0),
        thumbnailLayout: get("thumbnailLayout") === "horizontal" ? "horizontal" : "vertical",
      },
      footer: {
        about: footer?.aboutText || null,
        email: footer?.contactInfo?.email || null,
        phone: footer?.contactInfo?.phone || null,
        address: footer?.contactInfo?.address || null,
        copyright: footer?.copyrightText || null,
        social: footerSocial,
        note: "Empty fields show the footer's built-in wording.",
      },
      business: Object.fromEntries(BUSINESS.map((f) => [f, vendor[f] == null ? null : String(vendor[f])])),
      policies: {
        returns: vendor.returnPolicy ?? { shopDefault: defaultReturns },
        cancellation: vendor.cancellationPolicy ?? { shopDefault: defaultCancellation },
      },
    },
  };
}

const ReturnPolicySchema = Type.Object({
  enabled: Type.Boolean(),
  days: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
  text: Type.String(),
});
const CancellationPolicySchema = Type.Object({ enabled: Type.Boolean(), text: Type.String() });

export const storeSettings = defineTool({
  name: "store_settings",
  label: "paribelle.in settings",
  description: [
    "Read or change what paribelle.in's admin configures outside products, pages and categories:",
    "shop (store name, logo, exchange window days, exchange courier charge, product thumbnail layout),",
    "footer (about line, contact email/phone/address, social links, copyright),",
    "business (the seller details printed on every invoice: legal name, GSTIN, PAN, address, pincode),",
    "and policies (returns and cancellation; null goes back to the shop default).",
    "With no groups it reads everything. Give only the fields to change.",
  ].join(" "),
  parameters: Type.Object({
    shop: Type.Optional(
      Type.Object({
        name: Type.Optional(Type.String()),
        logo: Type.Optional(Type.String({ description: "A URL, chat:N or asset:N (moved onto the store's image host); empty removes it." })),
        exchangeWindowDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 60 })),
        exchangeCourierCharge: Type.Optional(Type.Number({ minimum: 0, description: "Rupees; 0 means free." })),
        thumbnailLayout: Type.Optional(StringEnum(["vertical", "horizontal"])),
      }),
    ),
    footer: Type.Optional(
      Type.Object({
        about: Type.Optional(Type.String()),
        email: Type.Optional(Type.String()),
        phone: Type.Optional(Type.String()),
        address: Type.Optional(Type.String()),
        copyright: Type.Optional(Type.String()),
        social: Type.Optional(
          Type.Record(Type.String(), Type.String(), { description: `Platform to URL (${SOCIAL.join(", ")}); an empty URL removes that link. Others are kept.` }),
        ),
      }),
    ),
    business: Type.Optional(
      Type.Object({
        storeName: Type.Optional(Type.String()),
        businessName: Type.Optional(Type.String({ description: "The legal name." })),
        gstNumber: Type.Optional(Type.String()),
        panNumber: Type.Optional(Type.String()),
        contactEmail: Type.Optional(Type.String()),
        contactPhone: Type.Optional(Type.String()),
        address: Type.Optional(Type.String({ description: "Where goods ship from." })),
        city: Type.Optional(Type.String()),
        state: Type.Optional(Type.String()),
        postalCode: Type.Optional(Type.String()),
      }),
    ),
    policies: Type.Optional(
      Type.Object({
        returns: Type.Optional(Type.Union([ReturnPolicySchema, Type.Null()], { description: "null: use the shop default." })),
        cancellation: Type.Optional(Type.Union([CancellationPolicySchema, Type.Null()], { description: "null: use the shop default." })),
      }),
    ),
  }),
  kind: (a) => (a.shop || a.footer || a.business || a.policies ? "store" : "read"),
  ownerOnly: true,
  enabled,
  summary: (a) => {
    const parts: string[] = [];
    for (const [group, value] of Object.entries({ shop: a.shop, footer: a.footer, business: a.business, policies: a.policies })) {
      if (!value) continue;
      const fields = Object.entries(value).map(([k, v]) => `${k} ${v === null ? "to the shop default" : JSON.stringify(v).slice(0, 80)}`);
      parts.push(`${group}: ${fields.join(", ")}`);
    }
    return parts.length ? `paribelle.in ${parts.join("; ")}` : "paribelle.in's settings";
  },
  async execute(a, ctx) {
    const current = await readSettings();
    if (!a.shop && !a.footer && !a.business && !a.policies) return { data: current.view };

    // Everything is checked before anything is saved.
    if (a.shop?.name !== undefined && !a.shop.name.trim()) throw new ToolError("The store needs a name. Nothing was changed.");
    const biz = a.business ?? {};
    const gst = clean(biz.gstNumber)?.toUpperCase();
    const pan = clean(biz.panNumber)?.toUpperCase();
    if (gst && !GSTIN.test(gst)) throw new ToolError(`${gst} isn't a 15-character GSTIN. Nothing was changed.`);
    if (pan && !PAN.test(pan)) throw new ToolError(`${pan} isn't a PAN (5 letters, 4 digits, 1 letter). Nothing was changed.`);
    if (biz.postalCode && !/^\d{6}$/.test(biz.postalCode.trim())) throw new ToolError("A pincode is 6 digits. Nothing was changed.");
    if (biz.storeName !== undefined && !biz.storeName.trim()) throw new ToolError("The business needs a store name. Nothing was changed.");
    const unknownSocial = Object.keys(a.footer?.social ?? {}).filter((p) => !SOCIAL.includes(p.toLowerCase() as (typeof SOCIAL)[number]));
    if (unknownSocial.length) throw new ToolError(`The footer has links for ${SOCIAL.join(", ")} only, not ${unknownSocial.join(", ")}. Nothing was changed.`);

    const done: string[] = [];

    if (a.shop) {
      for (const [field, spec] of Object.entries(SHOP_KEYS) as [keyof typeof SHOP_KEYS, (typeof SHOP_KEYS)[keyof typeof SHOP_KEYS]][]) {
        let value: unknown = a.shop[field];
        if (value === undefined) continue;
        if (field === "logo" && typeof value === "string" && value.trim()) value = await hosted(value.trim(), ctx);
        if (field === "name") value = String(value).trim();
        ctx.progress(`Saving ${field}…`);
        await call("PUT", `/settings/${spec.key}`, { body: { value, description: spec.description }, signal: ctx.signal });
        done.push(`shop ${field}: ${field === "logo" && !value ? "removed" : String(value)}`);
      }
    }

    if (a.footer) {
      const f = a.footer;
      const raw = current.footer;
      const social = new Map((raw.socialLinks ?? []).filter((l) => l.url && l.enabled !== false).map((l) => [l.platform.toLowerCase(), l.url]));
      for (const [platform, url] of Object.entries(f.social ?? {})) {
        if (url.trim()) social.set(platform.toLowerCase(), url.trim());
        else social.delete(platform.toLowerCase());
      }
      ctx.progress("Saving the footer…");
      await call("PUT", "/footer-settings", {
        body: {
          aboutText: clean(f.about) ?? raw.aboutText ?? "",
          contactInfo: {
            email: clean(f.email) ?? raw.contactInfo?.email ?? "",
            phone: clean(f.phone) ?? raw.contactInfo?.phone ?? "",
            address: clean(f.address) ?? raw.contactInfo?.address ?? "",
          },
          socialLinks: SOCIAL.filter((p) => social.has(p)).map((p) => ({ platform: p, url: social.get(p)!, enabled: true })),
          copyrightText: clean(f.copyright) ?? raw.copyrightText ?? "",
          // Not shown by the footer any more, sent back as they were (as the admin does).
          customSections: raw.customSections ?? [],
          showCategories: raw.showCategories ?? true,
          maxCategoriesDisplay: raw.maxCategoriesDisplay ?? 6,
        },
        signal: ctx.signal,
      });
      done.push(`footer: ${Object.keys(f).join(", ")} saved`);
    }

    if (a.business) {
      const body: Record<string, string> = {};
      for (const field of BUSINESS) {
        const v = biz[field];
        if (v === undefined) continue;
        body[field] = field === "gstNumber" ? gst! : field === "panNumber" ? pan! : v.trim();
      }
      if (Object.keys(body).length) {
        ctx.progress("Saving the business details…");
        await call("PATCH", `/vendors/${STORE_VENDOR_ID}`, { body, signal: ctx.signal });
        done.push(`business: ${Object.entries(body).map(([k, v]) => `${k} ${v}`).join(", ")} (on invoices from now on)`);
      }
    }

    if (a.policies && (a.policies.returns !== undefined || a.policies.cancellation !== undefined)) {
      const p = a.policies;
      ctx.progress("Saving the policies…");
      await call("PATCH", `/vendors/${STORE_VENDOR_ID}/policies`, {
        body: {
          returnPolicy: p.returns !== undefined ? p.returns : (current.vendor.returnPolicy ?? null),
          cancellationPolicy: p.cancellation !== undefined ? p.cancellation : (current.vendor.cancellationPolicy ?? null),
        },
        signal: ctx.signal,
      });
      if (p.returns !== undefined) done.push(`returns policy: ${p.returns ? `${p.returns.enabled ? "on" : "off"}${p.returns.days ? `, ${p.returns.days} days` : ""}` : "shop default"}`);
      if (p.cancellation !== undefined) done.push(`cancellation policy: ${p.cancellation ? (p.cancellation.enabled ? "on" : "off") : "shop default"}`);
    }

    return { text: `${done.join("\n")}\nLive on paribelle.in now (visitors may see the old version for a few minutes).` };
  },
});

/* -------------------------------------------------------------------------- */
/* store_pages                                                                */
/* -------------------------------------------------------------------------- */

interface StorePage {
  id: string;
  title: string;
  slug: string;
  pageType: string;
  status: string;
  content: string;
  excerpt?: string | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  metaKeywords?: string | null;
  showInNavigation?: boolean;
  updatedAt?: string;
}

interface PageSection {
  id: string;
  type: string;
  title: string;
  settings: Record<string, unknown>;
  order: number;
  visible: boolean;
}

/** The admin's page builder's sections and their settings (marketplace-web src/lib/pageSections.ts). */
const SECTION_TYPES = [
  "hero: headline, subheadline, buttonText, buttonLink, backgroundImage, backgroundColor, textColor, alignment (left|center|right), height (small|medium|large)",
  "features: title, subtitle, features [{icon, title, description}], columns, backgroundColor",
  "content: title, content (markdown), image, imagePosition (left|right), backgroundColor",
  "gallery: title, images [{url, alt}], columns, spacing (small|medium|large)",
  "testimonials: title, subtitle, testimonials [{name, text, rating, avatar}], showRating, backgroundColor",
  "faq: title, subtitle, faqs [{question, answer}]",
  "team: title, subtitle, members [{name, role, bio, photo}], columns",
  "stats: title, stats [{number, label}], backgroundColor, textColor",
  "cta: headline, description, buttonText, buttonLink, backgroundColor, textColor",
  "contact: title, subtitle, email, phone, address, showMap, mapUrl",
  "textBlock: heading, headingLevel (h2|h3), content (markdown), backgroundColor, textColor, padding (small|normal|large)",
  "list: title, listType (bullet|numbered|icon), items [string], icon, backgroundColor",
  "table: title, headers [string], rows [[string]], striped, bordered",
  "alert: type (info|success|warning|error), title, message, icon",
  "accordion: title, items [{title, content}], defaultExpanded, backgroundColor",
  "divider: style (line|dashed|dotted|text), thickness, color, spacing, text",
  "lastUpdated: date (YYYY-MM-DD), prefix, alignment, backgroundColor",
  "lookbook-hero: title, subtitle, image, ctaText, ctaLink, height",
  "shoppable-image: image, alt, caption, hotspots [{x, y (percent 0-100), productId}]",
];
const SECTION_NAMES = SECTION_TYPES.map((s) => s.slice(0, s.indexOf(":")));

const SectionSchema = Type.Object({
  type: StringEnum(SECTION_NAMES as unknown as readonly [string, ...string[]]),
  title: Type.Optional(Type.String({ description: "The section's name in the admin's builder." })),
  settings: Type.Record(Type.String(), Type.Unknown()),
  visible: Type.Optional(Type.Boolean()),
});

const PAGE_TYPES = ["custom", "about", "contact", "faq", "terms", "privacy", "cookie", "blog"] as const;

async function allPages(): Promise<StorePage[]> {
  const res = await call<StorePage[] | { data?: StorePage[] }>("GET", "/marketplace/pages", { query: { includeUnpublished: "true" } });
  return Array.isArray(res) ? res : (res?.data ?? []);
}

async function findPage(ref: string): Promise<StorePage> {
  const key = ref.trim().replace(/^https?:\/\/(www\.)?paribelle\.in\//, "").replace(/^\//, "").toLowerCase();
  const page = (await allPages()).find((p) => p.id === ref.trim() || p.slug.toLowerCase() === key);
  if (!page) throw new ToolError(`paribelle.in has no page "${ref}". store_pages list shows them.`);
  return page;
}

function sectionsOf(page: StorePage): PageSection[] | null {
  try {
    const parsed = JSON.parse(page.content) as unknown;
    return Array.isArray(parsed) ? (parsed as PageSection[]) : null;
  } catch {
    return null;
  }
}

const pageLine = (p: StorePage) => ({
  id: p.id,
  title: p.title,
  url: `${SITE}/${p.slug}`,
  type: p.pageType,
  status: p.status,
  inNavigation: !!p.showInNavigation,
  updated: p.updatedAt?.slice(0, 10) ?? null,
});

/** chat:N and asset:N anywhere in a section's settings, moved onto the store's image host. */
async function hostSectionImages(sections: { settings: Record<string, unknown> }[], ctx: ToolContext) {
  const refs = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (/^(chat|asset):\S+$/.test(v.trim())) refs.add(v.trim());
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  sections.forEach((s) => walk(s.settings));
  if (!refs.size) return;
  const urls = await rehost([...refs], ctx);
  const swap = (v: unknown): unknown => {
    if (typeof v === "string") return urls.get(v.trim()) ?? v;
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
    return v;
  };
  for (const s of sections) s.settings = swap(s.settings) as Record<string, unknown>;
}

function toSections(input: { type: string; title?: string; settings: Record<string, unknown>; visible?: boolean }[]): PageSection[] {
  return input.map((s, i) => ({
    id: `section-${Date.now()}-${i}`,
    type: s.type,
    title: s.title?.trim() || s.type,
    settings: s.settings,
    order: i,
    visible: s.visible ?? true,
  }));
}

export const storePages = defineTool({
  name: "store_pages",
  label: "paribelle.in pages",
  description: [
    "paribelle.in's own pages (About, FAQ, Contact, Terms, Privacy, lookbooks, any custom page), at paribelle.in/<slug>, built from sections like the admin's page builder.",
    "list: every page with its status. read: one page's sections and settings. create / update: a page (sections replace the page's whole list, so read it first and send it back changed).",
    "delete: a page. status draft hides it, published shows it.",
    `Section types and their settings: ${SECTION_TYPES.join("; ")}.`,
    "Images in settings take a URL, chat:N or asset:N (moved onto the store's image host). Write copy in the shop's voice: warm, plain, short.",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["list", "read", "create", "update", "delete"]),
    page: Type.Optional(Type.String({ description: "read, update, delete: the page's id, slug or URL." })),
    title: Type.Optional(Type.String()),
    slug: Type.Optional(Type.String({ description: "create: from the title when left out." })),
    pageType: Type.Optional(StringEnum(PAGE_TYPES)),
    status: Type.Optional(StringEnum(["draft", "published", "archived"], { description: "create: draft unless told to publish." })),
    sections: Type.Optional(Type.Array(SectionSchema, { maxItems: 40 })),
    excerpt: Type.Optional(Type.String()),
    metaTitle: Type.Optional(Type.String()),
    metaDescription: Type.Optional(Type.String()),
    showInNavigation: Type.Optional(Type.Boolean()),
  }),
  kind: (a) => (a.action === "list" || a.action === "read" ? "read" : "store"),
  ownerOnly: true,
  enabled,
  summary: (a) => {
    if (a.action === "list") return "paribelle.in's pages";
    if (a.action === "read") return `Read ${a.page ?? "a page"}`;
    const what = [
      a.title && `title "${a.title}"`,
      a.slug && `at /${a.slug}`,
      a.sections && plural(a.sections.length, "section"),
      a.status && a.status,
      a.showInNavigation !== undefined && (a.showInNavigation ? "in the menu" : "not in the menu"),
    ].filter(Boolean);
    if (a.action === "create") return `New page${what.length ? `: ${what.join(", ")}` : ""}`;
    if (a.action === "delete") return `Delete the page ${a.page}`;
    return `Change the page ${a.page}${what.length ? `: ${what.join(", ")}` : ""}`;
  },
  async execute(a, ctx) {
    if (a.action === "list") return { data: (await allPages()).map(pageLine) };

    if (a.action === "read") {
      if (!a.page) throw new ToolError("Which page? Give its id, slug or URL.");
      const page = await findPage(a.page);
      const sections = sectionsOf(page);
      return {
        data: {
          ...pageLine(page),
          excerpt: page.excerpt ?? null,
          metaTitle: page.metaTitle ?? null,
          metaDescription: page.metaDescription ?? null,
          ...(sections ? { sections: sections.map(({ type, title, settings, visible }) => ({ type, title, settings, visible })) } : { content: page.content }),
        },
      };
    }

    if (a.action === "delete") {
      if (!a.page) throw new ToolError("Which page? Give its id, slug or URL.");
      const page = await findPage(a.page);
      await call("DELETE", `/marketplace/pages/${page.id}`, { signal: ctx.signal });
      return { text: `Deleted "${page.title}" (${SITE}/${page.slug}).` };
    }

    const sections = a.sections ? toSections(a.sections) : undefined;
    if (sections) await hostSectionImages(sections, ctx);
    const fields = {
      ...(a.title !== undefined ? { title: a.title.trim() } : {}),
      ...(a.pageType ? { pageType: a.pageType } : {}),
      ...(a.status ? { status: a.status } : {}),
      ...(sections ? { content: JSON.stringify(sections) } : {}),
      ...(a.excerpt !== undefined ? { excerpt: a.excerpt } : {}),
      ...(a.metaTitle !== undefined ? { metaTitle: a.metaTitle } : {}),
      ...(a.metaDescription !== undefined ? { metaDescription: a.metaDescription } : {}),
      ...(a.showInNavigation !== undefined ? { showInNavigation: a.showInNavigation } : {}),
    };

    if (a.action === "create") {
      if (!a.title?.trim()) throw new ToolError("A new page needs a title.");
      if (!sections?.length) throw new ToolError("A new page needs at least one section.");
      const slug = slugify(a.slug || a.title);
      if ((await allPages()).some((p) => p.slug === slug)) throw new ToolError(`paribelle.in already has a page at /${slug}. Update it, or pick another slug.`);
      const created = await call<StorePage>("POST", "/marketplace/pages", {
        body: { pageType: "custom", status: "draft", ...fields, slug },
        signal: ctx.signal,
      });
      return { text: `Made "${created.title}" at ${SITE}/${created.slug} (${created.status}).`, data: pageLine(created) };
    }

    if (!a.page) throw new ToolError("Which page? Give its id, slug or URL.");
    const page = await findPage(a.page);
    const body = { ...fields, ...(a.slug ? { slug: slugify(a.slug) } : {}) };
    if (!Object.keys(body).length) throw new ToolError("Nothing to change on that page.");
    const saved = await call<StorePage>("PUT", `/marketplace/pages/${page.id}`, { body, signal: ctx.signal });
    const after = saved?.slug ? saved : { ...page, ...body };
    return { text: `Saved "${after.title}" at ${SITE}/${after.slug} (${after.status}).`, data: pageLine(after as StorePage) };
  },
});

/* -------------------------------------------------------------------------- */
/* store_categories                                                           */
/* -------------------------------------------------------------------------- */

interface StoreCategory {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  image?: string | null;
  isActive: boolean;
  sortOrder: number;
  featuredProductId?: string | null;
  featuredImageUrl?: string | null;
  metaTitle?: string | null;
  metaDescription?: string | null;
  parent?: { id: string; name: string } | null;
  children?: StoreCategory[];
  filterConfig?: { filters?: { id: string; label?: string; hidden?: boolean; sortOrder?: number }[] } | null;
}

async function categoryTree(): Promise<StoreCategory[]> {
  return (await call<StoreCategory[]>("GET", "/categories/tree/all")) ?? [];
}

function flatten(tree: StoreCategory[], parent: StoreCategory | null = null): (StoreCategory & { parentName: string | null })[] {
  return tree.flatMap((c) => [{ ...c, parentName: parent?.name ?? null }, ...flatten(c.children ?? [], c)]);
}

async function findCategory(ref: string) {
  const all = flatten(await categoryTree());
  const key = ref.trim().toLowerCase();
  const hit = all.find((c) => c.id === ref.trim() || c.slug === key || c.name.toLowerCase() === key);
  if (!hit) throw new ToolError(`paribelle.in has no category "${ref}". It has: ${all.map((c) => c.name).join(", ")}.`);
  return hit;
}

const categoryLine = (c: StoreCategory & { parentName: string | null }) => ({
  id: c.id,
  name: c.name,
  url: `${SITE}/category/${c.slug}`,
  parent: c.parentName,
  active: c.isActive,
  sortOrder: c.sortOrder,
  description: c.description || null,
  image: c.image || null,
  featuredImage: c.featuredImageUrl || null,
});

const CategoryFields = {
  name: Type.Optional(Type.String()),
  slug: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  parent: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "The parent category's name, slug or id; null makes it top level." })),
  image: Type.Optional(Type.String({ description: "The category's tile photo: a URL, chat:N or asset:N." })),
  featuredProduct: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "A product id or slug the category features." })),
  featuredImage: Type.Optional(Type.String({ description: "The category page's banner photo: a URL, chat:N or asset:N." })),
  active: Type.Optional(Type.Boolean()),
  sortOrder: Type.Optional(Type.Integer()),
  metaTitle: Type.Optional(Type.String()),
  metaDescription: Type.Optional(Type.String()),
};

export const storeCategories = defineTool({
  name: "store_categories",
  label: "paribelle.in categories",
  description: [
    "paribelle.in's categories (the shop's menu and /category/<slug> pages) and their filters.",
    "list: every category with its parent, order and photos. create / update / delete: a category (delete only an empty one).",
    "filters: without filters, the filters shoppers see on that category (worked out from the products' attributes) and their labels;",
    "with filters, their order, labels and which are hidden (only ids from the list).",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["list", "create", "update", "delete", "filters"]),
    category: Type.Optional(Type.String({ description: "update, delete, filters: its name, slug or id." })),
    ...CategoryFields,
    filters: Type.Optional(
      Type.Array(
        Type.Object({ id: Type.String(), label: Type.Optional(Type.String()), hidden: Type.Optional(Type.Boolean()) }),
        { description: "filters: every filter in the order shoppers should see them." },
      ),
    ),
  }),
  kind: (a) => (a.action === "list" || (a.action === "filters" && !a.filters) ? "read" : "store"),
  ownerOnly: true,
  enabled,
  summary: (a) => {
    if (a.action === "list") return "paribelle.in's categories";
    if (a.action === "filters") return a.filters ? `${a.category} filters: ${a.filters.map((f) => `${f.label ?? f.id}${f.hidden ? " (hidden)" : ""}`).join(", ")}` : `${a.category}'s filters`;
    if (a.action === "delete") return `Delete the category ${a.category}`;
    const what = Object.entries(a)
      .filter(([k, v]) => !["action", "category", "filters"].includes(k) && v !== undefined)
      .map(([k, v]) => `${k} ${JSON.stringify(v).slice(0, 60)}`);
    return `${a.action === "create" ? "New category" : `Change ${a.category}`}: ${what.join(", ")}`;
  },
  async execute(a, ctx) {
    if (a.action === "list") return { data: flatten(await categoryTree()).map(categoryLine) };

    if (a.action === "filters") {
      if (!a.category) throw new ToolError("Which category?");
      const cat = await findCategory(a.category);
      const suggested = await call<{ filters: { id: string; label: string; options?: { label: string; productCount: number }[] }[] }>("GET", `/categories/${cat.id}/filter-suggestions`);
      const full = await call<StoreCategory>("GET", `/categories/${cat.id}`);
      const overrides = new Map((full.filterConfig?.filters ?? []).map((f) => [f.id, f]));
      const current = (suggested.filters ?? [])
        .map((s, i) => ({
          id: s.id,
          label: overrides.get(s.id)?.label || s.label,
          hidden: overrides.get(s.id)?.hidden ?? false,
          order: overrides.get(s.id)?.sortOrder ?? 1000 + i,
          values: (s.options ?? []).slice(0, 8).map((o) => `${o.label} (${o.productCount})`),
        }))
        .sort((x, y) => x.order - y.order);
      if (!a.filters) return { data: { category: cat.name, filters: current.map(({ order: _o, ...f }) => f) } };

      const known = new Set(current.map((f) => f.id));
      const unknown = a.filters.filter((f) => !known.has(f.id)).map((f) => f.id);
      if (unknown.length) throw new ToolError(`${cat.name} has no filter ${unknown.join(", ")}. Its filters: ${[...known].join(", ")}. Nothing was changed.`);
      const given = new Set(a.filters.map((f) => f.id));
      const order = [...a.filters, ...current.filter((f) => !given.has(f.id)).map((f) => ({ id: f.id, label: f.label, hidden: f.hidden }))];
      await call("PUT", `/categories/${cat.id}/filters`, {
        body: {
          filters: order.map((f, i) => ({
            id: f.id,
            label: f.label?.trim() || current.find((c) => c.id === f.id)!.label,
            sortOrder: i,
            hidden: f.hidden ?? current.find((c) => c.id === f.id)!.hidden,
          })),
        },
        signal: ctx.signal,
      });
      return { text: `Saved ${cat.name}'s filters.` };
    }

    if (a.action === "delete") {
      if (!a.category) throw new ToolError("Which category?");
      const cat = await findCategory(a.category);
      if (cat.children?.length) throw new ToolError(`${cat.name} has subcategories (${cat.children.map((c) => c.name).join(", ")}). Move or delete them first.`);
      await call("DELETE", `/categories/${cat.id}`, { signal: ctx.signal });
      return { text: `Deleted the category ${cat.name}.` };
    }

    const body: Record<string, unknown> = {};
    if (a.name !== undefined) body.name = a.name.trim();
    if (a.slug !== undefined) body.slug = slugify(a.slug);
    if (a.description !== undefined) body.description = a.description;
    if (a.active !== undefined) body.isActive = a.active;
    if (a.sortOrder !== undefined) body.sortOrder = a.sortOrder;
    if (a.metaTitle !== undefined) body.metaTitle = a.metaTitle;
    if (a.metaDescription !== undefined) body.metaDescription = a.metaDescription;
    if (a.parent !== undefined) body.parentId = a.parent === null ? null : (await findCategory(a.parent)).id;
    if (a.featuredProduct !== undefined) body.featuredProductId = a.featuredProduct === null ? null : (await getProduct(a.featuredProduct)).id;
    if (a.image !== undefined) body.image = a.image.trim() ? await hosted(a.image.trim(), ctx) : null;
    if (a.featuredImage !== undefined) body.featuredImageUrl = a.featuredImage.trim() ? await hosted(a.featuredImage.trim(), ctx) : null;

    if (a.action === "create") {
      if (!a.name?.trim()) throw new ToolError("A new category needs a name.");
      body.slug ??= slugify(a.name);
      body.isActive ??= true;
      const created = await call<StoreCategory>("POST", "/categories", { body, signal: ctx.signal });
      return { text: `Made the category ${created.name} at ${SITE}/category/${created.slug}.` };
    }

    if (!a.category) throw new ToolError("Which category?");
    if (!Object.keys(body).length) throw new ToolError("Nothing to change on that category.");
    const cat = await findCategory(a.category);
    if (body.parentId === cat.id) throw new ToolError("A category can't be its own parent.");
    await call("PUT", `/categories/${cat.id}`, { body, signal: ctx.signal });
    return { text: `Saved ${String(body.name ?? cat.name)}.` };
  },
});

/* -------------------------------------------------------------------------- */
/* store_hsn                                                                  */
/* -------------------------------------------------------------------------- */

interface HsnCode {
  id: string;
  code: string;
  description: string;
  recommendedGstRate: string | number;
  category: string | null;
  isActive: boolean;
}

const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28];

export const storeHsn = defineTool({
  name: "store_hsn",
  label: "paribelle.in HSN codes",
  description:
    "paribelle.in's HSN codes and their GST rates (the admin's HSN & GST screen), which products and invoices use. list (optionally search by code or words), create, update (description, rate, category) or delete a code. Needs a super admin sign-in.",
  parameters: Type.Object({
    action: StringEnum(["list", "create", "update", "delete"]),
    search: Type.Optional(Type.String()),
    code: Type.Optional(Type.String({ description: "create, update, delete: the HSN code (4 to 8 digits)." })),
    description: Type.Optional(Type.String()),
    gstRate: Type.Optional(Type.Number({ description: `Percent: ${GST_RATES.join(", ")}.` })),
    category: Type.Optional(Type.String()),
  }),
  kind: (a) => (a.action === "list" ? "read" : "store"),
  ownerOnly: true,
  enabled,
  summary: (a) =>
    a.action === "list"
      ? `HSN codes${a.search ? ` matching ${a.search}` : ""}`
      : `${a.action === "create" ? "Add" : a.action === "delete" ? "Delete" : "Change"} HSN ${a.code}${a.gstRate !== undefined ? ` at ${a.gstRate}% GST` : ""}${a.description ? `: ${a.description}` : ""}`,
  async execute(a, ctx) {
    if (a.action === "list") {
      const rows = await call<HsnCode[]>("GET", "/hsn-codes", { query: { search: a.search } });
      return { data: (rows ?? []).slice(0, 200).map((h) => ({ code: h.code, description: h.description, gstRate: Number(h.recommendedGstRate), category: h.category, active: h.isActive })) };
    }
    const code = a.code?.replace(/\s+/g, "");
    if (!code || !/^\d{4,8}$/.test(code)) throw new ToolError("An HSN code is 4 to 8 digits.");
    if (a.gstRate !== undefined && !GST_RATES.includes(a.gstRate)) throw new ToolError(`GST rates are ${GST_RATES.join(", ")} percent.`);

    if (a.action === "create") {
      if (!a.description?.trim() || a.gstRate === undefined) throw new ToolError("A new HSN code needs a description and a GST rate.");
      await call("POST", "/hsn-codes", { body: { code, description: a.description.trim(), gstRate: a.gstRate, category: a.category?.trim() || undefined }, signal: ctx.signal });
      return { text: `Added HSN ${code} at ${a.gstRate}% GST.` };
    }
    const existing = await call<HsnCode>("GET", `/hsn-codes/${code}`);
    if (a.action === "delete") {
      await call("DELETE", `/hsn-codes/${existing.id}`, { signal: ctx.signal });
      return { text: `Deleted HSN ${code}.` };
    }
    const body = {
      ...(a.description !== undefined ? { description: a.description.trim() } : {}),
      ...(a.gstRate !== undefined ? { gstRate: a.gstRate } : {}),
      ...(a.category !== undefined ? { category: a.category.trim() } : {}),
    };
    if (!Object.keys(body).length) throw new ToolError("Nothing to change on that code.");
    await call("PUT", `/hsn-codes/${existing.id}`, { body, signal: ctx.signal });
    return { text: `Saved HSN ${code}.` };
  },
});
