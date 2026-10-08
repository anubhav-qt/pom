"use client";

import { FileDown, Store } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { DropdownMenu } from "@/components/dropdown-menu";
import { RailCrumb } from "@/components/rail-crumb";
import { LoadingOverlay } from "@/components/ui";
import { useOrdersCache } from "@/lib/stores/orders-cache";
import { dashKey, useDashboardCache, useDashboardNav } from "@/lib/stores/dashboard-cache";
import { useLedgerNav } from "@/lib/stores/ledger-cache";
import { stripBasePath, withBasePath } from "@/lib/base-path";

import { CHANNEL_LABEL, DEFAULT_CHANNEL, MARKETPLACES, isFinanceChannel, type FinanceChannel, type Marketplace } from "./channels";
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
 * Both count one marketplace or all of them, picked at the rail's right end
 * once a second marketplace has any data.
 */

type Tab = "overview" | "ledger";

/** Whether a Finance screen has mounted yet: only the first one takes its tab from the server's URL. */
let tabSeeded = false;

function paramsFromSearch(search: string): { range: DashRange; basis: Basis; tab: Tab; channel: FinanceChannel } {
  const p = new URLSearchParams(search);
  const range = p.get("range") ?? undefined;
  const basis = p.get("basis") ?? undefined;
  const channel = p.get("ch");
  return {
    range: isDashRange(range) ? range : DEFAULT_RANGE,
    basis: isBasis(basis) ? basis : "paid",
    tab: p.get("tab") === "ledger" ? "ledger" : "overview",
    channel: isFinanceChannel(channel) ? channel : DEFAULT_CHANNEL,
  };
}

function tabInUrl(tab: Tab) {
  const q = new URLSearchParams(window.location.search);
  if (tab === "ledger") q.set("tab", "ledger");
  else q.delete("tab");
  const s = q.toString();
  window.history.replaceState(null, "", withBasePath(s ? `/dashboard?${s}` : "/dashboard"));
}

const BASIS_LABEL: Record<Basis, string> = { paid: "Payment date", ordered: "Order date" };

export function DashboardWorkspace({
  initialView,
  initialBasis,
  initialTab,
}: {
  initialView: DashboardView;
  /** The Ledger's basis from the URL; left as it is when omitted. */
  initialBasis?: Basis;
  /**
   * From the URL on the server, so the first client render matches the server
   * HTML. Later mounts (coming back from another screen) open the tab that was
   * showing when Finance was left.
   */
  initialTab?: Tab;
}) {
  const range = useDashboardNav((s) => s.range);
  const basis = useDashboardNav((s) => s.basis);
  const channel = useDashboardNav((s) => s.channel);
  const adopt = useDashboardNav((s) => s.adopt);
  const go = useDashboardNav((s) => s.go);
  const ledgerView = useLedgerNav((s) => s.view);

  const [tab, setTabState] = useState<Tab>(() => {
    if (tabSeeded || !initialTab) return useDashboardNav.getState().tab;
    tabSeeded = true;
    useDashboardNav.setState({ tab: initialTab });
    return initialTab;
  });
  const setTab = (next: Tab) => {
    useDashboardNav.setState({ tab: next });
    setTabState(next);
  };
  const [view, setView] = useState<DashboardView>(initialView);
  const [loading, setLoading] = useState(false);

  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    useDashboardCache.getState().put(dashKey(initialView.channel, initialView.range), initialView);
    useDashboardNav.setState({
      range: initialView.range,
      channel: initialView.channel,
      ...(initialBasis ? { basis: initialBasis } : {}),
    });
  }

  // Back / forward move the URL without us, so the store has to be put back in
  // step. Guarded on the path: a popstate can land on /dashboard from the Orders
  // side of the toggle, and an unguarded handler would read an /orders URL.
  useEffect(() => {
    const onPop = () => {
      if (stripBasePath(window.location.pathname) !== "/dashboard") return;
      const p = paramsFromSearch(window.location.search);
      adopt({ range: p.range, basis: p.basis, channel: p.channel });
      useDashboardNav.setState({ tab: p.tab });
      setTabState(p.tab);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [adopt]);

  function selectTab(next: Tab) {
    setTab(next);
    tabInUrl(next);
  }

  // Coming back to the Ledger through a plain /dashboard link: the URL should say so.
  useEffect(() => {
    if (stripBasePath(window.location.pathname) === "/dashboard") tabInUrl(tab);
    // Only on mount; later changes go through selectTab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A finished sync empties the cache, and so does a cost saved in the Ledger.
  // Re-read after a sync and on every return to Overview, so fresh numbers
  // show without a reload; an untouched cache answers instantly.
  const syncStamp = useOrdersCache((s) => s.syncStamp);

  useEffect(() => {
    if (tab !== "overview") return;
    let cancelled = false;
    const cache = useDashboardCache.getState();

    const key = dashKey(channel, range);
    const cached = cache.peek(key);
    if (cached) setView(cached);
    else setLoading(true);

    cache
      .load(key, () => getDashboardView(range, channel))
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
  }, [range, channel, syncStamp, tab]);

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
        actions={
          <>
            <ChannelMenu channel={channel} channels={view.channels} onSelect={(c) => go({ channel: c })} />
            {tab === "overview" && view.lineCount > 0 ? <PdfButton range={range} channel={channel} /> : null}
          </>
        }
      />

      {tab === "ledger" ? <LedgerView basis={basis} channel={channel} /> : <ProfitOverview view={view} />}

      {loading && tab === "overview" ? <LoadingOverlay /> : null}
    </div>
  );
}

/**
 * Which marketplace Finance counts: all of them, or one. Only there once a
 * second marketplace has orders or money (or one is picked from a link), so
 * an Amazon-only account sees no switch at all.
 *
 * Styled as the PDF button beside it. The menu's wrapper is a flex box so its
 * button is not set on a line of text, which would lift it off the PDF
 * button's centre line.
 */
function ChannelMenu({
  channel,
  channels,
  onSelect,
}: {
  channel: FinanceChannel;
  channels: Marketplace[];
  onSelect: (channel: FinanceChannel) => void;
}) {
  const shown = MARKETPLACES.filter((c) => channels.includes(c) || c === channel);
  if (shown.length < 2 && channel === DEFAULT_CHANNEL) return null;
  return (
    <DropdownMenu
      align="right"
      className="flex shrink-0"
      trigger={
        <span
          className="flex items-center gap-1.5 text-[13px] font-medium transition-colors hover:text-[var(--text)]"
          style={{ color: "var(--muted)" }}
          title="Which marketplace to count"
        >
          <Store className="h-4 w-4 shrink-0" aria-hidden />
          <span className="hidden truncate sm:inline">{CHANNEL_LABEL[channel]}</span>
          <span className="truncate sm:hidden">{channel === DEFAULT_CHANNEL ? "All" : CHANNEL_LABEL[channel]}</span>
        </span>
      }
      options={[
        { id: DEFAULT_CHANNEL, label: CHANNEL_LABEL[DEFAULT_CHANNEL] },
        ...shown.map((c, i) => ({ id: c, label: CHANNEL_LABEL[c], dividerBefore: i === 0 })),
      ]}
      activeId={channel}
      onSelect={(id) => onSelect(id as FinanceChannel)}
    />
  );
}

/**
 * The browser's own print sheet, where "Save as PDF" is one of the printers:
 * the PDF is this page with sharp, selectable text, laid out for A4 by the
 * print rules in globals.css. The page title becomes the file's name.
 */
function PdfButton({ range, channel }: { range: DashRange; channel: FinanceChannel }) {
  function print() {
    const title = document.title;
    const who = channel === DEFAULT_CHANNEL ? "" : ` ${CHANNEL_LABEL[channel]}`;
    document.title = `PariBelle${who} profit - ${rangeLabel(range)}`;
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
