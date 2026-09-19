"use client";

import { useState } from "react";

import { money } from "@/lib/utils";

/**
 * A pie with a hole, for "where did the money go". Every slice is a share of the
 * same whole (product sales), the legend names the rupees and the percentage,
 * and hovering a slice or its row lifts it. Slices of zero are dropped rather
 * than drawn as slivers.
 */
export interface DonutSlice {
  key: string;
  label: string;
  value: number;
  color: string;
  /** One line explaining what is in this slice. */
  hint?: string;
}

const R = 70;
const STROKE = 26;
const C = 2 * Math.PI * R;

export function DonutChart({
  slices,
  centerLabel,
  centerValue,
}: {
  slices: DonutSlice[];
  centerLabel: string;
  centerValue: string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const shown = slices.filter((s) => s.value > 0);
  const total = shown.reduce((a, s) => a + s.value, 0);

  let offset = 0;
  const arcs = shown.map((s) => {
    const len = total > 0 ? (s.value / total) * C : 0;
    const arc = { ...s, len, offset };
    offset += len;
    return arc;
  });
  const active = shown.find((s) => s.key === hover) ?? null;

  return (
    <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-center">
      <div className="relative shrink-0" style={{ width: 176, height: 176 }}>
        <svg viewBox="0 0 176 176" width="176" height="176" role="img" aria-label="Where the sales money went">
          <circle cx="88" cy="88" r={R} fill="none" stroke="var(--panel-2)" strokeWidth={STROKE} />
          <g transform="rotate(-90 88 88)">
            {arcs.map((a) => (
              <circle
                key={a.key}
                cx="88"
                cy="88"
                r={R}
                fill="none"
                stroke={a.color}
                strokeWidth={hover === a.key ? STROKE + 4 : STROKE}
                strokeDasharray={`${Math.max(a.len - 1.5, 0)} ${C}`}
                strokeDashoffset={-a.offset}
                style={{ opacity: hover === null || hover === a.key ? 1 : 0.35, transition: "all 0.15s ease" }}
                onPointerEnter={() => setHover(a.key)}
                onPointerLeave={() => setHover(null)}
              />
            ))}
          </g>
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="muted text-xs">{active ? active.label : centerLabel}</span>
          <span className="text-lg font-semibold tabular-nums">
            {active ? money(active.value) : centerValue}
          </span>
          {active && total > 0 ? (
            <span className="muted text-[11px] tabular-nums">{Math.round((active.value / total) * 100)}%</span>
          ) : null}
        </div>
      </div>

      <ul className="w-full min-w-0 flex-1 space-y-1.5">
        {shown.map((s) => (
          <li
            key={s.key}
            className="flex items-start justify-between gap-3 rounded-lg px-2 py-1.5 text-sm"
            style={{ background: hover === s.key ? "var(--accent-soft)" : undefined }}
            onPointerEnter={() => setHover(s.key)}
            onPointerLeave={() => setHover(null)}
          >
            <span className="flex min-w-0 items-start gap-2">
              <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} aria-hidden />
              <span className="min-w-0">
                <span className="block font-medium">{s.label}</span>
                {s.hint ? <span className="muted block text-xs">{s.hint}</span> : null}
              </span>
            </span>
            <span className="shrink-0 text-right tabular-nums">
              <span className="block font-medium">{money(s.value)}</span>
              <span className="muted block text-xs">{total > 0 ? Math.round((s.value / total) * 100) : 0}%</span>
            </span>
          </li>
        ))}
        {shown.length === 0 ? <li className="muted text-sm">No sales in this range yet.</li> : null}
      </ul>
    </div>
  );
}

/** Plain horizontal bars: a label, a length, a number. For reasons and payouts. */
export function LabelBars({
  items,
  color = "var(--accent)",
  format = (n: number) => n.toLocaleString("en-IN"),
}: {
  items: { key: string; label: string; value: number; note?: string }[];
  color?: string;
  format?: (n: number) => string;
}) {
  const max = Math.max(...items.map((i) => i.value), 1);
  if (items.length === 0) return <p className="muted text-sm">Nothing to show for this range.</p>;
  return (
    <div className="space-y-2.5">
      {items.map((i) => (
        <div key={i.key}>
          <div className="mb-1 flex items-baseline justify-between gap-2 text-xs">
            <span className="min-w-0 truncate">{i.label}</span>
            <span className="shrink-0 tabular-nums" style={{ color: "var(--muted)" }}>
              {format(i.value)}
              {i.note ? ` · ${i.note}` : ""}
            </span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full" style={{ background: "var(--panel-2)" }}>
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{ width: `${Math.max((i.value / max) * 100, i.value > 0 ? 3 : 0)}%`, background: color }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
