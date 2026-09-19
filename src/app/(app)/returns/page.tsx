import { redirect } from "next/navigation";

import { FEATURES } from "@/config/features";
import { requireUser } from "@/lib/auth";

import { ReturnsDesk } from "./returns-table";
import { getReturnsView } from "./view-actions";

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
  const view = await getReturnsView(resolved === "1");

  return <ReturnsDesk initialView={view} initialTab={tab === "rto" ? "rto" : "returns"} />;
}
