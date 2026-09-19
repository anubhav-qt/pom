"use client";

import { LoadingOverlay } from "@/components/ui";
import { useEffect, useRef, useState } from "react";

import { Stat } from "@/components/ui";
import { useOrdersCache } from "@/lib/stores/orders-cache";
import { useDashboardCache, useDashboardNav } from "@/lib/stores/dashboard-cache";
import { stripBasePath } from "@/lib/base-path";
import { money } from "@/lib/utils";

import { StatusBars, TopSkuBars, TrendChart } from "./charts";
import { isRangePreset, type RangePreset } from "./range";
import { RangePicker } from "./range-picker";
import { getDashboardView, type DashboardView } from "./view-actions";

/**
 * The dashboard, rendered from the client cache.
 *
 * The server still renders the first payload in `page.tsx`, so a cold open
 * paints real numbers with no spinner and the URL is shareable. After that,
 * changing range is a cache lookup, and so is toggling back here from Orders:
 * `useDashboardNav` moves the URL with `pushState`, this component re-reads
 * `useDashboardCache`, and the four aggregate queries only run on a miss or
 * past the staleness window.
 *
 * Modelled on `OrdersWorkspace`, including the synchronous seed: an effect
 * would let the first range change race the seed and refetch a payload we
 * were handed for free.
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

function rangeFromSearch(search: string): RangePreset {
  const raw = new URLSearchParams(search).get("range") ?? undefined;
  return isRangePreset(raw) ? raw : "30d";
}

export function DashboardWorkspace({ initialView }: { initialView: DashboardView }) {
  const range = useDashboardNav((s) => s.range);
  const adopt = useDashboardNav((s) => s.adopt);
  const go = useDashboardNav((s) => s.go);

  const [view, setView] = useState<DashboardView>(initialView);
  const [loading, setLoading] = useState(false);

  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    useDashboardCache.getState().put(initialView.range, initialView);
    useDashboardNav.setState({ range: initialView.range });
  }

  // Back / forward move the URL without us, so the store has to be put back in
  // step. Guarded on the path: once a popstate can land on /dashboard from the
  // Orders side of the toggle, an unguarded handler would read a range off an
  // /orders URL.
  useEffect(() => {
    const onPop = () => {
      if (stripBasePath(window.location.pathname) !== "/dashboard") return;
      adopt(rangeFromSearch(window.location.search));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [adopt]);

  // A finished sync empties the cache; re-read so fresh numbers show without a reload.
  const syncStamp = useOrdersCache((s) => s.syncStamp);

  useEffect(() => {
    let cancelled = false;
    const cache = useDashboardCache.getState();

    const cached = cache.peek(range);
    if (cached) setView(cached);
    else setLoading(true);

    cache
      .load(range, getDashboardView)
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
  }, [range, syncStamp]);

  const { series, stats, buckets, topSkus } = view;

  const cancellationRate =
    stats.totalOrders > 0 ? Math.round((stats.cancelledCount / stats.totalOrders) * 100) : 0;
  const nonCancelled = stats.totalOrders - stats.cancelledCount;
  const avgOrderValue = nonCancelled > 0 ? stats.revenue / nonCancelled : 0;
  const codRate = stats.totalOrders > 0 ? Math.round((stats.codCount / stats.totalOrders) * 100) : 0;

  return (
    <div className="relative space-y-6">
      {loading ? <LoadingOverlay /> : null}
      <div className="flex flex-wrap items-center justify-end gap-3">
        <RangePicker active={range} onSelect={(next) => go(next)} />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Revenue" value={compactMoney.format(stats.revenue)} />
        <Stat label="Orders" value={stats.totalOrders} />
        <Stat label="Avg order value" value={money(avgOrderValue.toFixed(0))} />
        <Stat
          label="Cancellation rate"
          value={`${cancellationRate}%`}
          tone={cancellationRate >= 15 ? "danger" : cancellationRate >= 8 ? "warn" : undefined}
        />
        <Stat
          label="Past deadline now"
          value={stats.currentlyLate}
          tone={stats.currentlyLate > 0 ? "danger" : undefined}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="panel p-5">
          <h2 className="text-sm font-semibold">Revenue</h2>
          <p className="muted mb-3 text-xs">Excludes cancelled, RTO and returned orders.</p>
          <TrendChart data={series} metric="revenue" color="var(--accent)" format="money" />
        </div>

        <div className="panel p-5">
          <h2 className="text-sm font-semibold">Orders</h2>
          <p className="muted mb-3 text-xs">All orders placed, every status.</p>
          <TrendChart data={series} metric="orders" color="var(--accent-2)" format="number" />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="panel p-5">
          <h2 className="text-sm font-semibold">Where orders stand</h2>
          <p className="muted mb-4 text-xs">
            {stats.totalOrders} order{stats.totalOrders === 1 ? "" : "s"} in this range · {codRate}% COD
          </p>
          <StatusBars buckets={buckets} colors={STATUS_COLORS} />
        </div>

        <div className="panel p-5">
          <h2 className="text-sm font-semibold">Best-selling SKUs</h2>
          <p className="muted mb-4 text-xs">By revenue, this range.</p>
          <TopSkuBars items={topSkus} format="money" />
        </div>
      </div>
    </div>
  );
}
