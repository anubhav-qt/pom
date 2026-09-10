"use client";

import { cn } from "@/lib/utils";

import { RANGE_PRESETS, type RangePreset } from "./range";

const LABELS: Record<RangePreset, string> = {
  "7d": "7 days",
  "30d": "30 days",
  "90d": "90 days",
  all: "All time",
};

/**
 * Controlled: the parent (`DashboardWorkspace`) owns the range and swaps the
 * data through its client cache. This used to `router.push`, which was a
 * server navigation and defeated the cache.
 */
export function RangePicker({
  active,
  onSelect,
}: {
  active: RangePreset;
  onSelect: (range: RangePreset) => void;
}) {
  return (
    <div
      className="inline-flex items-center gap-0.5 rounded-full border p-1"
      style={{ borderColor: "var(--border)", background: "var(--panel)" }}
    >
      {RANGE_PRESETS.map((r) => (
        <button
          key={r}
          onClick={() => onSelect(r)}
          className={cn(
            "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
            active === r ? "text-white" : "muted hover:text-[var(--text)]",
          )}
          style={
            active === r
              ? { background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }
              : undefined
          }
        >
          {LABELS[r]}
        </button>
      ))}
    </div>
  );
}
