import { desc, eq, isNull, sql } from "drizzle-orm";

import { redirect } from "next/navigation";

import { db } from "@/db";
import { orders, returns } from "@/db/schema";
import { FEATURES } from "@/config/features";
import { requireUser } from "@/lib/auth";
import { Stat } from "@/components/ui";

import { ReturnsTable, type ReturnRow } from "./returns-table";

export const dynamic = "force-dynamic";

export default async function ReturnsPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  await requireUser();
  if (!FEATURES.returns) redirect("/orders");

  const { show } = await searchParams;
  const showAll = show === "all";

  const rows = await db
    .select({
      id: returns.id,
      channel: returns.channel,
      externalReturnId: returns.externalReturnId,
      kind: returns.kind,
      reason: returns.reason,
      awb: returns.awb,
      status: returns.status,
      expectedAt: returns.expectedAt,
      receivedAt: returns.receivedAt,
      restocked: returns.restocked,
      conditionNote: returns.conditionNote,
      externalOrderId: orders.externalOrderId,
    })
    .from(returns)
    .leftJoin(orders, eq(orders.id, returns.orderId))
    .where(showAll ? undefined : isNull(returns.receivedAt))
    .orderBy(desc(returns.createdAt))
    .limit(300);

  const [counts] = await db
    .select({
      pending: sql<number>`COUNT(*) FILTER (WHERE ${returns.receivedAt} IS NULL)`,
      rto: sql<number>`COUNT(*) FILTER (WHERE ${returns.kind} = 'rto' AND ${returns.receivedAt} IS NULL)`,
      restocked: sql<number>`COUNT(*) FILTER (WHERE ${returns.restocked} = true)`,
    })
    .from(returns);

  const data: ReturnRow[] = rows.map((r) => ({
    ...r,
    expectedAt: r.expectedAt?.toISOString() ?? null,
    receivedAt: r.receivedAt?.toISOString() ?? null,
  }));

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Awaiting check-in" value={Number(counts?.pending ?? 0)} />
        <Stat label="RTO in transit" value={Number(counts?.rto ?? 0)} tone="warn" />
        <Stat label="Restocked to date" value={Number(counts?.restocked ?? 0)} />
      </div>

      <ReturnsTable rows={data} showAll={showAll} />
    </div>
  );
}
