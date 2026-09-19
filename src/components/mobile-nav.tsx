"use client";

import { ClipboardList, LayoutGrid, List as ListIcon, Printer, ScanLine, Sparkles, type LucideIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

import { ScanModal } from "@/app/(app)/orders/scan/scan-modal";
import { DropdownMenu, type DropdownOption } from "@/components/dropdown-menu";
import { withBasePath } from "@/lib/base-path";
import { useAssistantUi } from "@/lib/stores/assistant-ui";
import { ordersViewKey, paramsToQuery, useOrdersCache, useOrdersNav } from "@/lib/stores/orders-cache";
import { resolveScreen, useScreenNav } from "@/lib/stores/screen-nav";
import type { OrdersViewParams } from "@/app/(app)/orders/view-actions";

/**
 * The nav's own rendered height (56px of content plus the safe-area inset it
 * pads itself with) — exported so a screen with its own docked bottom bar
 * (the restock planner) can stack its bar directly above this one instead of
 * overlapping it.
 */
export const MOBILE_NAV_HEIGHT = "calc(56px + env(safe-area-inset-bottom))";

/** One slot of the bar: a plain button, or a drop-up menu of a few choices. */
type NavSlot =
  | { kind: "button"; key: string; label: string; Icon: LucideIcon; active: boolean; onClick: () => void }
  | {
      kind: "menu";
      key: string;
      label: string;
      Icon: LucideIcon;
      active: boolean;
      options: DropdownOption[];
      activeId: string;
      onSelect: (id: string) => void;
    };

/**
 * The mobile-only bottom bar, on every screen (Finance, Orders, Returns, PDF
 * printer): the order list, the planner, the scanner, the printer and the
 * assistant. It lives above the screens rather than inside one, so it stays
 * put while the screen underneath changes. Renders nothing at `sm` and up,
 * where the header carries all of this.
 *
 * On Orders the first slot is a List/Collection drop-up. From any other screen
 * it takes you straight back to To Ship › Unshipped, and Planner opens the
 * planner.
 */
export function MobileNav() {
  const pathname = usePathname();
  const override = useScreenNav((s) => s.override);
  const params = useOrdersNav((s) => s.params);
  const setAssistantOpen = useAssistantUi((s) => s.setOpen);
  const router = useRouter();
  const [scanning, setScanning] = useState(false);

  const screen = resolveScreen(pathname, override);
  if (screen === null) return null;

  const onOrders = screen === "orders";
  const view = onOrders ? (params.view ?? "list") : null;

  /** Open an Orders view, swapping in place when it is cached and navigating when it is not. */
  function openOrders(next: OrdersViewParams) {
    setAssistantOpen(false);
    setScanning(false);
    if (onOrders) {
      useOrdersNav.getState().go(next);
      return;
    }
    if (useOrdersCache.getState().peek(ordersViewKey(next)) !== null) {
      useOrdersNav.getState().go(next);
      useScreenNav.getState().setOverride("orders");
      return;
    }
    useScreenNav.getState().setOverride(null);
    router.push(`/orders${paramsToQuery(next)}`);
  }

  const withView = (v?: string): OrdersViewParams => ({ view: v, channel: params.channel });

  const first: NavSlot = onOrders
    ? {
        kind: "menu",
        key: "view",
        label: "View",
        Icon: view === "collection" ? LayoutGrid : ListIcon,
        active: view === "list" || view === "collection",
        options: [
          { id: "list", label: "List" },
          { id: "collection", label: "Collection" },
        ],
        activeId: view === "collection" ? "collection" : "list",
        onSelect: (id) => openOrders({ ...withView(id === "list" ? undefined : id), q: params.q || undefined }),
      }
    : { kind: "button", key: "view", label: "Orders", Icon: ListIcon, active: false, onClick: () => openOrders({}) };

  const slots: NavSlot[] = [
    first,
    {
      kind: "button",
      key: "planner",
      label: "Planner",
      Icon: ClipboardList,
      active: view === "planner",
      onClick: () => openOrders(withView("planner")),
    },
    {
      kind: "button",
      key: "scanner",
      label: "Scan",
      Icon: ScanLine,
      active: false,
      onClick: () => {
        setAssistantOpen(false);
        setScanning(true);
      },
    },
    {
      kind: "button",
      key: "pdf-printer",
      label: "PDF printer",
      Icon: Printer,
      active: screen === "pdf-printer",
      onClick: () => {
        setAssistantOpen(false);
        setScanning(false);
        // Swap in place, like the header toggle does. A real navigation would
        // leave a screen override set, which keeps painting over the printer.
        window.history.pushState(null, "", withBasePath("/pdf-printer"));
        useScreenNav.getState().setOverride("pdf-printer");
      },
    },
    { kind: "button", key: "ai", label: "AI", Icon: Sparkles, active: false, onClick: () => { setScanning(false); setAssistantOpen(true); } },
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
      {slots.map((slot) => {
        // While the scanner sheet is open it is the current place, not whatever is behind it.
        const active = slot.key === "scanner" ? scanning : slot.active && !scanning;
        const color = active ? "var(--accent)" : "var(--muted)";
        const Icon = slot.Icon;
        if (slot.kind === "menu") {
          return (
            <DropdownMenu
              key={slot.key}
              side="up"
              className="relative flex-1"
              trigger={
                <span className="flex h-14 items-center justify-center" style={{ color }} aria-label={slot.label}>
                  <Icon className="h-[22px] w-[22px]" strokeWidth={2} />
                </span>
              }
              options={slot.options}
              activeId={slot.activeId}
              onSelect={slot.onSelect}
            />
          );
        }
        return (
          <button
            key={slot.key}
            type="button"
            onClick={slot.onClick}
            aria-label={slot.label}
            className="flex h-14 flex-1 items-center justify-center"
            style={{ color }}
          >
            <Icon className="h-[22px] w-[22px]" strokeWidth={2} />
          </button>
        );
      })}

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
