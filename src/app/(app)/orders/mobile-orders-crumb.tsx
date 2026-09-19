"use client";

import { useOrderTabs } from "@/components/app-header";
import { RailCrumb, type CrumbSegment } from "@/components/rail-crumb";
import { useHeaderCounts } from "@/lib/stores/header-counts";

/**
 * The Orders rail: the category tabs (To Ship, Shipped, ...) and, beside them,
 * the sub-status list. Mobile shows it as one line, desktop as the header's
 * third band; the shape lives in `RailCrumb`, shared with Returns.
 */
export function MobileOrdersCrumb({
  sub,
  staticSubLabel,
}: {
  /** The tappable second segment: Unshipped/Packed/Shipped(24h), Pending/Completed. */
  sub?: CrumbSegment;
  /** A non-interactive second segment — the "All orders › Cancelled" drill-down leaf. */
  staticSubLabel?: string;
}) {
  const { activeKey, select, tabs } = useOrderTabs();
  const counts = useHeaderCounts((s) => s.counts);

  // Only these three tabs have a real count anywhere in the app today —
  // Delivered and All orders show none, so no numbers are invented for them.
  const badgeFor: Partial<Record<string, number>> = counts
    ? { toShip: counts.toShip, shipped: counts.shipped, cancellations: counts.cancelledRto }
    : {};

  return (
    <RailCrumb
      primary={{
        activeId: activeKey,
        activeLabel: tabs.find((t) => t.key === activeKey)?.label ?? "",
        options: tabs.map((t) => ({ id: t.key, label: t.label, count: badgeFor[t.key] })),
        onSelect: (id) => {
          const tab = tabs.find((t) => t.key === id);
          if (tab) select(tab.params);
        },
      }}
      sub={sub}
      staticSubLabel={staticSubLabel}
    />
  );
}
