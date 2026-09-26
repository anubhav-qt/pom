/**
 * Pure date-range logic — deliberately its own file with zero imports.
 *
 * `queries.ts` imports `db` (→ `pg`, a Node-only package). A client component
 * that needs the range picker's constants but imports them from `queries.ts`
 * would pull that entire chain into the browser bundle — webpack then trips
 * over `pg-connection-string`'s `require('fs')` and the build fails. Keeping
 * this file free of any DB import means it's always safe for a "use client"
 * component to import, no matter what else lives next to it.
 */
export const RANGE_PRESETS = ["all", "7d", "30d", "90d"] as const;

export const RANGE_LABEL = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  all: "All time",
} as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

/** A preset, or a calendar month as `YYYY-MM` (India time). */
export type DashRange = RangePreset | `${number}-${number}`;

export const DEFAULT_RANGE: DashRange = "all";

export function isRangePreset(v: string | undefined): v is RangePreset {
  return !!v && (RANGE_PRESETS as readonly string[]).includes(v);
}

export function isMonth(v: string | undefined): v is `${number}-${number}` {
  return !!v && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}

export function isDashRange(v: string | undefined): v is DashRange {
  return isRangePreset(v) || isMonth(v);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function rangeLabel(range: DashRange): string {
  if (isRangePreset(range)) return RANGE_LABEL[range];
  const [y, m] = range.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

/** Which date puts money in a period: the day it moved, or the day the order was placed. */
export type Basis = "paid" | "ordered";
export const DEFAULT_BASIS: Basis = "paid";

export function isBasis(v: string | undefined): v is Basis {
  return v === "paid" || v === "ordered";
}

export function rangeStart(preset: RangePreset): Date {
  if (preset === "all") return new Date("2000-01-01");
  const days = preset === "7d" ? 7 : preset === "30d" ? 30 : 90;
  return new Date(Date.now() - days * 86_400_000);
}

/** [from, to) for a range. A month runs midnight to midnight India time. */
export function rangeBounds(range: DashRange): { from: Date; to: Date } {
  if (isRangePreset(range)) return { from: rangeStart(range), to: new Date(Date.now() + 86_400_000) };
  const [y, m] = range.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { from: new Date(`${range}-01T00:00:00+05:30`), to: new Date(`${next}-01T00:00:00+05:30`) };
}
