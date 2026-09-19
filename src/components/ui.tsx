import { CHANNEL_META } from "@/channels";
import type { Channel, OrderStatus } from "@/db/schema";
import { cn } from "@/lib/utils";

export function ChannelTag({ channel }: { channel: Channel }) {
  const meta = CHANNEL_META[channel];
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full py-1 pl-1.5 pr-2.5 text-xs font-medium"
      style={{ background: `color-mix(in srgb, ${meta.color} 12%, transparent)` }}
      title={meta.live ? `${meta.name} (live sync)` : `${meta.name} (file import)`}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: meta.color }}
        aria-hidden
      />
      <span style={{ color: `color-mix(in srgb, ${meta.color} 80%, var(--text))` }}>
        {meta.name}
      </span>
    </span>
  );
}

/**
 * One semantic tone per status, expressed as a CSS custom property pair
 * (`--dot` / `--tint`) rather than a hardcoded Tailwind palette, so the badge
 * and its dot always derive from the same colour and the whole set can be
 * re-themed by changing this table alone.
 */
export const STATUS_TONE: Record<OrderStatus, { dot: string; tint: string }> = {
  new: { dot: "#5b7fe0", tint: "rgba(91,127,224,0.12)" },
  ready_to_pack: { dot: "var(--warn)", tint: "var(--warn-soft)" },
  packed: { dot: "var(--accent)", tint: "var(--accent-soft)" },
  manifested: { dot: "#3aa6a0", tint: "rgba(58,166,160,0.12)" },
  shipped: { dot: "var(--ok)", tint: "var(--ok-soft)" },
  delivered: { dot: "var(--ok)", tint: "var(--ok-soft)" },
  cancelled: { dot: "var(--muted-2)", tint: "rgba(148,152,171,0.14)" },
  rto: { dot: "var(--danger)", tint: "var(--danger-soft)" },
  returned: { dot: "var(--danger)", tint: "var(--danger-soft)" },
};

export const STATUS_LABELS: Record<OrderStatus, string> = {
  new: "New",
  ready_to_pack: "To pack",
  packed: "Packed",
  manifested: "Manifested",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
  rto: "RTO",
  returned: "Returned",
};

export function StatusBadge({ status }: { status: OrderStatus }) {
  const tone = STATUS_TONE[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium"
      style={{ background: tone.tint, color: tone.dot }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tone.dot }} />
      {STATUS_LABELS[status]}
    </span>
  );
}

/** Eight pulsing dots in a ring. Brand blue by default; `color` / `size` override. */
export function Spinner({ size = "2.8rem", color, className }: { size?: string; color?: string; className?: string }) {
  return (
    <div
      className={cn("dot-spinner", className)}
      style={{ "--uib-size": size, ...(color ? { "--uib-color": color } : {}) } as React.CSSProperties}
      role="status"
      aria-label="Loading"
    >
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="dot-spinner__dot" />
      ))}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center px-4 py-20 text-center">
      <div
        className="mb-3 h-10 w-10 rounded-full"
        style={{
          background:
            "radial-gradient(circle at 35% 30%, var(--accent-soft), transparent 70%)",
          border: "1px solid var(--border)",
        }}
        aria-hidden
      />
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="muted mt-1 max-w-xs text-sm">{hint}</p> : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "danger" | "warn";
}) {
  const accent = tone === "danger" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : "var(--accent)";
  return (
    <div className="panel relative overflow-hidden py-4 pl-5 pr-4">
      <span
        className="absolute inset-y-0 left-0 w-1 rounded-full"
        style={{ background: accent, opacity: tone ? 1 : 0.5 }}
        aria-hidden
      />
      <div className="muted text-[11px] font-medium uppercase tracking-wider">{label}</div>
      <div
        className={cn("mt-1.5 text-[1.75rem] font-semibold leading-none tabular-nums")}
        style={{ color: tone ? accent : "var(--text)" }}
      >
        {value}
      </div>
    </div>
  );
}
