"use client";

import { ClipboardList, LayoutGrid, List as ListIcon, Printer, ScanLine, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DropdownMenu } from "@/components/dropdown-menu";
import type { Channel } from "@/db/schema";
import { withBasePath } from "@/lib/base-path";
import { useAssistantUi } from "@/lib/stores/assistant-ui";
import { useOrdersCache, useOrdersNav } from "@/lib/stores/orders-cache";
import { useScreenNav } from "@/lib/stores/screen-nav";

import { ScanModal } from "./scan/scan-modal";

type View = "list" | "collection" | "planner";

/**
 * The nav's own rendered height (56px of content plus the safe-area inset it
 * pads itself with) — exported so a screen with its own docked bottom bar
 * (the restock planner) can stack its bar directly above this one instead of
 * overlapping it.
 */
export const MOBILE_NAV_HEIGHT = "calc(56px + env(safe-area-inset-bottom))";

/**
 * The mobile-only replacement for the List/Collection/Planner toolbar plus
 * the scanner and PDF printer shortcuts: one fixed, full-width, icon-only bar
 * docked to the bottom of the screen, present on every Orders section so
 * switching views, scanning, opening the PDF printer, or asking the assistant
 * never needs a trip back to the top. List and Collection share the first slot
 * as a drop-up; the scanner sits in the middle.
 *
 * Desktop keeps the existing top toolbar and reaches the PDF printer from the header —
 * this component renders nothing at `sm` and up.
 */
export function MobileOrdersNav({
  activeView,
  activeChannel,
  query,
}: {
  /** null on a screen that isn't one of the three (e.g. Cancelled & RTO) — none of the three tabs light up. */
  activeView: View | null;
  activeChannel?: Channel;
  query: string;
}) {
  const go = useOrdersNav((s) => s.go);
  const setAssistantOpen = useAssistantUi((s) => s.setOpen);
  const router = useRouter();
  const [scanning, setScanning] = useState(false);

  // Switching to any other destination should leave the assistant panel
  // behind, not stranded open over whatever screen you navigated to.
  function selectView(view: View) {
    setAssistantOpen(false);
    go({ view: view === "list" ? undefined : view, channel: activeChannel, q: query || undefined });
  }

  const listOrCollection = activeView === "list" || activeView === "collection";

  const items: { key: string; label: string; Icon: typeof ListIcon; active: boolean; onClick: () => void }[] = [
    {
      key: "planner",
      label: "Planner",
      Icon: ClipboardList,
      active: activeView === "planner",
      onClick: () => selectView("planner"),
    },
    {
      key: "scanner",
      label: "Scan barcode",
      Icon: ScanLine,
      active: false,
      onClick: () => {
        setAssistantOpen(false);
        setScanning(true);
      },
    },
    {
      key: "pdf-printer",
      label: "PDF printer",
      Icon: Printer,
      active: false,
      onClick: () => {
        setAssistantOpen(false);
        // Swap in place, like the header toggle does. A real navigation would
        // leave the Orders override set, which keeps painting over the printer.
        window.history.pushState(null, "", withBasePath("/pdf-printer"));
        useScreenNav.getState().setOverride("pdf-printer");
      },
    },
    { key: "ai", label: "AI", Icon: Sparkles, active: false, onClick: () => setAssistantOpen(true) },
  ];

  return (
    <nav
      className="no-print fixed inset-x-0 bottom-0 z-40 flex sm:hidden"
      style={{
        background: "var(--panel)",
        borderTop: "1px solid var(--border)",
        boxShadow: "0 -6px 20px rgba(15,37,54,0.08)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <DropdownMenu
        side="up"
        className="relative flex-1"
        trigger={
          <span
            className="flex h-14 items-center justify-center"
            style={{ color: listOrCollection ? "var(--accent)" : "var(--muted)" }}
          >
            {activeView === "collection" ? (
              <LayoutGrid className="h-[22px] w-[22px]" strokeWidth={2} />
            ) : (
              <ListIcon className="h-[22px] w-[22px]" strokeWidth={2} />
            )}
          </span>
        }
        options={[
          { id: "list", label: "List" },
          { id: "collection", label: "Collection" },
        ]}
        activeId={activeView === "collection" ? "collection" : "list"}
        onSelect={(id) => selectView(id as View)}
      />

      {items.map(({ key, label, Icon, active, onClick }) =>
        key === "scanner" ? (
          <button
            key={key}
            type="button"
            onClick={onClick}
            aria-label={label}
            className="flex h-14 flex-1 items-center justify-center"
          >
            <span
              className="flex h-11 w-11 -translate-y-2.5 items-center justify-center rounded-full text-white"
              style={{
                background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
                boxShadow: "0 4px 14px rgba(15,37,54,0.25)",
              }}
            >
              <Icon className="h-[22px] w-[22px]" strokeWidth={2} />
            </span>
          </button>
        ) : (
          <button
            key={key}
            type="button"
            onClick={onClick}
            aria-label={label}
            className="flex h-14 flex-1 items-center justify-center"
            style={{ color: active ? "var(--accent)" : "var(--muted)" }}
          >
            <Icon className="h-[22px] w-[22px]" strokeWidth={2} />
          </button>
        ),
      )}

      {scanning ? (
        <ScanModal
          onClose={() => setScanning(false)}
          onDone={() => {
            useOrdersCache.getState().bumpSync();
            router.refresh();
          }}
        />
      ) : null}
    </nav>
  );
}
