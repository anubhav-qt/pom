"use client";

import { useOrderTabs } from "@/components/app-header";
import { DropdownMenu, type DropdownOption } from "@/components/dropdown-menu";
import { useHeaderCounts } from "@/lib/stores/header-counts";

interface CrumbSub {
  activeId: string;
  activeLabel: string;
  options: DropdownOption[];
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
      <DropdownMenu
        trigger={
          <span className="truncate text-[13px]" style={{ fontWeight: 600, color: "var(--text)" }}>
            {activeLabel}
          </span>
        }
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
          <DropdownMenu
            trigger={
              <span className="truncate text-[13px]" style={{ fontWeight: 500, color: "var(--muted)" }}>
                {sub.activeLabel}
              </span>
            }
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

