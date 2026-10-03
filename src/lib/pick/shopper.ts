import "server-only";

import { createHash } from "node:crypto";

import { storeApi, type Catalogue } from "./catalogue";

/**
 * Who's shopping, for Find Your Pick: a signed-in shopper's paribelle.in orders
 * (read with their own sign-in, which their browser sends along) and the wishlist
 * their browser keeps. Seelie builds on it: it knows their taste, so it says so,
 * and the more they've bought the more it has to go on. Nothing is stored; a
 * shopper's history is held in memory for a few minutes so a session's steps don't
 * each ask the API again. Guests, and any failure to read the history, get the
 * ordinary session.
 */

export interface ShopperPiece {
  productId: string;
  name: string;
  colour: string | null;
  size: string | null;
  price: number | null;
  /** YYYY-MM-DD */
  on: string;
  /** Sent back (a return or an exchange): a hint at what didn't work. */
  sentBack: boolean;
}

export interface Shopper {
  firstName: string | null;
  /** Orders that went through (not cancelled or failed). */
  orders: number;
  /** What they've bought, newest first. */
  pieces: ShopperPiece[];
  /** The sizes they buy, most often first. */
  sizes: string[];
  /** Pieces they've saved that the shop has in stock. */
  wishlist: { id: string; name: string; line: string }[];
}

type History = Omit<Shopper, "wishlist">;

const TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 6_000;
const MAX_PIECES = 24;

const cache: Map<string, { at: number; history: History | null }> = ((globalThis as { __pickShoppers?: Map<string, { at: number; history: History | null }> }).__pickShoppers ??=
  new Map());

const SKIP = new Set(["cancelled", "refunded"]);
const SENT_BACK = new Set(["requested", "approved", "in_transit", "received", "replacement_shipped", "completed", "refunded"]);

interface RawOrder {
  status?: string;
  paymentStatus?: string;
  createdAt?: string;
  items?: { id?: string; productId?: string; productName?: string; price?: string | number; variantDetails?: { attributes?: Record<string, string> | null } | null }[];
  returns?: { orderItemId?: string; status?: string }[];
}

const attr = (attrs: Record<string, string> | null | undefined, key: string) => {
  if (!attrs) return null;
  const hit = Object.keys(attrs).find((k) => k.toLowerCase() === key || (key === "colour" && k.toLowerCase() === "color"));
  return hit ? String(attrs[hit]) : null;
};

async function get<T>(path: string, token: string): Promise<T | null> {
  const res = await fetch(`${storeApi()}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

async function readHistory(token: string): Promise<History | null> {
  const [me, orders] = await Promise.all([
    get<{ firstName?: string | null; role?: string }>("/auth/me", token),
    get<RawOrder[] | { data?: RawOrder[] }>("/orders", token),
  ]);
  if (!me) return null;
  const list = Array.isArray(orders) ? orders : (orders?.data ?? []);
  const kept = list.filter((o) => !SKIP.has(o.status ?? "") && o.paymentStatus !== "failed");
  const pieces: ShopperPiece[] = [];
  for (const o of kept) {
    const back = new Set((o.returns ?? []).filter((r) => SENT_BACK.has(r.status ?? "")).map((r) => r.orderItemId));
    for (const it of o.items ?? []) {
      if (!it.productId || !it.productName) continue;
      const attrs = it.variantDetails?.attributes ?? null;
      pieces.push({
        productId: it.productId,
        name: it.productName,
        colour: attr(attrs, "colour"),
        size: attr(attrs, "size"),
        price: it.price != null ? Math.round(Number(it.price)) : null,
        on: (o.createdAt ?? "").slice(0, 10),
        sentBack: back.has(it.id),
      });
    }
  }
  pieces.sort((a, b) => b.on.localeCompare(a.on));
  const sizeCount = new Map<string, number>();
  for (const p of pieces) if (p.size && !p.sentBack) sizeCount.set(p.size, (sizeCount.get(p.size) ?? 0) + 1);
  return {
    firstName: me.firstName?.trim() || null,
    orders: kept.length,
    pieces: pieces.slice(0, MAX_PIECES),
    sizes: [...sizeCount.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s),
  };
}

/** The shopper's sign-in, when their browser sent one. */
export function tokenOf(request: Request) {
  const auth = request.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(\S{20,4096})$/i.exec(auth)?.[1];
  return token ?? null;
}

async function historyOf(token: string): Promise<History | null> {
  const key = createHash("sha256").update(token).digest("base64url");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.history;
  const history = await readHistory(token).catch((err) => {
    console.warn("[pick] a shopper's history couldn't be read:", err instanceof Error ? err.message : err);
    return null;
  });
  if (cache.size > 2000) cache.clear();
  cache.set(key, { at: Date.now(), history });
  return history;
}

/** Who's shopping, or null for a guest with nothing saved. */
export async function shopperOf(token: string | null, wishlistIds: string[], cat: Catalogue | null): Promise<Shopper | null> {
  const history = token ? await historyOf(token) : null;
  const wishlist = cat
    ? wishlistIds.flatMap((id) => {
        const item = cat.byId.get(id);
        return item ? [{ id, name: item.card.name, line: item.ref }] : [];
      })
    : [];
  if (!history && !wishlist.length) return null;
  return { firstName: history?.firstName ?? null, orders: history?.orders ?? 0, pieces: history?.pieces ?? [], sizes: history?.sizes ?? [], wishlist };
}

/** What the model reads about the shopper. */
export function shopperText(s: Shopper, cat: Catalogue | null) {
  const lines: string[] = [];
  if (s.firstName) lines.push(`Their first name: ${s.firstName}.`);
  if (s.orders) {
    lines.push(`They've ordered from PariBelle ${s.orders === 1 ? "once" : `${s.orders} times`}. What they bought, newest first:`);
    for (const p of s.pieces) {
      const ref = cat?.byId.get(p.productId)?.ref;
      lines.push(
        `- ${p.name}${ref ? ` (${ref})` : ""}${[p.colour, p.size && `size ${p.size}`].filter(Boolean).length ? `, ${[p.colour, p.size && `size ${p.size}`].filter(Boolean).join(", ")}` : ""}${p.price ? `, ₹${p.price}` : ""}, ${p.on}${p.sentBack ? ", sent back" : ""}`,
      );
    }
    if (s.sizes.length) lines.push(`Sizes they keep: ${s.sizes.join(", ")}.`);
  } else {
    lines.push("They haven't ordered yet.");
  }
  if (s.wishlist.length) lines.push(`Saved to their wishlist (in stock): ${s.wishlist.map((w) => `${w.name} (${w.line})`).join("; ")}.`);
  return lines.join("\n");
}
