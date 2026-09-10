"use server";

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
  type Channel,
} from "@/db/schema";
import { ENABLED_CHANNELS, isChannelEnabled } from "@/config/features";
import { requireUser } from "@/lib/auth";
import { OPEN_STATUSES } from "@/lib/fulfilment";

import type { OrderRow } from "./order-table";
import { getRestockPlan } from "./planner-actions";
import type { RestockPlan } from "./planner-actions";
import {
  getCancellationCounts,
  getCancellationRecords,
  getToShipPickList,
  type CancellationRecord,
  type PickRow,
} from "./queries";

/**
 * One call that returns everything a given Orders tab needs.
 *
 * This used to live inline in `page.tsx`, which meant the only way to see
 * another tab was a full server round trip: every switch between "To ship" and
 * "Shipped" and back re-ran the same queries against the database. Pulling it
 * into a callable action lets the client fetch a tab once and keep it, and is
 * the whole reason the cache in `stores/orders-cache` can exist.
 *
 * The page still calls this on the server for the first paint, so there is no
 * loading flash on a cold open and the URL stays shareable.
 */

const PAGE_SIZE = 200;

export interface OrdersViewParams {
  channel?: string;
  status?: string;
  q?: string;
  view?: string;
  resolved?: string;
}

export type OrdersView =
  | { kind: "planner"; channel?: Channel; query: string; plan: RestockPlan }
  | { kind: "collection"; channel?: Channel; query: string; rows: PickRow[] }
  | {
      kind: "cancellations";
      resolved: boolean;
      records: CancellationRecord[];
      counts: { pending: number; completed: number };
    }
  | {
      kind: "list";
      channel?: Channel;
      query: string;
      isQueueView: boolean;
      rows: OrderRow[];
      counts: { open: number; packed: number; late: number } | null;
    };

export async function getOrdersView(params: OrdersViewParams): Promise<OrdersView> {
  await requireUser();

  const channel = channelEnum.enumValues.find(
    (c) => c === params.channel && isChannelEnabled(c),
  );
  const view =
    params.view === "collection" || params.view === "cancellations" || params.view === "planner"
      ? params.view
      : "list";
  const q = params.q?.trim();

  if (view === "planner") {
    return { kind: "planner", channel, query: q ?? "", plan: await getRestockPlan() };
  }

  if (view === "collection") {
    return {
      kind: "collection",
      channel,
      query: q ?? "",
      rows: await getToShipPickList(channel),
    };
  }

  if (view === "cancellations") {
    const resolved = params.resolved === "1";
    const [records, counts] = await Promise.all([
      getCancellationRecords({ resolved, sinceDays: 30 }),
      getCancellationCounts(30),
    ]);
    return { kind: "cancellations", resolved, records, counts };
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
    // The queue is what is still on our bench, so anything handed to the
    // courier drops out even though the channel still calls it open.
    filters.push(sql`COALESCE(${orderFulfilment.state}, 'to_pack') <> 'manifested'`);
  }
  const isQueueView = !status && !showAll;

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
        .where(
          inArray(
            orderItems.orderId,
            rows.map((r) => r.id),
          ),
        )
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

  // The split between "to pack" and "to ship" is ours, not the marketplace's:
  // Amazon calls every one of these Unshipped until the courier scans it.
  const [counts] = isQueueView
    ? await db
        .select({
          open: sql<number>`COUNT(*) FILTER (WHERE COALESCE(${orderFulfilment.state}, 'to_pack') = 'to_pack')::int`,
          packed: sql<number>`COUNT(*) FILTER (WHERE ${orderFulfilment.state} = 'packed')::int`,
          late: sql<number>`COUNT(*) FILTER (WHERE COALESCE(${orderFulfilment.state}, 'to_pack') = 'to_pack' AND ${orders.dispatchBy} < now())::int`,
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

  return {
    kind: "list",
    channel,
    query: q ?? "",
    isQueueView,
    rows: data,
    counts: counts
      ? {
          open: Number(counts.open ?? 0),
          packed: Number(counts.packed ?? 0),
          late: Number(counts.late ?? 0),
        }
      : null,
  };
}
