"use client";

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
