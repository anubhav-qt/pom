import { parseVariantTitle } from "@/lib/variant-title";

/**
 * A marketplace title cut down to what a person reads at a glance: a short
 * product name, then size and colour. "Paribelle 3 Piece Cotton Co-Ord Set with
 * Embroidered Coat (IN, Alpha, L, Regular, Brown)" becomes
 * { name: "3 Piece Cotton Co-Ord Set with Embroidered Coat", size: "L", color: "Brown" }.
 */
export function friendlyItem(title: string | null | undefined): {
  name: string;
  size: string | null;
  color: string | null;
  /** "Name · L · Brown" for places that only have one line. */
  line: string;
} {
  const p = parseVariantTitle(title);
  const name = p.label || p.base || "Item";
  return {
    name,
    size: p.size,
    color: p.color,
    line: [name, p.size, p.color].filter(Boolean).join(" · "),
  };
}
