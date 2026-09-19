import { requireUser } from "@/lib/auth";

import { DashboardWorkspace } from "./dashboard-workspace";
import { getDashboardView } from "./view-actions";

/**
 * Dashboard.
 *
 * The server renders the first payload for the range the URL asks for, so a
 * cold open paints real numbers with no spinner and the link stays shareable.
 * Everything after that happens in `DashboardWorkspace`: changing range, or
 * toggling back from Orders, is a client cache lookup rather than a trip
 * through here.
 */
export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; basis?: string; tab?: string }>;
}) {
  await requireUser();
  const { range, basis, tab } = await searchParams;
  const view = await getDashboardView(range, basis);

  return <DashboardWorkspace initialView={view} initialTab={tab === "ledger" ? "ledger" : "overview"} />;
}
