import { redirect } from "next/navigation";

import { FEATURES } from "@/config/features";
import { requireUser } from "@/lib/auth";

import { getCancellationCounts, getCancellationRecords } from "../orders/queries";
import { ReturnsDesk } from "./returns-table";
import { getReturnsDesk } from "./queries";

export const dynamic = "force-dynamic";

/**
 * The Returns desk: customer returns from Amazon's Returns report, plus the
 * RTO and cancelled parcels the Orders screen already tracks, in one place with
 * the money attached.
 */
export default async function ReturnsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; resolved?: string }>;
}) {
  await requireUser();
  if (!FEATURES.returns) redirect("/orders");

  const { tab, resolved } = await searchParams;
  const resolvedCancel = resolved === "1";

  const [desk, cancellations, cancelCounts] = await Promise.all([
    getReturnsDesk(),
    getCancellationRecords({ resolved: resolvedCancel, sinceDays: 30 }),
    getCancellationCounts(30),
  ]);

  return (
    <ReturnsDesk
      rows={desk.rows}
      kpis={desk.kpis}
      reasons={desk.reasons}
      cancellations={cancellations}
      cancelCounts={cancelCounts}
      initialTab={tab === "rto" ? "rto" : "returns"}
      resolvedCancel={resolvedCancel}
    />
  );
}
