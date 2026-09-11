"use client";

/**
 * A sub-tab strip styled and positioned to read as a direct continuation of
 * the app header's own category rail (`OrdersTabs` in app-header.tsx) —
 * same underline-on-active style, same edge-to-edge width, no pill/box
 * chrome. Used for the Unshipped/Packed/Shipped(24h) queue tabs and the
 * Cancelled & RTO Pending/Completed tabs, both of which sit as the first
 * thing in the page body, immediately under the sticky header.
 */
export function RailTabs<T extends string>({
  tabs,
  active,
  onSelect,
}: {
  tabs: { id: T; label: string; count: number }[];
  active: T;
  onSelect: (id: T) => void;
}) {
  return (
    <div
      // -mt-6 cancels `<main>`'s own pt-6 (layout.tsx) so this sits flush
      // against the sticky header above it instead of leaving a gap. Sticky
      // itself, pinned right at the header's own rendered height (measured:
      // 104px, stable across breakpoints since band 2 doesn't reflow), so it
      // stays docked under the header instead of scrolling away with the
      // list — the same way the header's own tabs behave.
      className="sticky z-30 -mx-4 -mt-6 flex items-center gap-6 overflow-x-auto px-4 sm:-mx-6 sm:px-6"
      style={{
        top: 104,
        borderTop: "1px solid var(--border)",
        background: "var(--panel)",
        scrollbarWidth: "none",
      }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelect(tab.id)}
            className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 py-3 text-[13.5px] font-medium transition-colors"
            style={{
              borderColor: isActive ? "var(--accent)" : "transparent",
              color: isActive ? "var(--text)" : "var(--muted)",
              fontWeight: isActive ? 600 : 500,
            }}
          >
            <span>{tab.label}</span>
            <span
              className="rounded-full px-1.5 py-px text-[10.5px] font-semibold tabular-nums"
              style={{
                background: isActive ? "var(--accent-soft)" : "var(--panel-2)",
                color: isActive ? "#0b7fb0" : "var(--muted)",
              }}
            >
              {tab.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
