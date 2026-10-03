import "server-only";

/**
 * paribelle.in's live products, as Find Your Pick reads them: the store's public
 * product list (no sign-in), cut down to what a stylist needs, cached for a few
 * minutes. Each product gets a short ref (p1, p2, ...) for the model to name it by,
 * which costs a fraction of a UUID's tokens and can't be half-copied.
 */

const TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 15_000;

/** The store's API, /api/v1 included. The product list is public, so the live one serves a dev machine too. */
export const storeApi = () => (process.env.PARIBELLE_API_URL?.trim() || "https://api.paribelle.in/api/v1").replace(/\/+$/, "");

interface RawVariant {
  variantAttributes: Record<string, string> | null;
  stockQuantity: number | null;
  isActive: boolean;
  images?: string[] | null;
}

interface RawProduct {
  id: string;
  name: string;
  slug: string;
  status: string;
  description?: string | null;
  price: string | number;
  compareAtPrice: string | number | null;
  stockQuantity: number;
  images: string[] | null;
  featuredImage: string | null;
  categories?: { name: string }[];
  attributes?: Record<string, string> | null;
  productVariants?: RawVariant[];
  salesCount?: number;
}

/** What a shopper is shown of a product. */
export interface ProductCard {
  id: string;
  slug: string;
  name: string;
  image: string | null;
  price: number;
  mrp: number | null;
}

export interface CatalogueItem {
  ref: string;
  card: ProductCard;
  style: string | null;
  fabric: string | null;
  occasion: string | null;
  colours: string[];
  /** Sizes with stock, smallest first. */
  sizes: string[];
  categories: string[];
  description: string;
  sold: number;
  /** The line the model reads. */
  line: string;
}

export interface Catalogue {
  items: CatalogueItem[];
  byRef: Map<string, CatalogueItem>;
  /** By the store's product id. */
  byId: Map<string, CatalogueItem>;
  /** Everything the model reads about the shop, one product a line. */
  text: string;
}

const SIZE_ORDER = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "2XL", "3XL", "XXXL", "4XL", "5XL", "Free Size"];
const sizeRank = (s: string) => {
  const i = SIZE_ORDER.indexOf(s.toUpperCase() === "FREE SIZE" ? "Free Size" : s.toUpperCase());
  return i === -1 ? 99 : i;
};

const money = (v: unknown) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const isVideo = (url: string) => /\.(mp4|mov|webm)(\?|#|$)/i.test(url) || /\/video\/upload\//.test(url);

/** The description's facts without the sales talk the listings came with: its first two sentences, at most 220 characters. */
function shortDescription(text: string | null | undefined) {
  const plain = (text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const sentences = plain.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ");
  return sentences.length > 220 ? `${sentences.slice(0, 217)}...` : sentences;
}

function toItem(p: RawProduct, ref: string): CatalogueItem {
  const variants = (p.productVariants ?? []).filter((v) => v.isActive !== false);
  const attr = (key: string) => {
    const own = p.attributes?.[key];
    if (own) return own;
    for (const v of variants) if (v.variantAttributes?.[key]) return v.variantAttributes[key];
    return null;
  };
  const colours = [...new Set(variants.map((v) => v.variantAttributes?.Colour).filter((c): c is string => !!c))];
  if (!colours.length && p.attributes?.Colour) colours.push(p.attributes.Colour);
  const inStock = variants.filter((v) => (v.stockQuantity ?? 0) > 0);
  const sizes = [...new Set(inStock.map((v) => v.variantAttributes?.Size).filter((s): s is string => !!s))].sort((a, b) => sizeRank(a) - sizeRank(b));
  const price = money(p.price) ?? 0;
  const mrp = money(p.compareAtPrice);
  const card: ProductCard = {
    id: p.id,
    slug: p.slug,
    name: p.name,
    image: p.featuredImage ?? p.images?.find((u) => !isVideo(u)) ?? null,
    price,
    mrp: mrp && mrp > price ? mrp : null,
  };
  const item = {
    ref,
    card,
    style: attr("Style"),
    fabric: attr("Fabric"),
    occasion: attr("Occasion"),
    colours,
    sizes,
    categories: (p.categories ?? []).map((c) => c.name),
    description: shortDescription(p.description),
    sold: p.salesCount ?? 0,
  };
  const facts = [item.style, item.fabric, item.occasion && `${item.occasion} wear`, attr("Sleeve")].filter(Boolean);
  const line = [
    ref,
    p.name,
    `₹${price}${card.mrp ? ` (MRP ₹${card.mrp})` : ""}`,
    facts.join(", "),
    colours.length ? `colours: ${colours.join(", ")}` : "",
    sizes.length ? `sizes in stock: ${sizes.join(" ")}` : "",
    item.description,
  ]
    .filter(Boolean)
    .join(" | ");
  return { ...item, line };
}

let cached: { at: number; catalogue: Catalogue } | null = null;
let loading: Promise<Catalogue> | null = null;

async function load(): Promise<Catalogue> {
  const products: RawProduct[] = [];
  for (let page = 1; page < 20; page++) {
    const res = await fetch(`${storeApi()}/products?page=${page}&limit=100`, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    if (!res.ok) throw new Error(`paribelle.in's products answered ${res.status}.`);
    const body = (await res.json()) as { products?: RawProduct[]; total?: number } | RawProduct[];
    const list = Array.isArray(body) ? body : (body.products ?? []);
    products.push(...list);
    if (Array.isArray(body) || list.length === 0 || products.length >= (body.total ?? 0)) break;
  }
  const live = products.filter((p) => p.status === "active" && p.stockQuantity > 0);
  const items = live.map((p, i) => toItem(p, `p${i + 1}`));
  return {
    items,
    byRef: new Map(items.map((it) => [it.ref, it])),
    byId: new Map(items.map((it) => [it.card.id, it])),
    text: items.map((it) => it.line).join("\n"),
  };
}

/** The live catalogue; a stale copy when the store can't be read, rather than nothing. */
export async function catalogue(): Promise<Catalogue> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.catalogue;
  loading ??= load()
    .then((catalogue) => {
      cached = { at: Date.now(), catalogue };
      return catalogue;
    })
    .catch((err) => {
      if (cached) {
        console.warn("[pick] the catalogue couldn't be refreshed:", err instanceof Error ? err.message : err);
        return cached.catalogue;
      }
      throw err;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}
