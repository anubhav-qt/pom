"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { RAIL_SLOT_ID } from "@/components/app-header";
import { cn } from "@/lib/utils";

/**
 * The sub-status tabs (Unshipped/Packed/Shipped(24h), Pending/Completed): a
 * third band of the app header. It renders into the header's own slot rather
 * than the page body, so it is attached to the category tabs above it with no
 * gap, spans the full width like they do, and uses exactly their look (same
 * container, underline-on-active style, badges).
 *
 * Desktop-only: mobile gets the compact category+sub-status dropdown
 * (`MobileOrdersCrumb`) instead.
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
  // The slot lives in the header, which renders in the same pass; look it up
  // after mount so server and client markup agree.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(document.getElementById(RAIL_SLOT_ID));
  }, []);
  if (!slot) return null;

  return createPortal(
    <div
      className="mx-auto hidden max-w-7xl items-center gap-6 overflow-x-auto px-4 sm:flex sm:px-6"
      style={{ borderTop: "1px solid var(--border)", scrollbarWidth: "none" }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelect(tab.id)}
            className={cn(
              "inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 py-3 text-[13.5px] font-medium transition-colors",
              !isActive && "muted hover:text-[var(--text)]",
            )}
            style={{
              borderColor: isActive ? "var(--accent)" : "transparent",
              color: isActive ? "var(--text)" : undefined,
              fontWeight: isActive ? 600 : 500,
            }}
          >
            {tab.label}
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
    </div>,
    slot,
  );
}
