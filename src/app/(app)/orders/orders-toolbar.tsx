"use client";

import { CHANNEL_META } from "@/channels";
import { ENABLED_CHANNELS } from "@/config/features";
import type { Channel } from "@/db/schema";
import { useOrdersNav } from "@/lib/stores/orders-cache";
import { cn } from "@/lib/utils";

type View = "list" | "collection" | "planner";

/**
 * The "To ship" queue can be read two ways: as a flat order list, or rolled up
 * by product for a shelf run. The marketplace status tabs now live in the app
 * header (band 2); this is just the List / Collection switch for that queue,
 * plus a reminder of which marketplace is in view.
 */
export function OrdersToolbar({
  activeChannel,
  activeView,
  query,
  rightSlot,
}: {
  activeChannel?: Channel;
  activeView: View;
  query: string;
  /** Rendered at the right end of the toolbar row (e.g. the collection sheet button). */
  rightSlot?: React.ReactNode;
}) {
  const go = useOrdersNav((s) => s.go);

  // Switching view is a cache lookup, not a navigation: `go` moves the URL with
  // pushState and the workspace re-reads from the store.
  function select(view: View) {
    go({
      view: view === "list" ? undefined : view,
      channel: activeChannel,
      q: query || undefined,
    });
  }

  const tabs: { view: View; label: string; icon: React.ReactNode }[] = [
    {
      view: "list",
      label: "List",
      icon: (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" />
        </svg>
      ),
    },
    {
      view: "collection",
      label: "Collection",
      icon: (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      ),
    },
    {
      view: "planner",
      label: "Restock planner",
      icon: (
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="8" y="3" width="8" height="4" rx="1" />
          <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
          <path d="M9 12h6M9 16h4" />
        </svg>
      ),
    },
  ];

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div
        className="inline-flex rounded-[10px] p-[3px]"
        style={{ background: "var(--panel)", border: "1px solid var(--border)", boxShadow: "var(--shadow-xs)" }}
      >
        {tabs.map((t) => {
          const active = t.view === activeView;
          return (
            <button
              key={t.view}
              type="button"
              onClick={() => select(t.view)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-xs font-medium transition-colors",
                !active && "muted",
              )}
              style={
                active
                  ? { background: "var(--accent-soft)", color: "#0b7fb0" }
                  : undefined
              }
            >
              {t.icon}
              {t.label}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-3">
        {ENABLED_CHANNELS.length > 1 ? (
          <span className="muted text-xs">
            {activeChannel ? CHANNEL_META[activeChannel].name : "All marketplaces"}
          </span>
        ) : null}
        {rightSlot}
      </div>
    </div>
  );
}
