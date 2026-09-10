import { and, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";

import { db } from "@/db";
import {
  catalogImages,
  channelEnum,
  orderFulfilment,
  orderItems,
  orders,
  orderStatusEnum,
  products,
} from "@/db/schema";
import { ENABLED_CHANNELS, isChannelEnabled } from "@/config/features";
import { requireUser } from "@/lib/auth";
import { Stat } from "@/components/ui";

import { OrderTable, type OrderRow } from "./order-table";
import { OrdersToolbar } from "./orders-toolbar";
import { PickList } from "./pick-list";
import { CollectionSheetButton } from "./collection-sheet";
import { RestockPlanner } from "./restock-planner";
import { getRestockPlan } from "./planner-actions";
import { CancellationsPanel } from "./cancellations-panel";
import {
  OPEN_STATUSES,
  getCancellationCounts,
  getCancellationRecords,
  getToShipPickList,
} from "./queries";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 200;

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{
    channel?: string;
    status?: string;
    q?: string;
    view?: string;
    resolved?: string;
  }>;
}) {
  await requireUser();
  const params = await searchParams;

  const channel = channelEnum.enumValues.find(
    (c) => c === params.channel && isChannelEnabled(c),
  );
  const view =
    params.view === "collection" || params.view === "cancellations" || params.view === "planner"
      ? params.view
      : "list";

  /* --------------------------------------------------------- restock planner */
  if (view === "planner") {
    const plan = await getRestockPlan();
    return (
      <div className="space-y-5">
        <OrdersToolbar activeChannel={channel} activeView="planner" query={params.q ?? ""} />
        <RestockPlanner initialPlan={plan} />
      </div>
    );
  }

  /* -------------------------------------------------- collection (pick list) */
  if (view === "collection") {
    const rows = await getToShipPickList(channel);
    return (
      <div className="space-y-5">
        <OrdersToolbar
          activeChannel={channel}
          activeView="collection"
          query={params.q ?? ""}
          rightSlot={<CollectionSheetButton rows={rows} />}
        />
        <PickList rows={rows} />
      </div>
    );
  }

  /* ------------------------------------------------------- cancelled & rto */
  if (view === "cancellations") {
    const resolved = params.resolved === "1";
    const [records, counts] = await Promise.all([
      getCancellationRecords({ resolved, sinceDays: 30 }),
      getCancellationCounts(30),
    ]);
    return (
      <div className="space-y-5">
        <CancellationsPanel records={records} counts={counts} resolved={resolved} />
      </div>
    );
  }

  /* ------------------------------------------------------------- order list */
  const filters: SQL[] = [inArray(orders.channel, [...ENABLED_CHANNELS])];
  if (channel) filters.push(eq(orders.channel, channel));

  // "all" is the explicit no-status-filter view; anything else falls back to
  // the open "to ship" queue.
  const showAll = params.status === "all";
  const status = orderStatusEnum.enumValues.find((s) => s === params.status);
  if (status) {
    filters.push(eq(orders.status, status));
  } else if (!showAll) {
    filters.push(inArray(orders.status, [...OPEN_STATUSES]));
  }
  const isQueueView = !status && !showAll;

  const q = params.q?.trim();
  if (q) {
    const like = `%${q}%`;
    filters.push(
      or(
        sql`${orders.externalOrderId} ILIKE ${like}`,
        sql`${orders.buyerName} ILIKE ${like}`,
        sql`${orders.shipPincode} ILIKE ${like}`,
      )!,
    );
  }

  const rows = await db
    .select({ order: orders, fulfilmentState: orderFulfilment.state })
    .from(orders)
    .leftJoin(orderFulfilment, eq(orderFulfilment.orderId, orders.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(orders.dispatchBy, desc(orders.orderedAt))
    .limit(PAGE_SIZE)
    .then((res) => res.map((r) => ({ ...r.order, fulfilmentState: r.fulfilmentState })));

  const items = rows.length
    ? await db
        .select({
          orderId: orderItems.orderId,
          externalSku: orderItems.externalSku,
          title: orderItems.title,
          quantity: orderItems.quantity,
          productId: orderItems.productId,
          pImage: products.imageUrl,
          asin: orderItems.externalAsin,
          ciImage: catalogImages.imageUrl,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .leftJoin(products, eq(products.id, orderItems.productId))
        .leftJoin(
          catalogImages,
          and(
            eq(catalogImages.channelAccountId, orders.channelAccountId),
            eq(catalogImages.asin, orderItems.externalAsin),
          ),
        )
        .where(inArray(orderItems.orderId, rows.map((r) => r.id)))
    : [];

  const itemsByOrder = new Map<number, typeof items>();
  for (const it of items) {
    const list = itemsByOrder.get(it.orderId) ?? [];
    list.push(it);
    itemsByOrder.set(it.orderId, list);
  }

  const data: OrderRow[] = rows.map((o) => ({
    id: o.id,
    channel: o.channel,
    externalOrderId: o.externalOrderId,
    status: o.status,
    orderedAt: o.orderedAt.toISOString(),
    dispatchBy: o.dispatchBy?.toISOString() ?? null,
    buyerName: o.buyerName,
    shipCity: o.shipCity,
    shipState: o.shipState,
    totalAmount: o.totalAmount,
    isCod: o.isCod,
    fulfilmentState: o.fulfilmentState ?? "to_pack",
    items: (itemsByOrder.get(o.id) ?? []).map((it) => ({
      sku: it.externalSku,
      title: it.title,
      quantity: it.quantity,
      mapped: it.productId !== null,
      imageUrl: it.pImage ?? it.ciImage ?? null,
    })),
  }));

  // The split between these two is ours, not the marketplace's: Amazon calls
  // every one of these orders `Unshipped` right up until the courier scans it.
  const [counts] = isQueueView
    ? await db
        .select({
          open: sql<number>`COUNT(*) FILTER (WHERE COALESCE(${orderFulfilment.state}, 'to_pack') = 'to_pack')`,
          packed: sql<number>`COUNT(*) FILTER (WHERE ${orderFulfilment.state} = 'packed')`,
          late: sql<number>`COUNT(*) FILTER (WHERE COALESCE(${orderFulfilment.state}, 'to_pack') = 'to_pack' AND ${orders.dispatchBy} < now())`,
        })
        .from(orders)
        .leftJoin(orderFulfilment, eq(orderFulfilment.orderId, orders.id))
        .where(
          and(
            inArray(orders.status, [...OPEN_STATUSES]),
            inArray(orders.channel, [...ENABLED_CHANNELS]),
            sql`COALESCE(${orderFulfilment.state}, 'to_pack') <> 'manifested'`,
          ),
        )
    : [undefined];

  return (
    <div className="space-y-5">
      {isQueueView ? (
        <OrdersToolbar activeChannel={channel} activeView="list" query={q ?? ""} />
      ) : null}

      {isQueueView && counts ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="To pack" value={Number(counts.open ?? 0)} />
          <Stat label="To ship" value={Number(counts.packed ?? 0)} />
          <Stat
            label="Past dispatch deadline"
            value={Number(counts.late ?? 0)}
            tone={Number(counts.late ?? 0) > 0 ? "danger" : undefined}
          />
        </div>
      ) : null}

      <OrderTable rows={data} />
    </div>
  );
}
