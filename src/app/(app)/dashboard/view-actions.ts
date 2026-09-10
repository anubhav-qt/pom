"use server";

import { requireUser } from "@/lib/auth";

import {
  getDailySeries,
  getPeriodStats,
  getStatusBuckets,
  getTopSkus,
  type DailyPoint,
  type PeriodStats,
  type StatusBucket,
  type TopSku,
} from "./queries";
import { isRangePreset, rangeStart, type RangePreset } from "./range";

/**
 * Everything the dashboard needs for one range, in a single call.
 *
 * This used to live inline in `page.tsx`, so the only way to a different range
 * (or back to the dashboard from Orders) was a full server round trip. Pulling
 * it into a callable action lets the client fetch a range once and keep it,
 * which is what `stores/dashboard-cache` caches. The page still calls this on
 * the server for the first paint.
 */

export interface DashboardView {
  range: RangePreset;
  series: DailyPoint[];
  stats: PeriodStats;
  buckets: StatusBucket[];
  topSkus: TopSku[];
}

export async function getDashboardView(rawRange?: string): Promise<DashboardView> {
  await requireUser();

  const range: RangePreset = isRangePreset(rawRange) ? rawRange : "30d";
  const from = rangeStart(range);

  const [series, stats, buckets, topSkus] = await Promise.all([
    getDailySeries(from),
    getPeriodStats(from),
    getStatusBuckets(from),
    getTopSkus(from),
  ]);

  return { range, series, stats, buckets, topSkus };
}
