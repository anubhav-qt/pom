/**
 * Amazon India apparel titles carry the variant in a trailing parenthetical:
 *
 *   "Paribelle 3 Piece Cotton Co-Ord Set with Embroidered Coat (IN, Alpha, 2XL, Regular, Brown)"
 *                                                                └ country, size-system, SIZE, FIT, COLOUR
 *
 * This pulls (size, colour) out of that, and reduces the rest to a base product
 * name for grouping — with a display label that drops the leading brand / gender
 * words ("Paribelle", "Women's"). Fabric words ("Cotton", "Rayon") are kept.
 */

const SIZE_TOKENS = new Set([
  "XS", "S", "M", "L", "XL", "XXL", "XXXL", "XXXXL",
  "2XL", "3XL", "4XL", "5XL", "6XL",
  "FREE", "FREESIZE", "ONESIZE",
]);

/** Sort order for size columns. Anything unknown sorts last, alphabetically. */
export const SIZE_ORDER = [
  "XS", "S", "M", "L", "XL", "XXL", "2XL", "XXXL", "3XL", "XXXXL", "4XL", "5XL", "6XL",
  "FREE", "FREESIZE", "ONESIZE",
];

const LEADING_FILLER =
  /^(?:paribelle|women['’]?s|womens|women|ladies|ladie['’]?s|girl['’]?s|girls|unisex|men['’]?s|mens)\b[\s,\-–—|&]*/i;

export interface ParsedVariant {
  /** Title minus the trailing "(...)", tidied. */
  base: string;
  /** Normalised grouping key derived from `base`. */
  baseKey: string;
  /** `base` with leading brand / gender words stripped, for display. */
  label: string;
  size: string | null;
  color: string | null;
  fit: string | null;
}

export function parseVariantTitle(rawTitle: string | null | undefined): ParsedVariant {
  const title = (rawTitle ?? "").replace(/\s+/g, " ").trim();
  if (!title) {
    return { base: "", baseKey: "", label: "Unnamed product", size: null, color: null, fit: null };
  }

  let base = title;
  let size: string | null = null;
  let color: string | null = null;
  let fit: string | null = null;

  const paren = title.match(/\(([^()]*)\)\s*$/);
  if (paren) {
    base = title.slice(0, paren.index).trim();
    const parts = paren[1].split(",").map((s) => s.trim()).filter(Boolean);
    const sizeIdx = parts.findIndex((p) => SIZE_TOKENS.has(p.toUpperCase().replace(/\s+/g, "")));
    if (sizeIdx >= 0) {
      size = parts[sizeIdx].toUpperCase().replace(/\s+/g, "");
      const after = parts.slice(sizeIdx + 1);
      if (after.length >= 2) {
        fit = after[0];
        color = after.slice(1).join(", ");
      } else if (after.length === 1) {
        color = after[0];
      }
    } else {
      color = parts[parts.length - 1] ?? null;
    }
  } else {
    // No parenthetical — accept a trailing ", <SIZE>".
    const m = base.match(/,\s*([A-Za-z0-9]{1,7})\s*$/);
    if (m && SIZE_TOKENS.has(m[1].toUpperCase())) {
      size = m[1].toUpperCase();
      base = base.slice(0, m.index).trim();
    }
  }

  base = base.replace(/[\s,\-–—|&]+$/g, "").trim();

  // Colour sometimes also trails the base name ("… with Dupatta Pink"); drop it
  // so that variant and the plain "… with Dupatta" group together.
  if (color) {
    const re = new RegExp(`\\s+${escapeRe(color.trim())}$`, "i");
    if (re.test(base)) base = base.replace(re, "").trim();
  }

  let label = base;
  for (let i = 0; i < 4 && LEADING_FILLER.test(label); i++) {
    label = label.replace(LEADING_FILLER, "");
  }
  label = label.replace(/^[\s,\-–—|&]+/, "").trim();
  if (label) label = label[0].toUpperCase() + label.slice(1);

  return {
    base,
    baseKey: base.toLowerCase().replace(/\s+/g, " ").trim(),
    label: label || base || "Unnamed product",
    size,
    color: color ? color.trim() : null,
    fit: fit ? fit.trim() : null,
  };
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Sort a list of size codes into wearing order, unknowns last. */
export function sortSizes(sizes: string[]): string[] {
  return [...new Set(sizes)].sort((a, b) => {
    const ia = SIZE_ORDER.indexOf(a);
    const ib = SIZE_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

/* -------------------------------------------------------------------------- */
/* Colour swatches — best-effort mapping of a colour name to a CSS colour.    */
/* -------------------------------------------------------------------------- */

const COLOR_MAP: Record<string, string> = {
  black: "#1c1c1e", jetblack: "#111114",
  white: "#f4f4f0", offwhite: "#efece2", ivory: "#f2eadb", cream: "#f5edd6",
  grey: "#9ca3af", gray: "#9ca3af", "light grey": "#c7ccd1", "dark grey": "#4b5563",
  charcoal: "#374151", silver: "#c7ccd1",
  red: "#dc2626", "brick red": "#b23b2e", rust: "#b45309", tomato: "#e04a3f",
  maroon: "#7f1d1d", wine: "#722f37", burgundy: "#5b1a2b",
  pink: "#ec4899", "baby pink": "#f9a8d4", "light pink": "#f7b8d2",
  "rani pink": "#d6336c", rani: "#d6336c", magenta: "#c026d3", fuchsia: "#d0208f", rose: "#e11d74",
  peach: "#ffb4a2", coral: "#fb7185", salmon: "#fa8072",
  orange: "#f97316", "burnt orange": "#c2410c",
  yellow: "#eab308", mustard: "#ca8a04", gold: "#d4af37", lemon: "#fde047",
  beige: "#e3d5b8", tan: "#c19a6b", khaki: "#b7a66b", camel: "#c19a6b",
  brown: "#8a5a2b", coffee: "#4b3621", chocolate: "#3d2b1f", "dark brown": "#3f2a1d",
  green: "#16a34a", "dark green": "#14532d", "bottle green": "#0b3d2e", "forest green": "#166534",
  olive: "#65733c", "olive green": "#5b6b2f", mint: "#6ee7b7", "sea green": "#2e8b7a",
  teal: "#0d9488", "deep teal green": "#0f766e", "teal green": "#0f766e", turquoise: "#06b6d4",
  blue: "#2563eb", navy: "#1e3a8a", "navy blue": "#1e3a8a", "dark blue": "#1e40af",
  "sky blue": "#38bdf8", "light blue": "#7dd3fc", "royal blue": "#1d4ed8", indigo: "#4338ca",
  denim: "#3b5b78", cobalt: "#1e56c8", cyan: "#22d3ee", aqua: "#2dd4bf",
  purple: "#7c3aed", violet: "#8b5cf6", lavender: "#c4b5fd", mauve: "#b784a7", plum: "#7b3f61",
};

export interface Swatch {
  /** A CSS colour value, or "" when `multi` is true. */
  css: string;
  /** Render a multicolour indicator instead of a solid dot. */
  multi: boolean;
}

export function colorSwatch(name: string | null | undefined): Swatch | null {
  if (!name) return null;
  const n = name.toLowerCase().replace(/\s+/g, " ").trim();
  if (!n) return null;
  if (/\b(multi|multicolor|multicolour|assorted|printed?|floral|patchwork)\b/.test(n)) {
    return { css: "", multi: true };
  }
  if (COLOR_MAP[n]) return { css: COLOR_MAP[n], multi: false };

  const words = n.split(" ");
  // Try progressively shorter tails: "deep teal green" -> "teal green" -> "green".
  for (let i = 0; i < words.length; i++) {
    const tail = words.slice(i).join(" ");
    if (COLOR_MAP[tail]) return { css: COLOR_MAP[tail], multi: false };
  }
  const last = words[words.length - 1];
  if (COLOR_MAP[last]) return { css: COLOR_MAP[last], multi: false };
  return null;
}
