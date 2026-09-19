"use client";

import { LoadingOverlay } from "@/components/ui";
import { useEffect, useRef, useState } from "react";

import { Segmented } from "@/components/segmented";
import { Empty, Stat, StatStrip } from "@/components/ui";
import { useOrdersCache } from "@/lib/stores/orders-cache";
import { dashKey, useDashboardCache, useDashboardNav } from "@/lib/stores/dashboard-cache";
import { stripBasePath, withBasePath } from "@/lib/base-path";
import { cn, money } from "@/lib/utils";

import { StatusBars, TopSkuBars, TrendChart } from "./charts";
import { DonutChart, LabelBars } from "./finance-charts";
import { LedgerView } from "./ledger-view";
import { isBasis, isRangePreset, type Basis, type RangePreset } from "./range";
import { RangePicker } from "./range-picker";
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
 * Two tabs share the range and basis controls: Overview (this file) and Ledger
 * (`ledger-view.tsx`, which reads its own date range).
 */

const STATUS_COLORS: Record<string, string> = {
  fulfilled: "var(--ok)",
  in_progress: "var(--accent)",
  returned: "var(--danger)",
  cancelled: "var(--muted-2)",
};

const compactMoney = new Intl.NumberFormat("en-IN", {
  notation: "compact",
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 1,
});

type Tab = "overview" | "ledger";

function paramsFromSearch(search: string): { range: RangePreset; basis: Basis; tab: Tab } {
  const p = new URLSearchParams(search);
  const range = p.get("range") ?? undefined;
  const basis = p.get("basis") ?? undefined;
  return {
    range: isRangePreset(range) ? range : "30d",
    basis: isBasis(basis) ? basis : "paid",
    tab: p.get("tab") === "ledger" ? "ledger" : "overview",
  };
}

const BASIS_LABEL: Record<Basis, string> = { paid: "Payment date", ordered: "Order date" };

export function DashboardWorkspace({
  initialView,
  initialTab = "overview",
}: {
  initialView: DashboardView;
  /** From the URL on the server, so the first client render matches the server HTML. */
  initialTab?: Tab;
}) {
  const range = useDashboardNav((s) => s.range);
  const basis = useDashboardNav((s) => s.basis);
  const adopt = useDashboardNav((s) => s.adopt);
  const go = useDashboardNav((s) => s.go);

  const [tab, setTab] = useState<Tab>(initialTab);
  const [view, setView] = useState<DashboardView>(initialView);
  const [loading, setLoading] = useState(false);

  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    useDashboardCache.getState().put(dashKey(initialView.range, initialView.basis), initialView);
    useDashboardNav.setState({ range: initialView.range, basis: initialView.basis });
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

  // A finished sync empties the cache; re-read so fresh numbers show without a reload.
  const syncStamp = useOrdersCache((s) => s.syncStamp);

  useEffect(() => {
    let cancelled = false;
    const cache = useDashboardCache.getState();
    const key = dashKey(range, basis);

    const cached = cache.peek(key);
    if (cached) setView(cached);
    else setLoading(true);

    cache
      .load(key, () => getDashboardView(range, basis))
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
  }, [range, basis, syncStamp]);

  return (
    <div className="relative space-y-6 pb-16 sm:pb-0">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Finance view"
          items={[
            { key: "overview" as Tab, label: "Overview" },
            { key: "ledger" as Tab, label: "Ledger" },
          ]}
          value={tab}
          onChange={selectTab}
        />
        <div className="ml-auto flex flex-wrap items-center gap-3">
          <Segmented
            label="Count money by"
            items={(["paid", "ordered"] as Basis[]).map((b) => ({ key: b, label: BASIS_LABEL[b] }))}
            value={basis}
            onChange={(b) => go({ basis: b })}
          />
          {tab === "overview" ? <RangePicker active={range} onSelect={(next) => go({ range: next })} /> : null}
        </div>
      </div>

      {tab === "ledger" ? <LedgerView basis={basis} /> : <Overview view={view} />}

      {loading && tab === "overview" ? <LoadingOverlay /> : null}
    </div>
  );
}

function Overview({ view }: { view: DashboardView }) {
  const { series, stats, buckets, topSkus, finance } = view;
  const f = finance.stats;

  if (finance.lineCount === 0) {
    return (
      <div className="panel">
        <Empty
          title="No money data yet"
          hint="Press Sync now."
        />
      </div>
    );
  }

  const refundPct = f.sales > 0 ? Math.round((f.refunds / f.sales) * 100) : 0;
  const kept = Math.max(0, f.sales - f.refunds - f.fees - f.ads);
  const cancellationRate = stats.totalOrders > 0 ? Math.round((stats.cancelledCount / stats.totalOrders) * 100) : 0;
  const avgSale = f.shippedOrders > 0 ? f.sales / f.shippedOrders : 0;

  const daily = finance.daily.map((d) => ({ day: d.day, orders: 0, revenue: Math.max(0, d.net) }));

  const payoutBars = finance.payouts.map((p) => ({
    key: p.at,
    label: new Date(p.at).toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
    value: p.amount,
  }));

  return (
    <>
      <StatStrip
        items={[
          { label: "Received", value: compactMoney.format(f.net), tone: "ok" },
          { label: "Paid to bank", value: compactMoney.format(f.paidOut) },
          { label: "Held", value: compactMoney.format(f.onHold) },
          {
            label: "Refunded",
            value: compactMoney.format(f.refunds),
            tone: refundPct >= 25 ? "danger" : refundPct >= 12 ? "warn" : undefined,
          },
          {
            label: "Profit",
            value: f.ordersWithCost > 0 ? compactMoney.format(f.profit) : "—",
            tone: f.ordersWithCost > 0 ? (f.profit < 0 ? "danger" : "ok") : undefined,
          },
        ]}
      />
      <div className="hidden grid-cols-2 gap-3 sm:grid lg:grid-cols-5">
        <Stat label="Received" value={compactMoney.format(f.net)} tone="ok" hint="After all deductions" />
        <Stat label="Paid to bank" value={compactMoney.format(f.paidOut)} />
        <Stat label="Held by Amazon" value={compactMoney.format(f.onHold)} />
        <Stat
          label="Refunded"
          value={compactMoney.format(f.refunds)}
          tone={refundPct >= 25 ? "danger" : refundPct >= 12 ? "warn" : undefined}
          hint={`${refundPct}% of sales`}
        />
        <Stat
          label="Profit"
          value={f.ordersWithCost > 0 ? compactMoney.format(f.profit) : "—"}
          tone={f.ordersWithCost > 0 ? (f.profit < 0 ? "danger" : "ok") : undefined}
          hint={f.ordersWithCost > 0 ? `${f.ordersMissingCost} orders without cost` : "Add costs in the ledger"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <div className="panel p-5">
          <h2 className="text-sm font-semibold">Where your sales money went</h2>
          <div className="mb-4" />
          <DonutChart
            centerLabel="Sales"
            centerValue={compactMoney.format(f.sales)}
            slices={[
              { key: "keep", label: "You keep", value: kept, color: "var(--ok)" },
              { key: "refunds", label: "Refunded", value: f.refunds, color: "var(--danger)" },
              { key: "fees", label: "Amazon fees", value: f.fees, color: "var(--warn)" },
              { key: "ads", label: "Ads", value: f.ads, color: "var(--accent)" },
            ]}
          />
        </div>

        <div className="panel p-5">
          <h2 className="text-sm font-semibold">Received per day</h2>
          <div className="mb-3" />
          <TrendChart data={daily} metric="revenue" color="var(--accent)" format="money" />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <div className="panel p-5">
          <h2 className="text-sm font-semibold">Payouts</h2>
          <div className="mb-4" />
          <LabelBars items={payoutBars} format={(n) => money(n)} color="var(--ok)" />
        </div>

        <div className="panel p-5">
          <h2 className="text-sm font-semibold">Where orders stand</h2>
          <div className="mb-4" />
          <StatusBars buckets={buckets} colors={STATUS_COLORS} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Orders shipped" value={f.shippedOrders} />
        <Stat label="Avg order" value={money(avgSale.toFixed(0))} />
        <Stat
          label="Cancellation rate"
          value={`${cancellationRate}%`}
          tone={cancellationRate >= 15 ? "danger" : cancellationRate >= 8 ? "warn" : undefined}
        />
        <Stat
          label="Late now"
          value={stats.currentlyLate}
          tone={stats.currentlyLate > 0 ? "danger" : undefined}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <div className="panel p-5">
          <h2 className="text-sm font-semibold">Best-selling SKUs</h2>
          <div className="mb-4" />
          <TopSkuBars items={topSkus} format="money" />
        </div>
        <div className="panel p-5">
          <h2 className="text-sm font-semibold">Orders per day</h2>
          <div className="mb-3" />
          <TrendChart data={series} metric="orders" color="var(--accent-2)" format="number" />
        </div>
      </div>
    </>
  );
}
