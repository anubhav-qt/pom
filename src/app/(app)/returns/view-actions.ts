"use server";

import { requireUser } from "@/lib/auth";

import { getCancellationCounts, getCancellationRecords, type CancellationRecord } from "../orders/queries";
import { getReturnsDesk, type ReasonCount, type ReturnDeskRow, type ReturnsKpis } from "./queries";

/**
 * Everything the Returns screen shows, in one call. The page calls it on the
 * server for the first paint; the client cache (`stores/returns-cache`) calls it
 * for every later read, so toggling back here does not go to the database.
 */
export interface ReturnsView {
  rows: ReturnDeskRow[];
  kpis: ReturnsKpis;
  reasons: ReasonCount[];
  cancellations: CancellationRecord[];
  cancelCounts: { pending: number; completed: number };
  /** Whether the RTO list is showing completed records rather than pending ones. */
  resolved: boolean;
}

export async function getReturnsView(resolved: boolean): Promise<ReturnsView> {
  await requireUser();

  const [desk, cancellations, cancelCounts] = await Promise.all([
    getReturnsDesk(),
    getCancellationRecords({ resolved, sinceDays: 30 }),
    getCancellationCounts(30),
  ]);

  return { ...desk, cancellations, cancelCounts, resolved };
}
