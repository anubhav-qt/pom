/** The brand every Amazon listing Seelie writes is under. */
export const AMAZON_BRAND = "PariBelle";

const LISTING_PATH = /^\/listings\/\d{4}-\d{2}-\d{2}\/items\//;

type Entry = Record<string, unknown>;

/** A brand attribute's entries with PariBelle as the value, keeping each entry's marketplace and language. */
function ours(value: unknown, marketplaceId: string): Entry[] {
  const entries = (Array.isArray(value) ? value : [value]).filter((e): e is Entry => !!e && typeof e === "object");
  if (!entries.length) return [{ value: AMAZON_BRAND, marketplace_id: marketplaceId }];
  return entries.map((e) => ({ ...e, value: AMAZON_BRAND }));
}

/**
 * A Listings Items PUT or PATCH with its brand set to PariBelle, whatever brand the
 * model sent ("Generic" included). Only a brand the call already sets is changed: an
 * offer on someone else's ASIN, which sends no brand, is left alone.
 */
export function withOurBrand(method: string, path: string, body: unknown, marketplaceId: string): { body: unknown; was?: string } {
  if ((method !== "PUT" && method !== "PATCH") || !LISTING_PATH.test(path) || !body || typeof body !== "object") return { body };
  const b = structuredClone(body) as { attributes?: Record<string, unknown>; patches?: { op?: string; path?: string; value?: unknown }[] };
  const before: unknown[] = [];
  if (method === "PUT" && b.attributes && typeof b.attributes === "object" && "brand" in b.attributes) {
    before.push(b.attributes.brand);
    b.attributes.brand = ours(b.attributes.brand, marketplaceId);
  }
  if (method === "PATCH" && Array.isArray(b.patches)) {
    for (const p of b.patches) {
      if (p?.path !== "/attributes/brand") continue;
      if (p.op === "delete") {
        // A listing can't drop its brand; point it at ours instead.
        p.op = "replace";
      }
      before.push(p.value);
      p.value = ours(p.value, marketplaceId);
    }
  }
  if (!before.length) return { body };
  const was = before
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .map((e) => (e && typeof e === "object" ? (e as Entry).value : e))
    .filter((v): v is string => typeof v === "string" && v !== AMAZON_BRAND);
  return { body: b, was: was.length ? [...new Set(was)].join(", ") : undefined };
}
