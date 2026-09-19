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
export const RANGE_PRESETS = ["7d", "30d", "90d", "all"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export function isRangePreset(v: string | undefined): v is RangePreset {
  return !!v && (RANGE_PRESETS as readonly string[]).includes(v);
}

/** Which date puts money in a period: the day it moved, or the day the order was placed. */
export type Basis = "paid" | "ordered";
export const DEFAULT_BASIS: Basis = "paid";

export function isBasis(v: string | undefined): v is Basis {
  return v === "paid" || v === "ordered";
}

/** Cache key for one range on one basis. */
export function dashKey(range: RangePreset, basis: Basis): string {
  return `${range}|${basis}`;
}

export function rangeStart(preset: RangePreset): Date {
  if (preset === "all") return new Date("2000-01-01");
  const days = preset === "7d" ? 7 : preset === "30d" ? 30 : 90;
  return new Date(Date.now() - days * 86_400_000);
}
