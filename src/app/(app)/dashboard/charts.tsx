"use client";

import { useRef, useState } from "react";

import { money } from "@/lib/utils";

import type { DailyPoint, StatusBucket, TopSku } from "./queries";

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

const VIEW_W = 600;
const VIEW_H = 180;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 12;
const PAD_B = 22;

function niceMax(max: number): number {
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const normalized = max / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/* -------------------------------------------------------------------------- */
/* Trend — a single-metric bar chart. Orders and revenue are two calls to     */
/* this, never one dual-axis chart with both.                                 */
/* -------------------------------------------------------------------------- */

export function TrendChart({
  data,
  metric,
  color,
  format,
}: {
  data: DailyPoint[];
  metric: "orders" | "revenue";
  color: string;
  format: FormatKind;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const formatFn = FORMATTERS[format];

  const values = data.map((d) => d[metric]);
  const maxVal = niceMax(Math.max(...values, 0));
  const plotW = VIEW_W - PAD_L - PAD_R;
  const plotH = VIEW_H - PAD_T - PAD_B;
  const slot = data.length > 0 ? plotW / data.length : plotW;
  const barW = Math.max(2, Math.min(20, slot * 0.55));

  function barX(i: number) {
    return PAD_L + i * slot + (slot - barW) / 2;
  }
  function barY(v: number) {
    const h = maxVal > 0 ? (v / maxVal) * plotH : 0;
    return PAD_T + (plotH - h);
  }
  function barH(v: number) {
    return maxVal > 0 ? (v / maxVal) * plotH : 0;
  }

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg || data.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const xInView = ((e.clientX - rect.left) / rect.width) * VIEW_W;
    const i = Math.round((xInView - PAD_L - slot / 2) / slot);
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  }

  const gridY = [0, 0.5, 1].map((f) => PAD_T + plotH * (1 - f));
  const active = hover !== null ? data[hover] : null;
  // A sparse label plan: show every Nth date so labels never collide, always
  // keeping the first and last so the range's edges are legible.
  const labelEvery = Math.max(1, Math.ceil(data.length / 6));

  return (
    <div className="relative">
      {active ? (
        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-lg font-semibold tabular-nums">
            {formatFn(active[metric])}
          </span>
          <span className="muted text-xs">
            {new Date(active.day).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
          </span>
        </div>
      ) : (
        <div className="mb-1 h-[26px]" />
      )}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        className="w-full touch-none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`${metric} by day`}
      >
        {gridY.map((y, i) => (
          <line
            key={i}
            x1={PAD_L}
            x2={VIEW_W - PAD_R}
            y1={y}
            y2={y}
            stroke="var(--border)"
            strokeWidth={1}
          />
        ))}

        {data.map((d, i) => (
          <rect
            key={i}
            x={barX(i)}
            y={barY(d[metric])}
            width={barW}
            height={Math.max(1, barH(d[metric]))}
            rx={Math.min(4, barW / 2)}
            style={{
              fill: color,
              opacity: hover === null || hover === i ? 1 : 0.35,
              transition: "opacity 0.12s ease",
            }}
          />
        ))}

        {hover !== null ? (
          <line
            x1={barX(hover) + barW / 2}
            x2={barX(hover) + barW / 2}
            y1={PAD_T}
            y2={VIEW_H - PAD_B}
            stroke="var(--border-strong)"
            strokeWidth={1}
            strokeDasharray="2,2"
          />
        ) : null}

        {data.map((d, i) =>
          i % labelEvery === 0 || i === data.length - 1 ? (
            <text
              key={i}
              x={barX(i) + barW / 2}
              y={VIEW_H - 6}
              textAnchor="middle"
              fontSize="9"
              fill="var(--muted-2)"
            >
              {new Date(d.day).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
            </text>
          ) : null,
        )}
      </svg>
    </div>
  );
}

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
