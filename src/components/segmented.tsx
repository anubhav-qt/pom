"use client";

import { cn } from "@/lib/utils";

/**
 * The app's one toggle: the List / Collection / Planner switch on Orders,
 * lifted out so every other "pick one of a few" control looks and behaves the
 * same instead of each screen drawing its own.
 */
export interface SegmentedItem<T extends string> {
  key: T;
  label: string;
  icon?: React.ReactNode;
  count?: number;
}

export function Segmented<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: SegmentedItem<T>[];
  value: T;
  onChange: (key: T) => void;
  /** Read out by screen readers. */
  label: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("seg inline-flex max-w-full overflow-x-auto rounded-[10px] p-[3px]", className)}
      style={{ background: "var(--panel)", border: "1px solid var(--border)", boxShadow: "var(--shadow-xs)" }}
    >
      {items.map((t) => {
        const active = t.key === value;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            aria-pressed={active}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] px-2.5 py-1.5 text-xs font-medium transition-colors",
              !active && "muted",
            )}
            style={active ? { background: "var(--accent-soft)", color: "#0b7fb0" } : undefined}
          >
            {t.icon}
            {t.label}
            {t.count !== undefined ? <span className="tabular-nums opacity-70">{t.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
