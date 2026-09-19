"use server";

import { getFinanceOverview, type FinanceOverview } from "@/lib/finance-queries";
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
import { DEFAULT_BASIS, isBasis, isRangePreset, rangeStart, type Basis, type RangePreset } from "./range";

/**
 * Everything the Finance overview needs for one range and basis, in a single
 * call. The page calls it on the server for the first paint; the client cache
 * (`stores/dashboard-cache`) calls it for every later range change so a range
 * that has already been read is answered without a round trip.
 */

export interface DashboardView {
  range: RangePreset;
  basis: Basis;
  series: DailyPoint[];
  stats: PeriodStats;
  buckets: StatusBucket[];
  topSkus: TopSku[];
  finance: FinanceOverview;
}

export async function getDashboardView(rawRange?: string, rawBasis?: string): Promise<DashboardView> {
  await requireUser();

  const range: RangePreset = isRangePreset(rawRange) ? rawRange : "30d";
  const basis: Basis = isBasis(rawBasis) ? rawBasis : DEFAULT_BASIS;
  const from = rangeStart(range);
  // Exclusive upper bound: the start of tomorrow, so today's lines are in.
  const to = new Date(Date.now() + 86_400_000);

  const [series, stats, buckets, topSkus, finance] = await Promise.all([
    getDailySeries(from),
    getPeriodStats(from),
    getStatusBuckets(from),
    getTopSkus(from),
    getFinanceOverview(from, to, basis),
  ]);

  return { range, basis, series, stats, buckets, topSkus, finance };
}
