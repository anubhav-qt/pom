"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { HeaderSearch, RAIL_SLOT_ID } from "@/components/app-header";
import { DropdownMenu, type DropdownOption } from "@/components/dropdown-menu";

export interface CrumbSegment {
  activeId: string;
  activeLabel: string;
  options: DropdownOption[];
  onSelect: (id: string) => void;
}

/**
 * The second rail under the header: a category and, beside it, that category's
 * own sub-list ("To Ship › Unshipped", "Customer returns › To do"), each half a
 * small dropdown. Below `sm` it is one sticky line at the top of the page; from
 * `sm` up it is portaled into the header's third band, with the search box at
 * its right end. Orders and Returns both use it, so the two rails are the same
 * object with different contents.
 *
 * No chevron follows either label — tapping the text is the affordance.
 */
export function RailCrumb({
  primary,
  sub,
  third,
  staticSubLabel,
  search = true,
}: {
  primary: CrumbSegment;
  sub?: CrumbSegment;
  /** A further dropdown after the sub-list (Finance's "Payment date / Order date"). */
  third?: CrumbSegment;
  /** Show the search box at the right end of the desktop band. Off where the screen has no header search. */
  search?: boolean;
  /** A non-interactive second segment, e.g. the "All orders › Cancelled" drill-down leaf. */
  staticSubLabel?: string;
}) {
  const primaryCount = primary.options.find((o) => o.id === primary.activeId)?.count;
  const subCount = sub?.options.find((o) => o.id === sub.activeId)?.count;
  const thirdCount = third?.options.find((o) => o.id === third.activeId)?.count;

  // The desktop band's slot is looked up after mount so server and client markup agree.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setSlot(document.getElementById(RAIL_SLOT_ID));
  }, []);

  const crumb = (
    <>
      <DropdownMenu
        trigger={
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[13px]" style={{ fontWeight: 600, color: "var(--text)" }}>
              {primary.activeLabel}
            </span>
            <CountBadge count={primaryCount} />
          </span>
        }
        options={primary.options}
        activeId={primary.activeId}
        onSelect={primary.onSelect}
      />

      {sub ? (
        <>
          <Separator />
          <DropdownMenu
            trigger={
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[13px]" style={{ fontWeight: 500, color: "var(--muted)" }}>
                  {sub.activeLabel}
                </span>
                <CountBadge count={subCount} />
              </span>
            }
            options={sub.options}
            activeId={sub.activeId}
            onSelect={sub.onSelect}
          />
        </>
      ) : null}

      {third ? (
        <>
          <Separator />
          <DropdownMenu
            trigger={
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[13px]" style={{ fontWeight: 500, color: "var(--muted)" }}>
                  {third.activeLabel}
                </span>
                <CountBadge count={thirdCount} />
              </span>
            }
            options={third.options}
            activeId={third.activeId}
            onSelect={third.onSelect}
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
    </>
  );

  return (
    <>
      <div
        className="sticky z-30 -mx-4 -mt-6 flex items-center gap-1.5 px-4 py-2.5 sm:hidden"
        style={{ top: 56, borderTop: "1px solid var(--border)", background: "var(--panel)" }}
      >
        {crumb}
      </div>
      {slot
        ? createPortal(
            <div style={{ borderTop: "1px solid var(--border)" }}>
              <div className="mx-auto hidden max-w-7xl items-center gap-1.5 px-4 py-2.5 sm:flex sm:px-6">
                {crumb}
                <div className="flex-1" />
                {search ? (
                  <div className="hidden md:block">
                    <HeaderSearch />
                  </div>
                ) : null}
              </div>
            </div>,
            slot,
          )
        : null}
    </>
  );
}

function Separator() {
  return (
    <span className="shrink-0 text-[13px]" style={{ color: "var(--muted-2)" }} aria-hidden>
      ›
    </span>
  );
}

function CountBadge({ count }: { count?: number }) {
  if (count === undefined) return null;
  return (
    <span
      className="shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-semibold tabular-nums"
      style={{ background: "var(--panel-2)", color: "var(--muted)" }}
    >
      {count}
    </span>
  );
}
