"use client";

import { FileDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { RailCrumb } from "@/components/rail-crumb";
import { LoadingOverlay } from "@/components/ui";
import { useOrdersCache } from "@/lib/stores/orders-cache";
import { useDashboardCache, useDashboardNav } from "@/lib/stores/dashboard-cache";
import { useLedgerNav } from "@/lib/stores/ledger-cache";
import { stripBasePath, withBasePath } from "@/lib/base-path";

import { LedgerView } from "./ledger-view";
import { ProfitOverview } from "./profit-overview";
import { DEFAULT_RANGE, RANGE_PRESETS, isBasis, isDashRange, isRangePreset, rangeLabel, type Basis, type DashRange } from "./range";
import { getDashboardView, type DashboardView } from "./view-actions";

/**
 * The Finance screen, rendered from the client cache.
 *
 * The server still renders the first payload in `page.tsx`, so a cold open
 * paints real numbers with no spinner and the URL is shareable. After that,
 * changing range or basis is a cache lookup, and so is toggling back here from
 * Orders: `useDashboardNav` moves the URL with `pushState`, this component
 * re-reads `useDashboardCache`, and the aggregate queries only run on a miss or
 * past the staleness window.
 *
 * Two tabs: Overview (`profit-overview.tsx`), which reads the range from the
 * rail and always counts by order date, and Ledger (`ledger-view.tsx`), which
 * reads its own dates and uses the rail's Payment date / Order date basis.
 */

type Tab = "overview" | "ledger";

function paramsFromSearch(search: string): { range: DashRange; basis: Basis; tab: Tab } {
  const p = new URLSearchParams(search);
  const range = p.get("range") ?? undefined;
  const basis = p.get("basis") ?? undefined;
  return {
    range: isDashRange(range) ? range : DEFAULT_RANGE,
    basis: isBasis(basis) ? basis : "paid",
    tab: p.get("tab") === "ledger" ? "ledger" : "overview",
  };
}

const BASIS_LABEL: Record<Basis, string> = { paid: "Payment date", ordered: "Order date" };

export function DashboardWorkspace({
  initialView,
  initialBasis,
  initialTab = "overview",
}: {
  initialView: DashboardView;
  /** The Ledger's basis from the URL; left as it is when omitted. */
  initialBasis?: Basis;
  /** From the URL on the server, so the first client render matches the server HTML. */
  initialTab?: Tab;
}) {
  const range = useDashboardNav((s) => s.range);
  const basis = useDashboardNav((s) => s.basis);
  const adopt = useDashboardNav((s) => s.adopt);
  const go = useDashboardNav((s) => s.go);
  const ledgerView = useLedgerNav((s) => s.view);

  const [tab, setTab] = useState<Tab>(initialTab);
  const [view, setView] = useState<DashboardView>(initialView);
  const [loading, setLoading] = useState(false);

  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    useDashboardCache.getState().put(initialView.range, initialView);
    useDashboardNav.setState({ range: initialView.range, ...(initialBasis ? { basis: initialBasis } : {}) });
  }

  // Back / forward move the URL without us, so the store has to be put back in
  // step. Guarded on the path: a popstate can land on /dashboard from the Orders
  // side of the toggle, and an unguarded handler would read an /orders URL.
  useEffect(() => {
    const onPop = () => {
      if (stripBasePath(window.location.pathname) !== "/dashboard") return;
      const p = paramsFromSearch(window.location.search);
      adopt({ range: p.range, basis: p.basis });
      setTab(p.tab);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [adopt]);

  function selectTab(next: Tab) {
    setTab(next);
    const q = new URLSearchParams(window.location.search);
    if (next === "ledger") q.set("tab", "ledger");
    else q.delete("tab");
    const s = q.toString();
    window.history.replaceState(null, "", withBasePath(s ? `/dashboard?${s}` : "/dashboard"));
  }

  // A finished sync empties the cache, and so does a cost saved in the Ledger.
  // Re-read after a sync and on every return to Overview, so fresh numbers
  // show without a reload; an untouched cache answers instantly.
  const syncStamp = useOrdersCache((s) => s.syncStamp);

  useEffect(() => {
    if (tab !== "overview") return;
    let cancelled = false;
    const cache = useDashboardCache.getState();

    const cached = cache.peek(range);
    if (cached) setView(cached);
    else setLoading(true);

    cache
      .load(range, () => getDashboardView(range))
      .then((fresh) => {
        if (!cancelled) {
          setView(fresh);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [range, syncStamp, tab]);

  // The months come from the data; a month opened from a link may not be among them.
  const months = isRangePreset(range) || view.months.includes(range) ? view.months : [range, ...view.months];

  return (
    <div className="relative space-y-5 pb-16 sm:-mt-6 sm:space-y-[7px] sm:pb-0 print:m-0 print:p-0">
      <RailCrumb
        search={false}
        primary={{
          activeId: tab,
          activeLabel: tab === "overview" ? "Overview" : "Ledger",
          options: [
            { id: "overview", label: "Overview" },
            { id: "ledger", label: "Ledger" },
          ],
          onSelect: (id) => selectTab(id as Tab),
        }}
        sub={
          tab === "overview"
            ? {
                activeId: range,
                activeLabel: rangeLabel(range),
                options: [
                  ...RANGE_PRESETS.map((r) => ({ id: r, label: rangeLabel(r) })),
                  ...months.map((m, i) => ({ id: m, label: rangeLabel(m as DashRange), dividerBefore: i === 0 })),
                ],
                onSelect: (id) => go({ range: id as DashRange }),
              }
            : {
                activeId: ledgerView,
                activeLabel: ledgerView === "products" ? "Products" : "Orders",
                options: [
                  { id: "products", label: "Products" },
                  { id: "orders", label: "Orders" },
                ],
                onSelect: (id) => useLedgerNav.getState().set({ view: id as "products" | "orders" }),
              }
        }
        third={
          tab === "ledger"
            ? {
                activeId: basis,
                activeLabel: BASIS_LABEL[basis],
                options: (["paid", "ordered"] as Basis[]).map((b) => ({ id: b, label: BASIS_LABEL[b] })),
                onSelect: (id) => go({ basis: id as Basis }),
              }
            : undefined
        }
        actions={tab === "overview" && view.lineCount > 0 ? <PdfButton range={range} /> : undefined}
      />

      {tab === "ledger" ? <LedgerView basis={basis} /> : <ProfitOverview view={view} />}

      {loading && tab === "overview" ? <LoadingOverlay /> : null}
    </div>
  );
}

/**
 * The browser's own print sheet, where "Save as PDF" is one of the printers:
 * the PDF is this page with sharp, selectable text, laid out for A4 by the
 * print rules in globals.css. The page title becomes the file's name.
 */
function PdfButton({ range }: { range: DashRange }) {
  function print() {
    const title = document.title;
    document.title = `Paribelle profit - ${rangeLabel(range)}`;
    const restore = () => {
      document.title = title;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  }

  return (
    <button
      type="button"
      onClick={print}
      className="flex items-center gap-1.5 text-[13px] font-medium transition-colors hover:text-[var(--text)]"
      style={{ color: "var(--muted)" }}
      title="Save this page as a PDF"
    >
      <FileDown className="h-4 w-4" aria-hidden />
      PDF
    </button>
  );
}
