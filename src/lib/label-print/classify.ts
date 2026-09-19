import type { PageInfo, ProductLine } from "./types";

/*
 * TODO(flipkart): no sample PDF yet, so Flipkart pages are not recognised and
 * come back as "unrecognised" in the run report. When one arrives, add a
 * detector below (see isMeeshoPage) and a product parser, then stamp it in
 * compose.ts's STAMP_BOX. Tracked in docs/LABEL_PRINT.md.
 */

const INVOICE_MARKERS = ["tax invoice", "bill of supply", "cash memo"];

/** Meesho prints the courier label and the invoice on one page. */
function isMeeshoPage(t: string) {
  return t.includes("customer address") && t.includes("if undelivered");
}

function amazonOrderId(text: string): string | null {
  const m = /Order\s*(?:Number|Id)\s*:?\s*(\d{3})\D{1,6}(\d{7})\D{1,6}(\d{7})/i.exec(text);
  return m ? `${m[1]}${m[2]}${m[3]}` : null;
}

function meeshoOrderId(text: string): string | null {
  const m = /\b(\d{15,20})(?:_\d+)?\b/.exec(text);
  return m ? m[1] : null;
}

const SIZE_RE = /^(?:(?:[2-9]|10)?x{0,1}s|xs|s|m|l|(?:[2-9]|10)?xl|xxl|xxxl|free\s*size|one\s*size|os|\d{1,3}(?:\.\d)?(?:\s*(?:cm|in|inch|years?|yrs?|months?|m))?)$/i;

/** "Alpha, 2XL, Regular, Wine Maroon" -> size 2XL, colour Wine Maroon. */
function variation(block: string): { size: string; color: string } {
  const parts = block.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length === 0) return { size: "-", color: "-" };
  const color = parts.length > 1 ? parts[parts.length - 1] : "-";
  const rest = parts.slice(0, -1);
  const size = rest.find((x) => SIZE_RE.test(x)) ?? rest[1] ?? rest[0] ?? "-";
  return { size, color };
}

/**
 * Amazon invoice rows read "<n> <title> (IN, <size system>, <size>, <fit>,
 * <color>) | <ASIN> ( <sku> ) HSN:...". Everything before the first "(IN," is
 * the title, up to the previous row's last rupee amount (or the header).
 */
function amazonProducts(text: string): ProductLine[] {
  const out: ProductLine[] = [];
  // The block after "(IN," may hold 2-6 comma-separated attributes and the
  // colour may itself contain brackets, e.g. "Navy Blue (Dark)".
  const re = /\(\s*IN\s*,((?:[^()]|\([^()]*\))+?)\)\s*\|/gi;
  const head = /Total\s+Amount\s+/i.exec(text);
  let from = head ? head.index + head[0].length : 0;

  for (let m = re.exec(text); m; m = re.exec(text)) {
    let title = text.slice(from, m.index);
    const lastPrice = [...title.matchAll(/₹\s*[\d,]+(?:\.\d+)?/g)].pop();
    if (lastPrice) title = title.slice(lastPrice.index! + lastPrice[0].length);
    title = title.replace(/^\s*\d+\s+/, "").replace(/\s+/g, " ").trim();
    const { size, color } = variation(m[1]);
    if (title) out.push({ name: title, size, color });
    from = m.index + m[0].length;
  }

  // Listings without variations have no "(IN, ...)" block. Keep the name
  // (up to the first "|") and say plainly that size and colour are unknown.
  if (out.length === 0 && /B0[A-Z0-9]{8}/.test(text)) {
    const row = /Total\s+Amount\s+\d+\s+([^|]+?)\s*\|/i.exec(text);
    if (row) out.push({ name: row[1].replace(/\s+/g, " ").trim(), size: "-", color: "-" });
  }
  return out;
}

/** Meesho's "SKU Size Qty Color Order No." row plus the description line. */
function meeshoProducts(text: string): ProductLine[] {
  const row = /SKU\s+Size\s+Qty\s+Color\s+Order\s*No\.?\s+(\S+)\s+(\S+)\s+\S+\s+(\S+)\s+\d/i.exec(text);
  if (!row) return [];
  const size = row[2];
  const color = row[3];

  const desc =
    /Description\s+HSN\s+Qty\s+Gross\s*Amount\s+Discount\s+Taxable\s*Value\s+Taxes\s+Total\s+(.+?)\s+\d{4,8}\s+\d+\s+Rs\./i.exec(
      text,
    );
  // The description usually repeats the size at the end ("... Set - XL").
  const name = desc
    ? desc[1].replace(new RegExp(`\\s*-\\s*${size.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "").trim()
    : row[1];
  return [{ name, size, color }];
}

/**
 * Classify every page of one PDF from its extracted text.
 *
 * Amazon's shipping label carries no text layer at all (it is a picture), so
 * "no text" is itself the signal for a label there. That is also why an Amazon
 * label can only be tied to an order, and to its product, through the invoice
 * next to it, which is what the second pass does.
 */
export function classifyPages(texts: string[]): PageInfo[] {
  const pages: PageInfo[] = texts.map((raw, index) => {
    const text = raw.replace(/\s+/g, " ").trim();
    const lower = text.toLowerCase();
    const base = { index, products: [] as ProductLine[] };

    if (!text) {
      return { ...base, kind: "label", platform: "unknown", orderId: null, reason: "no text layer (graphic label)" };
    }
    if (isMeeshoPage(lower)) {
      return {
        ...base,
        kind: "label",
        platform: "meesho",
        orderId: meeshoOrderId(text),
        products: meeshoProducts(text),
        reason: "label + invoice page",
      };
    }
    if (INVOICE_MARKERS.some((m) => lower.includes(m))) {
      const amazon = lower.includes("amazon");
      return {
        ...base,
        kind: "invoice",
        platform: amazon ? "amazon" : "unknown",
        orderId: amazonOrderId(text),
        products: amazon ? amazonProducts(text) : [],
        reason: "tax invoice",
      };
    }
    return { ...base, kind: "unrecognised", platform: "unknown", orderId: null, reason: "no known label or invoice markers" };
  });

  // Textless labels take their platform, order id and product from the invoice
  // printed beside them: the next page first (Amazon prints label, then
  // invoice), then the previous one. Each invoice is claimed once so two
  // labels can't share it.
  const claimed = new Set<number>();
  for (const p of pages) {
    if (p.kind !== "label" || p.platform !== "unknown") continue;
    for (const j of [p.index + 1, p.index - 1]) {
      const inv = pages[j];
      if (inv?.kind === "invoice" && !claimed.has(j)) {
        claimed.add(j);
        p.platform = inv.platform;
        p.orderId = inv.orderId;
        p.products = inv.products;
        p.reason = `graphic label paired with invoice on page ${j + 1}`;
        break;
      }
    }
  }
  return pages;
}
