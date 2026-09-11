"use client";

import { useEffect, useRef, useState } from "react";

import { useOrderTabs } from "@/components/app-header";
import { useHeaderCounts } from "@/lib/stores/header-counts";

interface CrumbOption {
  id: string;
  label: string;
  count?: number;
  disabled?: boolean;
}

interface CrumbSub {
  activeId: string;
  activeLabel: string;
  options: CrumbOption[];
  onSelect: (id: string) => void;
}

/**
 * Mobile's stand-in for the header's category tab band (`OrdersTabs`) plus
 * the page body's sub-status rail (`RailTabs`): both collapse into one line
 * of plain text, each half opening a small anchored dropdown on tap instead
 * of costing permanent vertical space. Desktop is unaffected — it keeps the
 * full tab band and rail; this renders only below `sm`, mounted at the top of
 * the page body wherever `RailTabs` (or nothing at all, for Collection and
 * Planner) used to sit.
 *
 * No chevron/arrow glyph follows either label — tapping the text itself is
 * the affordance, same as the mockup this was built from called for.
 */
export function MobileOrdersCrumb({
  sub,
  staticSubLabel,
}: {
  /** The tappable second segment: Unshipped/Packed/Shipped(24h), Pending/Completed. */
  sub?: CrumbSub;
  /** A non-interactive second segment — the "All orders › Cancelled" drill-down leaf. */
  staticSubLabel?: string;
}) {
  const { activeKey, select, tabs } = useOrderTabs();
  const counts = useHeaderCounts((s) => s.counts);
  const activeLabel = tabs.find((t) => t.key === activeKey)?.label ?? "";

  // Only these three tabs have a real count anywhere in the app today (see
  // `OrdersTabs`' own `badgeFor`) — Delivered and All orders show none there
  // either, so this doesn't invent numbers the desktop tab band doesn't have.
  const badgeFor: Partial<Record<string, number>> = counts
    ? { toShip: counts.toShip, shipped: counts.shipped, cancellations: counts.cancelledRto }
    : {};

  return (
    <div
      className="sticky z-30 -mx-4 -mt-6 flex items-center gap-1.5 px-4 py-2.5 sm:hidden"
      style={{ top: 56, borderTop: "1px solid var(--border)", background: "var(--panel)" }}
    >
      <CrumbDropdown
        trigger={activeLabel}
        triggerWeight={600}
        options={tabs.map((t) => ({ id: t.key, label: t.label, count: badgeFor[t.key] }))}
        activeId={activeKey}
        onSelect={(id) => {
          const tab = tabs.find((t) => t.key === id);
          if (tab) select(tab.params);
        }}
      />

      {sub ? (
        <>
          <Separator />
          <CrumbDropdown
            trigger={sub.activeLabel}
            triggerWeight={500}
            triggerColor="var(--muted)"
            options={sub.options}
            activeId={sub.activeId}
            onSelect={sub.onSelect}
          />
        </>
      ) : null}

      {staticSubLabel ? (
        <>
          <Separator />
          <span className="truncate text-[13px] font-medium" style={{ color: "var(--muted)" }}>
            {staticSubLabel}
          </span>
        </>
      ) : null}
    </div>
  );
}

function Separator() {
  return (
    <span className="shrink-0 text-[13px]" style={{ color: "var(--muted-2)" }} aria-hidden>
      ›
    </span>
  );
}

/** One tap target + its anchored popover — the category and, when present, the sub-status segment each get one of these. */
function CrumbDropdown({
  trigger,
  triggerWeight,
  triggerColor = "var(--text)",
  options,
  activeId,
  onSelect,
}: {
  trigger: string;
  triggerWeight: number;
  triggerColor?: string;
  options: CrumbOption[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="truncate text-[13px]"
        style={{ fontWeight: triggerWeight, color: triggerColor }}
      >
        {trigger}
      </button>

      {open ? (
        <div
          role="menu"
          className="panel absolute left-0 top-full z-20 mt-2 w-52 origin-top-left p-1.5"
          style={{ animation: "rise-in 0.15s var(--ease-premium)" }}
        >
          {options.map((o) => {
            const active = o.id === activeId;
            return (
              <button
                key={o.id}
                type="button"
                role="menuitem"
                disabled={o.disabled}
                onClick={() => {
                  if (o.disabled) return;
                  onSelect(o.id);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-[13px] transition-colors disabled:cursor-default"
                style={{
                  background: active ? "var(--accent-soft)" : undefined,
                  color: o.disabled ? "var(--muted-2)" : active ? "#0b7fb0" : "var(--text)",
                  fontWeight: active ? 600 : 500,
                }}
              >
                <span>{o.label}</span>
                {o.count !== undefined ? (
                  <span
                    className="shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-semibold tabular-nums"
                    style={{
                      background: active ? "var(--accent-soft)" : "var(--panel-2)",
                      color: active ? "#0b7fb0" : "var(--muted)",
                    }}
                  >
                    {o.count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
