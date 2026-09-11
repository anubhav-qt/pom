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
  tab?: "unshipped" | "packed" | "shipped24h";
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
      activeTab: "unshipped" | "packed" | "shipped24h";
      rows: OrderRow[];
      counts: {
        unshipped: number;
        packed: number;
        shipped24h: number;
        late: number;
      } | null;
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
  const isQueueView = !status && !showAll;
  const activeTab: "unshipped" | "packed" | "shipped24h" =
    params.tab === "packed" || params.tab === "shipped24h" ? params.tab : "unshipped";

  if (status) {
    filters.push(eq(orders.status, status));
  } else if (!showAll) {
    if (activeTab === "unshipped") {
      filters.push(inArray(orders.status, ["new", "ready_to_pack"]));
      filters.push(sql`COALESCE(${orderFulfilment.state}, 'to_pack') = 'to_pack'`);
      filters.push(sql`COALESCE(${orders.easyshipStatus}, '') <> 'PendingPickUp'`);
    } else if (activeTab === "packed") {
      filters.push(
        sql`(${orders.easyshipStatus} = 'PendingPickUp' OR ${orderFulfilment.state} = 'packed' OR ${orders.status} = 'packed')`,
      );
      filters.push(sql`COALESCE(${orderFulfilment.state}, 'to_pack') <> 'manifested'`);
      filters.push(sql`${orders.status} NOT IN ('cancelled', 'rto', 'returned')`);
    } else if (activeTab === "shipped24h") {
      filters.push(sql`${orderFulfilment.state} = 'manifested'`);
      filters.push(sql`${orderFulfilment.manifestedAt} >= now() - interval '24 hours'`);
      filters.push(sql`${orders.status} NOT IN ('cancelled', 'rto', 'returned')`);
      // Dismissed by hand from this queue — the order itself is untouched, this
      // just stops it cluttering the 24h review list.
      filters.push(sql`${orderFulfilment.dismissedAt} IS NULL`);
    }
  }

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
    .select({
      order: orders,
      fulfilmentState: orderFulfilment.state,
      manifestedAt: orderFulfilment.manifestedAt,
    })
    .from(orders)
    .leftJoin(orderFulfilment, eq(orderFulfilment.orderId, orders.id))
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(
      activeTab === "shipped24h" ? desc(orderFulfilment.manifestedAt) : orders.dispatchBy,
      desc(orders.orderedAt),
    )
    .limit(PAGE_SIZE)
    .then((res) =>
      res.map((r) => ({
        ...r.order,
        fulfilmentState: r.fulfilmentState,
        manifestedAt: r.manifestedAt,
      })),
    );

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

  const data: OrderRow[] = rows.map((o) => {
    const rawStatus = (o.raw as Record<string, any> | null)?.OrderStatus;
    return {
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
      isPending:
        rawStatus === "Pending" ||
        rawStatus === "PendingAvailability" ||
        (o.status === "new" && !o.buyerName),
      items: (itemsByOrder.get(o.id) ?? []).map((it) => ({
        sku: it.externalSku,
        title: it.title,
        quantity: it.quantity,
        mapped: it.productId !== null,
        imageUrl: it.pImage ?? it.ciImage ?? null,
      })),
    };
  });

  const [counts] = isQueueView
    ? await db
        .select({
          unshipped: sql<number>`COUNT(*) FILTER (
            WHERE ${orders.status} IN ('new', 'ready_to_pack')
              AND COALESCE(${orderFulfilment.state}, 'to_pack') = 'to_pack'
              AND COALESCE(${orders.easyshipStatus}, '') <> 'PendingPickUp'
          )::int`,
          packed: sql<number>`COUNT(*) FILTER (
            WHERE (${orders.easyshipStatus} = 'PendingPickUp' OR ${orderFulfilment.state} = 'packed' OR ${orders.status} = 'packed')
              AND COALESCE(${orderFulfilment.state}, 'to_pack') <> 'manifested'
              AND ${orders.status} NOT IN ('cancelled', 'rto', 'returned')
          )::int`,
          shipped24h: sql<number>`COUNT(*) FILTER (
            WHERE ${orderFulfilment.state} = 'manifested'
              AND ${orderFulfilment.manifestedAt} >= now() - interval '24 hours'
              AND ${orders.status} NOT IN ('cancelled', 'rto', 'returned')
              AND ${orderFulfilment.dismissedAt} IS NULL
          )::int`,
          late: sql<number>`COUNT(*) FILTER (
            WHERE ${orders.status} IN ('new', 'ready_to_pack')
              AND COALESCE(${orderFulfilment.state}, 'to_pack') = 'to_pack'
              AND COALESCE(${orders.easyshipStatus}, '') <> 'PendingPickUp'
              AND ${orders.dispatchBy} < now()
          )::int`,
        })
        .from(orders)
        .leftJoin(orderFulfilment, eq(orderFulfilment.orderId, orders.id))
        .where(
          and(
            inArray(orders.channel, [...ENABLED_CHANNELS]),
            channel ? eq(orders.channel, channel) : undefined,
          ),
        )
    : [undefined];

  return {
    kind: "list",
    channel,
    query: q ?? "",
    isQueueView,
    activeTab,
    rows: data,
    counts: counts
      ? {
          unshipped: Number(counts.unshipped ?? 0),
          packed: Number(counts.packed ?? 0),
          shipped24h: Number(counts.shipped24h ?? 0),
          late: Number(counts.late ?? 0),
        }
      : null,
  };
}
