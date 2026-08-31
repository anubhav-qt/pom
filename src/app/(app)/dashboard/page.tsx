import { Stat } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import { money } from "@/lib/utils";

import { StatusBars, TopSkuBars, TrendChart } from "./charts";
import { getDailySeries, getPeriodStats, getStatusBuckets, getTopSkus } from "./queries";
import { isRangePreset, rangeStart, type RangePreset } from "./range";
import { RangePicker } from "./range-picker";

export const dynamic = "force-dynamic";

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

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  await requireUser();
  const { range: rawRange } = await searchParams;
  const range: RangePreset = isRangePreset(rawRange) ? rawRange : "30d";
  const from = rangeStart(range);

  const [series, stats, buckets, topSkus] = await Promise.all([
    getDailySeries(from),
    getPeriodStats(from),
    getStatusBuckets(from),
    getTopSkus(from),
  ]);

  const fulfilledOrCancelled = stats.totalOrders;
  const cancellationRate =
    fulfilledOrCancelled > 0 ? Math.round((stats.cancelledCount / fulfilledOrCancelled) * 100) : 0;
  const nonCancelled = stats.totalOrders - stats.cancelledCount;
  const avgOrderValue = nonCancelled > 0 ? stats.revenue / nonCancelled : 0;
  const codRate = stats.totalOrders > 0 ? Math.round((stats.codCount / stats.totalOrders) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
        <RangePicker active={range} />
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
