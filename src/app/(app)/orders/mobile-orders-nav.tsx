"use client";

import { ClipboardList, LayoutGrid, List as ListIcon, Printer, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";

import type { Channel } from "@/db/schema";
import { useAssistantUi } from "@/lib/stores/assistant-ui";
import { useOrdersNav } from "@/lib/stores/orders-cache";

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
 * the PDF printer shortcut: one fixed, full-width, icon-only bar docked to
 * the bottom of the screen, present on every Orders section so switching
 * views, opening the PDF printer, or asking the assistant never needs a trip back to the
 * top.
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

  // Switching to any other destination should leave the assistant panel
  // behind, not stranded open over whatever screen you navigated to.
  function selectView(view: View) {
    setAssistantOpen(false);
    go({ view: view === "list" ? undefined : view, channel: activeChannel, q: query || undefined });
  }

  const items: { key: string; label: string; Icon: typeof ListIcon; active: boolean; onClick: () => void }[] = [
    { key: "list", label: "List", Icon: ListIcon, active: activeView === "list", onClick: () => selectView("list") },
    {
      key: "collection",
      label: "Collection",
      Icon: LayoutGrid,
      active: activeView === "collection",
      onClick: () => selectView("collection"),
    },
    {
      key: "planner",
      label: "Planner",
      Icon: ClipboardList,
      active: activeView === "planner",
      onClick: () => selectView("planner"),
    },
    {
      key: "pdf-printer",
      label: "PDF printer",
      Icon: Printer,
      active: false,
      onClick: () => {
        setAssistantOpen(false);
        router.push("/pdf-printer");
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
      {items.map(({ key, label, Icon, active, onClick }) => (
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
      ))}
    </nav>
  );
}
