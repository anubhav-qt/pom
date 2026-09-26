"use server";

import { requireUser } from "@/lib/auth";
import { getProfitData, type MoneyToday, type ProfitView } from "@/lib/profit";

import { DEFAULT_RANGE, isDashRange, rangeBounds, type DashRange } from "./range";

/**
 * Everything the Finance overview needs for one range, in a single call. The
 * page calls it on the server for the first paint; the client cache
 * (`stores/dashboard-cache`) calls it for every later range change so a range
 * that has already been read is answered without a round trip.
 */

export interface DashboardView {
  range: DashRange;
  /** Months with orders, newest first, for the range picker. */
  months: string[];
  profit: ProfitView;
  /** Not tied to the range: where the money is right now. */
  money: MoneyToday;
  lineCount: number;
  generatedAt: string;
}

export async function getDashboardView(rawRange?: string): Promise<DashboardView> {
  await requireUser();

  const range: DashRange = isDashRange(rawRange) ? rawRange : DEFAULT_RANGE;
  const { from, to } = rangeBounds(range);
  const data = await getProfitData(from, to);

  return {
    range,
    months: data.months,
    profit: data.view,
    money: data.money,
    lineCount: data.lineCount,
    generatedAt: new Date().toISOString(),
  };
}
