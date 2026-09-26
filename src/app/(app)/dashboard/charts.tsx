"use client";

import { money } from "@/lib/utils";

import type { StatusBucket, TopSku } from "./queries";

/**
 * A named kind rather than a formatter function prop — a Server Component
 * (the dashboard page) renders these, and functions can't cross the
 * server→client prop boundary (they aren't serializable). The actual
 * formatting logic lives here, client-side, keyed by this string.
 */
export type FormatKind = "money" | "number";

const FORMATTERS: Record<FormatKind, (n: number) => string> = {
  money: (n) => money(n),
  number: (n) => n.toLocaleString("en-IN"),
};

/* -------------------------------------------------------------------------- */
/* Status buckets — horizontal bars, direct-labelled (small dataset, exact    */
/* counts matter more than reading a proportion off a length).                */
/* -------------------------------------------------------------------------- */

export function StatusBars({ buckets, colors }: { buckets: StatusBucket[]; colors: Record<string, string> }) {
  const total = buckets.reduce((a, b) => a + b.count, 0);
  const max = Math.max(...buckets.map((b) => b.count), 1);

  return (
    <div className="space-y-3">
      {buckets.map((b) => {
        const pct = total > 0 ? Math.round((b.count / total) * 100) : 0;
        const widthPct = (b.count / max) * 100;
        return (
          <div key={b.key}>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: colors[b.key] }}
                  aria-hidden
                />
                {b.label}
              </span>
              <span className="tabular-nums" style={{ color: "var(--muted)" }}>
                {b.count} {total > 0 ? `· ${pct}%` : ""}
              </span>
            </div>
            <div className="h-2.5 w-full overflow-hidden rounded-full" style={{ background: "var(--panel-2)" }}>
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${Math.max(widthPct, b.count > 0 ? 3 : 0)}%`, background: colors[b.key] }}
              />
            </div>
          </div>
        );
      })}
      {total === 0 ? <p className="muted text-sm">No orders in this range.</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Top SKUs — horizontal bars, a small enough dataset (≤8) that direct labels */
/* for both quantity and revenue are worth the ink.                           */
/* -------------------------------------------------------------------------- */

export function TopSkuBars({ items, format }: { items: TopSku[]; format: FormatKind }) {
  const max = Math.max(...items.map((i) => i.revenue), 1);
  const formatFn = FORMATTERS[format];

  if (items.length === 0) {
    return <p className="muted text-sm">No sales in this range yet.</p>;
  }

  return (
    <div className="space-y-2.5">
      {items.map((item) => (
        <div key={item.sku}>
          <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
            <span className="min-w-0 truncate">
              <span className="font-mono">{item.sku}</span>
              {item.title ? <span className="muted"> · {item.title}</span> : null}
            </span>
            <span className="shrink-0 tabular-nums" style={{ color: "var(--muted)" }}>
              {item.quantity} sold · {formatFn(item.revenue)}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: "var(--panel-2)" }}>
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max((item.revenue / max) * 100, 3)}%`,
                background: "linear-gradient(90deg, var(--accent), var(--accent-2))",
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
