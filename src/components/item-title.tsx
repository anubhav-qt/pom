import { variation } from "@/lib/label-print/classify";

/**
 * "Name / Size: x / Color: y", the same three lines the PDF stamp prints.
 * Marketplace titles carry the variation in a trailing "(IN, Alpha, L, Regular,
 * White)" that is noisy to read; this splits it out. A title with no such tail
 * is shown as the name alone.
 */
export function parseItemTitle(title: string | null): { name: string; size: string | null; color: string | null } {
  if (!title) return { name: "", size: null, color: null };
  const m = /\(\s*IN\s*,((?:[^()]|\([^()]*\))+?)\)\s*$/i.exec(title);
  if (!m) return { name: title.trim(), size: null, color: null };
  const { size, color } = variation(m[1]);
  return { name: title.slice(0, m.index).trim(), size: size === "-" ? null : size, color: color === "-" ? null : color };
}

export function ItemTitle({
  title,
  empty = "Unnamed item",
  nameClassName = "text-[13px] font-medium leading-snug",
  meta,
  suffix,
}: {
  title: string | null;
  empty?: string;
  /** Classes for the name line; size and colour follow it in a smaller size. */
  nameClassName?: string;
  /** Extra facts (location, ASIN, order id) joined on one quiet line. */
  meta?: (string | null | undefined | false)[];
  /** Appended to the name, e.g. "+2 more". */
  suffix?: string;
}) {
  const { name, size, color } = parseItemTitle(title);
  const facts = (meta ?? []).filter(Boolean) as string[];
  return (
    <div>
      <div className={`line-clamp-2 ${nameClassName}`}>
        {name ? name + (suffix ?? "") : <span className="muted italic">{empty}</span>}
      </div>
      {size ? <div className="text-[12px] font-medium leading-snug">Size: {size}</div> : null}
      {color ? <div className="text-[12px] font-medium leading-snug">Color: {color}</div> : null}
      {facts.length > 0 ? <div className="muted mt-0.5 text-[11px]">{facts.join(" · ")}</div> : null}
    </div>
  );
}
