import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth";

import { OrdersWorkspace } from "./orders-workspace";
import { getOrdersView, type OrdersViewParams } from "./view-actions";

/**
 * Orders.
 *
 * The server renders whichever view the URL asks for, so a cold open paints
 * real data with no spinner and the link stays shareable. Everything after
 * that happens in `OrdersWorkspace`: switching tabs is a client cache lookup,
 * not another trip through here.
 */
export const dynamic = "force-dynamic";

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<OrdersViewParams>;
}) {
  await requireUser();
  const params = await searchParams;
  // Cancelled and RTO parcels live on the Returns screen now; old links land there.
  if (params.view === "cancellations" || params.status === "cancellations") {
    redirect("/returns?tab=rto");
  }
  const view = await getOrdersView(params);

  return <OrdersWorkspace initialParams={params} initialData={view} />;
}
