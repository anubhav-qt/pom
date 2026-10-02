import "server-only";

import { Type } from "@paribelle/pi-ai";
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";

import { db } from "@/db";
import {
  batchOrders,
  batches,
  financeTransactions,
  orderFinance,
  orderFulfilment,
  orderItems,
  orders,
  orderStatusEnum,
  orderStatusEvents,
  parcelScans,
  products,
  returns,
  shipments,
  users,
  type OrderStatus,
} from "@/db/schema";
import { ENABLED_CHANNELS } from "@/config/features";
import { dismissShipped24hLocal, mapAwbToOrder, markManifestedLocal, markPackedLocal, revertLocal } from "@/lib/fulfilment";
import { lookupScan } from "@/lib/scan";
import { recomputeReserved } from "@/lib/sync";
import {
  getCancellationCounts,
  getCancellationRecords,
  getOrderStatusBreakdown,
  getToShipPickList,
} from "@/app/(app)/orders/queries";

import { defineTool, ToolError } from "./types";
import { ist, istDay, listRefs, nextDay, num, OrderRefs, plural, resolveOrders, StringEnum } from "./util";

const STATUSES = orderStatusEnum.enumValues;
const QUEUES = ["to_pack", "packed", "shipped_24h", "late"] as const;

/** The Orders screen's queues, as SQL over orders ⟕ order_fulfilment. */
const QUEUE_SQL: Record<(typeof QUEUES)[number], SQL> = {
  to_pack: sql`${orders.status} IN ('new','ready_to_pack') AND COALESCE(${orderFulfilment.state}, 'to_pack') = 'to_pack' AND COALESCE(${orders.easyshipStatus}, '') <> 'PendingPickUp'`,
  packed: sql`(${orders.easyshipStatus} = 'PendingPickUp' OR ${orderFulfilment.state} = 'packed' OR ${orders.status} = 'packed') AND COALESCE(${orderFulfilment.state}, 'to_pack') <> 'manifested' AND ${orders.status} NOT IN ('cancelled','rto','returned')`,
  shipped_24h: sql`${orderFulfilment.state} = 'manifested' AND ${orderFulfilment.manifestedAt} >= now() - interval '24 hours' AND ${orders.status} NOT IN ('cancelled','rto','returned') AND ${orderFulfilment.dismissedAt} IS NULL`,
  late: sql`${orders.status} IN ('new','ready_to_pack') AND COALESCE(${orderFulfilment.state}, 'to_pack') = 'to_pack' AND COALESCE(${orders.easyshipStatus}, '') <> 'PendingPickUp' AND ${orders.dispatchBy} < now()`,
};

/* -------------------------------------------------------------------------- */
/* find_orders                                                                */
/* -------------------------------------------------------------------------- */

export const findOrders = defineTool({
  name: "find_orders",
  label: "Find orders",
  description: [
    "Search and list orders with any mix of filters, like the Orders screen but without its limits.",
    "`queue` picks one of the screen's queues: to_pack (Unshipped), packed (waiting for pickup), shipped_24h, late (to pack and past dispatch-by).",
    "`query` matches the marketplace order id, buyer, city, pincode, SKU (ours or the marketplace's), item title or AWB.",
    "Returns a page of orders with their items, plus the total that matched. For counts or sums across many orders prefer sql_query.",
  ].join(" "),
  parameters: Type.Object({
    query: Type.Optional(Type.String()),
    queue: Type.Optional(StringEnum(QUEUES)),
    statuses: Type.Optional(Type.Array(StringEnum(STATUSES), { description: "Marketplace statuses." })),
    channel: Type.Optional(Type.String({ description: "amazon, flipkart or meesho." })),
    orderedFrom: Type.Optional(Type.String({ description: "YYYY-MM-DD, India time, inclusive." })),
    orderedTo: Type.Optional(Type.String({ description: "YYYY-MM-DD, inclusive." })),
    dispatchByBefore: Type.Optional(Type.String({ description: "YYYY-MM-DD: dispatch-by earlier than this day." })),
    cod: Type.Optional(Type.Boolean()),
    unmapped: Type.Optional(Type.Boolean({ description: "Only orders with a SKU that has no product in the OMS." })),
    hasReturn: Type.Optional(Type.Boolean()),
    sort: Type.Optional(StringEnum(["dispatch_by", "newest", "oldest", "total"])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 300, description: "Default 50." })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  }),
  kind: "read",
  summary: (a) =>
    [a.queue, a.statuses?.join("/"), a.query && `"${a.query}"`, a.orderedFrom && `from ${a.orderedFrom}`, a.orderedTo && `to ${a.orderedTo}`]
      .filter(Boolean)
      .join(" · ") || "All orders",
  async execute(a) {
    const filters: SQL[] = [inArray(orders.channel, [...ENABLED_CHANNELS])];
    if (a.channel) filters.push(sql`${orders.channel}::text = ${a.channel}`);
    if (a.queue) filters.push(QUEUE_SQL[a.queue]);
    if (a.statuses?.length) filters.push(inArray(orders.status, a.statuses as OrderStatus[]));
    if (a.orderedFrom) filters.push(sql`${orders.orderedAt} >= ${istDay(a.orderedFrom, "orderedFrom").toISOString()}`);
    if (a.orderedTo) filters.push(sql`${orders.orderedAt} < ${nextDay(istDay(a.orderedTo, "orderedTo")).toISOString()}`);
    if (a.dispatchByBefore) filters.push(sql`${orders.dispatchBy} < ${istDay(a.dispatchByBefore, "dispatchByBefore").toISOString()}`);
    if (a.cod !== undefined) filters.push(eq(orders.isCod, a.cod));
    if (a.unmapped) filters.push(sql`EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = ${orders.id} AND oi.product_id IS NULL)`);
    if (a.hasReturn !== undefined) {
      filters.push(a.hasReturn ? sql`EXISTS (SELECT 1 FROM returns r WHERE r.order_id = ${orders.id})` : sql`NOT EXISTS (SELECT 1 FROM returns r WHERE r.order_id = ${orders.id})`);
    }
    const q = a.query?.trim();
    if (q) {
      const like = `%${q}%`;
      filters.push(
        or(
          sql`${orders.externalOrderId} ILIKE ${like}`,
          sql`${orders.buyerName} ILIKE ${like}`,
          sql`${orders.shipPincode} ILIKE ${like}`,
          sql`${orders.shipCity} ILIKE ${like}`,
          sql`EXISTS (SELECT 1 FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
                WHERE oi.order_id = ${orders.id} AND (oi.external_sku ILIKE ${like} OR p.sku ILIKE ${like} OR oi.title ILIKE ${like} OR oi.external_asin ILIKE ${like}))`,
          sql`EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = ${orders.id} AND s.awb ILIKE ${like})`,
        )!,
      );
    }
    const where = and(...filters);
    const order =
      a.sort === "newest"
        ? [desc(orders.orderedAt)]
        : a.sort === "oldest"
          ? [asc(orders.orderedAt)]
          : a.sort === "total"
            ? [sql`${orders.totalAmount} DESC NULLS LAST`]
            : a.sort === "dispatch_by" || a.queue
              ? [sql`${orders.dispatchBy} ASC NULLS LAST`, desc(orders.orderedAt)]
              : [desc(orders.orderedAt)];
    const limit = a.limit ?? 50;

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id: orders.id,
          channel: orders.channel,
          externalOrderId: orders.externalOrderId,
          status: orders.status,
          easyship: orders.easyshipStatus,
          state: orderFulfilment.state,
          orderedAt: orders.orderedAt,
          dispatchBy: orders.dispatchBy,
          buyer: orders.buyerName,
          city: orders.shipCity,
          state_: orders.shipState,
          pincode: orders.shipPincode,
          total: orders.totalAmount,
          cod: orders.isCod,
        })
        .from(orders)
        .leftJoin(orderFulfilment, eq(orderFulfilment.orderId, orders.id))
        .where(where)
        .orderBy(...order)
        .limit(limit)
        .offset(a.offset ?? 0),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(orders)
        .leftJoin(orderFulfilment, eq(orderFulfilment.orderId, orders.id))
        .where(where),
    ]);

    const ids = rows.map((r) => r.id);
    const items = ids.length
      ? await db
          .select({
            orderId: orderItems.orderId,
            sku: orderItems.externalSku,
            title: orderItems.title,
            quantity: orderItems.quantity,
            price: orderItems.unitPrice,
            cancelled: orderItems.cancelled,
            productId: orderItems.productId,
          })
          .from(orderItems)
          .where(inArray(orderItems.orderId, ids))
      : [];
    const awbs = ids.length
      ? await db.select({ orderId: shipments.orderId, awb: shipments.awb }).from(shipments).where(inArray(shipments.orderId, ids))
      : [];
    const awbOf = new Map(awbs.filter((s) => s.awb).map((s) => [s.orderId, s.awb]));

    return {
      data: {
        total,
        shown: rows.length,
        offset: a.offset ?? 0,
        orders: rows.map((r) => ({
          id: r.id,
          orderId: r.externalOrderId,
          channel: r.channel,
          status: r.status,
          floor: r.state ?? "to_pack",
          ...(r.easyship ? { easyship: r.easyship } : {}),
          ordered: ist(r.orderedAt),
          dispatchBy: ist(r.dispatchBy),
          buyer: r.buyer,
          place: [r.city, r.state_, r.pincode].filter(Boolean).join(", ") || null,
          total: num(r.total),
          cod: r.cod,
          ...(awbOf.get(r.id) ? { awb: awbOf.get(r.id) } : {}),
          items: items
            .filter((i) => i.orderId === r.id)
            .map((i) => ({
              sku: i.sku,
              title: i.title,
              qty: i.quantity,
              price: num(i.price),
              ...(i.cancelled ? { cancelled: true } : {}),
              ...(i.productId === null ? { unmapped: true } : {}),
            })),
        })),
      },
    };
  },
});

/* -------------------------------------------------------------------------- */
/* order_details                                                              */
/* -------------------------------------------------------------------------- */

export const orderDetails = defineTool({
  name: "order_details",
  label: "Order details",
  description:
    "Everything about one or more orders: items (with our product, bin, cost), shipment and AWB, our packing state and who did it, every status change and its check-in, returns, the money Amazon moved for it, the order's note and parcel scans. `raw` adds the marketplace's own record.",
  parameters: Type.Object({
    orders: OrderRefs,
    raw: Type.Optional(Type.Boolean({ description: "Include the marketplace's raw order JSON (long)." })),
  }),
  kind: "read",
  summary: (a) => listRefs(a.orders),
  async execute(a) {
    if (a.orders.length > 50) throw new ToolError("Up to 50 orders at a time.");
    const { ids, missing } = await resolveOrders(a.orders);
    if (ids.length === 0) throw new ToolError(`No such order: ${missing.join(", ")}.`);

    const [orderRows, itemRows, shipRows, fulfilRows, eventRows, returnRows, moneyRows, financeRows, scanRows] = await Promise.all([
      db.select().from(orders).where(inArray(orders.id, ids)),
      db
        .select({
          orderId: orderItems.orderId,
          sku: orderItems.externalSku,
          asin: orderItems.externalAsin,
          title: orderItems.title,
          quantity: orderItems.quantity,
          price: orderItems.unitPrice,
          cancelled: orderItems.cancelled,
          productId: products.id,
          ourSku: products.sku,
          name: products.name,
          bin: products.binLocation,
          cost: products.costPrice,
          image: products.imageUrl,
        })
        .from(orderItems)
        .leftJoin(products, eq(products.id, orderItems.productId))
        .where(inArray(orderItems.orderId, ids)),
      db
        .select({
          orderId: shipments.orderId,
          courier: shipments.courier,
          awb: shipments.awb,
          shipmentId: shipments.externalShipmentId,
          packedAt: shipments.packedAt,
          dispatchedAt: shipments.dispatchedAt,
          label: shipments.labelFetchedAt,
        })
        .from(shipments)
        .where(inArray(shipments.orderId, ids)),
      db
        .select({
          orderId: orderFulfilment.orderId,
          state: orderFulfilment.state,
          packedAt: orderFulfilment.packedAt,
          packedBy: sql<string | null>`(SELECT name FROM users WHERE id = ${orderFulfilment.packedBy})`,
          manifestedAt: orderFulfilment.manifestedAt,
          manifestedBy: sql<string | null>`(SELECT name FROM users WHERE id = ${orderFulfilment.manifestedBy})`,
          dismissedAt: orderFulfilment.dismissedAt,
        })
        .from(orderFulfilment)
        .where(inArray(orderFulfilment.orderId, ids)),
      db
        .select({
          eventId: orderStatusEvents.id,
          orderId: orderStatusEvents.orderId,
          from: orderStatusEvents.fromStatus,
          to: orderStatusEvents.toStatus,
          at: orderStatusEvents.detectedAt,
          checkedInAt: orderStatusEvents.checkedInAt,
          checkedInBy: users.name,
          itemBack: orderStatusEvents.itemBack,
          note: orderStatusEvents.checkinNote,
        })
        .from(orderStatusEvents)
        .leftJoin(users, eq(users.id, orderStatusEvents.checkedInBy))
        .where(inArray(orderStatusEvents.orderId, ids))
        .orderBy(asc(orderStatusEvents.detectedAt)),
      db.select().from(returns).where(inArray(returns.orderId, ids)),
      db.select().from(orderFinance).where(inArray(orderFinance.orderId, ids)),
      db
        .select({
          orderId: financeTransactions.externalOrderId,
          type: financeTransactions.type,
          status: financeTransactions.status,
          postedAt: financeTransactions.postedAt,
          total: financeTransactions.total,
          principal: financeTransactions.principal,
          tax: financeTransactions.tax,
          fees: financeTransactions.fees,
          postage: financeTransactions.postage,
          promo: financeTransactions.promo,
          tcsTds: financeTransactions.tcsTds,
        })
        .from(financeTransactions)
        .innerJoin(orders, eq(orders.externalOrderId, financeTransactions.externalOrderId))
        .where(inArray(orders.id, ids))
        .orderBy(asc(financeTransactions.postedAt)),
      db
        .select({
          orderId: parcelScans.orderId,
          station: parcelScans.station,
          code: parcelScans.code,
          applied: parcelScans.applied,
          rejected: parcelScans.rejectedReason,
          at: parcelScans.scannedAt,
          by: users.name,
        })
        .from(parcelScans)
        .leftJoin(users, eq(users.id, parcelScans.scannedBy))
        .where(inArray(parcelScans.orderId, ids)),
    ]);

    const out = orderRows.map((o) => {
      const ship = shipRows.find((s) => s.orderId === o.id);
      const fulfil = fulfilRows.find((f) => f.orderId === o.id);
      const money = moneyRows.find((m) => m.orderId === o.id);
      return {
        id: o.id,
        orderId: o.externalOrderId,
        channel: o.channel,
        status: o.status,
        easyship: o.easyshipStatus,
        ordered: ist(o.orderedAt),
        dispatchBy: ist(o.dispatchBy),
        buyer: o.buyerName,
        ship: { city: o.shipCity, state: o.shipState, pincode: o.shipPincode },
        total: num(o.totalAmount),
        cod: o.isCod,
        updatedOnMarketplace: ist(o.channelUpdatedAt),
        items: itemRows
          .filter((i) => i.orderId === o.id)
          .map((i) => ({
            sku: i.sku,
            asin: i.asin,
            title: i.title,
            qty: i.quantity,
            price: num(i.price),
            cancelled: i.cancelled,
            product: i.productId ? { id: i.productId, sku: i.ourSku, name: i.name, bin: i.bin, cost: num(i.cost), image: i.image } : null,
          })),
        shipment: ship
          ? { courier: ship.courier, awb: ship.awb, shipmentId: ship.shipmentId, packed: ist(ship.packedAt), dispatched: ist(ship.dispatchedAt), label: !!ship.label }
          : null,
        floor: fulfil
          ? {
              state: fulfil.state,
              packed: fulfil.packedAt ? `${ist(fulfil.packedAt)} by ${fulfil.packedBy ?? "?"}` : null,
              shipped: fulfil.manifestedAt ? `${ist(fulfil.manifestedAt)} by ${fulfil.manifestedBy ?? "?"}` : null,
              dismissedFrom24h: ist(fulfil.dismissedAt),
            }
          : { state: "to_pack" },
        statusChanges: eventRows
          .filter((e) => e.orderId === o.id)
          .map((e) => ({
            eventId: e.eventId,
            change: `${e.from ?? "∅"} → ${e.to}`,
            at: ist(e.at),
            checkedIn: e.checkedInAt ? `${ist(e.checkedInAt)}${e.checkedInBy ? ` by ${e.checkedInBy}` : " (auto)"}` : null,
            itemBack: e.itemBack,
            note: e.note,
          })),
        returns: returnRows
          .filter((r) => r.orderId === o.id)
          .map((r) => ({
            returnId: r.id,
            kind: r.kind,
            reason: r.reason,
            status: r.status,
            requested: ist(r.requestedAt),
            received: ist(r.receivedAt),
            restocked: r.restocked,
            outcome: r.outcome,
            refund: num(r.refundAmount),
            labelCost: num(r.labelCost),
            note: r.conditionNote,
          })),
        money: financeRows
          .filter((f) => f.orderId === o.externalOrderId)
          .map((f) => ({
            type: f.type,
            status: f.status,
            posted: ist(f.postedAt),
            total: num(f.total),
            principal: num(f.principal),
            tax: num(f.tax),
            fees: num(f.fees),
            postage: num(f.postage),
            promo: num(f.promo),
            tcsTds: num(f.tcsTds),
          })),
        frozenCost: money ? num(money.costPrice) : null,
        note: money?.note ?? null,
        scans: scanRows
          .filter((s) => s.orderId === o.id)
          .map((s) => ({ station: s.station, code: s.code, applied: s.applied, rejected: s.rejected, at: ist(s.at), by: s.by })),
        ...(a.raw ? { raw: o.raw } : {}),
      };
    });
    return { data: missing.length ? { orders: out, notFound: missing } : { orders: out } };
  },
});

/* -------------------------------------------------------------------------- */
/* orders_overview                                                            */
/* -------------------------------------------------------------------------- */

export const ordersOverview = defineTool({
  name: "orders_overview",
  label: "Orders overview",
  description:
    "Where the floor stands: how many orders are in each queue (to pack, packed, shipped in 24h, late), every marketplace status's count, the pick list (open order lines rolled up by SKU with units, bins and earliest dispatch-by) and the cancellations/RTOs waiting for check-in.",
  parameters: Type.Object({
    include: Type.Optional(
      Type.Array(StringEnum(["queues", "statuses", "pick_list", "cancellations"]), {
        description: "Default: all four.",
      }),
    ),
    pickListLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Rows of the pick list (default 60)." })),
  }),
  kind: "read",
  summary: (a) => (a.include?.length ? a.include.join(", ") : "Queues, statuses, pick list, cancellations"),
  async execute(a) {
    const want = new Set(a.include?.length ? a.include : ["queues", "statuses", "pick_list", "cancellations"]);
    const out: Record<string, unknown> = {};
    await Promise.all([
      want.has("queues") &&
        db
          .select({
            toPack: sql<number>`COUNT(*) FILTER (WHERE ${QUEUE_SQL.to_pack})::int`,
            packed: sql<number>`COUNT(*) FILTER (WHERE ${QUEUE_SQL.packed})::int`,
            shipped24h: sql<number>`COUNT(*) FILTER (WHERE ${QUEUE_SQL.shipped_24h})::int`,
            late: sql<number>`COUNT(*) FILTER (WHERE ${QUEUE_SQL.late})::int`,
          })
          .from(orders)
          .leftJoin(orderFulfilment, eq(orderFulfilment.orderId, orders.id))
          .where(inArray(orders.channel, [...ENABLED_CHANNELS]))
          .then(([r]) => (out.queues = r)),
      want.has("statuses") && getOrderStatusBreakdown().then((r) => (out.statuses = Object.fromEntries(r.map((s) => [s.status, s.count])))),
      want.has("pick_list") &&
        getToShipPickList().then((rows) => {
          const limit = a.pickListLimit ?? 60;
          out.pickList = {
            lines: rows.length,
            units: rows.reduce((s, r) => s + r.unitsNeeded, 0),
            rows: rows.slice(0, limit).map((r) => ({
              sku: r.externalSku,
              title: r.title,
              units: r.unitsNeeded,
              orders: r.orderCount,
              late: r.lateCount,
              bin: r.binLocation,
              mapped: r.mapped,
              earliestDispatchBy: ist(r.earliestDispatchBy),
            })),
          };
        }),
      want.has("cancellations") && getCancellationCounts(30).then((c) => (out.cancellationsLast30Days = c)),
    ]);
    return { data: out };
  },
});

/* -------------------------------------------------------------------------- */
/* fulfilment                                                                 */
/* -------------------------------------------------------------------------- */

const FULFIL_ACTIONS = ["pack", "ship", "revert", "dismiss_shipped_24h", "map_awb"] as const;

export const fulfilment = defineTool({
  name: "fulfilment",
  label: "Packing and shipping",
  description: [
    "Move orders through our own floor state (never the marketplace's status, which only a sync changes):",
    "pack (to Packed, records who), ship (Packed → handed to the courier, makes a manifest batch; 'Mark shipped' on the screen),",
    "revert (back to To pack, clears packed/shipped stamps), dismiss_shipped_24h (clears them off the Shipped 24h list only),",
    "map_awb (ties a courier AWB to ONE order; `awb` required). Stock reservations are recounted afterwards.",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(FULFIL_ACTIONS),
    orders: OrderRefs,
    awb: Type.Optional(Type.String()),
  }),
  kind: "write",
  summary: (a) =>
    a.action === "map_awb"
      ? `Tie AWB ${a.awb ?? "?"} to order ${a.orders[0]}`
      : `${{ pack: "Mark packed", ship: "Mark shipped (manifest)", revert: "Put back to To pack", dismiss_shipped_24h: "Clear from Shipped 24h" }[a.action]}: ${plural(a.orders.length, "order")} (${listRefs(a.orders)})`,
  async execute(a, ctx) {
    const { ids, missing } = await resolveOrders(a.orders);
    if (ids.length === 0) throw new ToolError(`No such order: ${missing.join(", ")}.`);
    const userId = ctx.user.id;
    let result: Record<string, unknown>;
    switch (a.action) {
      case "pack": {
        const { moved } = await markPackedLocal(ids, userId);
        await recomputeReserved();
        result = { packed: moved.length, alreadyPacked: ids.length - moved.length };
        break;
      }
      case "ship": {
        const { moved } = await markManifestedLocal(ids, userId);
        let batchId: number | null = null;
        if (moved.length > 0) {
          const [batch] = await db.insert(batches).values({ kind: "manifest", createdBy: userId }).returning({ id: batches.id });
          batchId = batch.id;
          await db.insert(batchOrders).values(moved.map((orderId) => ({ batchId: batch.id, orderId })));
        }
        await recomputeReserved();
        result = { shipped: moved.length, alreadyShipped: ids.length - moved.length, manifestBatch: batchId };
        break;
      }
      case "revert": {
        const { moved } = await revertLocal(ids);
        await recomputeReserved();
        result = { reverted: moved.length };
        break;
      }
      case "dismiss_shipped_24h": {
        const { moved } = await dismissShipped24hLocal(ids, userId);
        result = { cleared: moved.length, notShipped: ids.length - moved.length };
        break;
      }
      case "map_awb": {
        if (!a.awb?.trim()) throw new ToolError("Give the AWB to tie.");
        if (ids.length !== 1) throw new ToolError("An AWB goes on exactly one order.");
        const res = await mapAwbToOrder(ids[0], a.awb, userId);
        if (!res.ok) throw new ToolError(res.error);
        result = { mapped: true };
        break;
      }
    }
    return { data: missing.length ? { ...result, notFound: missing } : result };
  },
});

/* -------------------------------------------------------------------------- */
/* cancellations                                                              */
/* -------------------------------------------------------------------------- */

export const cancellations = defineTool({
  name: "cancellations",
  label: "Cancelled and RTO check-in",
  description: [
    "The Cancelled & RTO list. list: pending (or with resolved=true, completed) records, each with its eventId, stage",
    "(ready = Amazon confirmed the parcel is back; awaiting = shipped then cancelled, not confirmed back; auto = never shipped) and items.",
    "check_in: tick records off, saying whether the item physically came back (itemBack) with an optional note.",
    "reopen: send checked-in records back to pending. Name records by eventId, or by order (its terminal status change is used).",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["list", "check_in", "reopen"]),
    resolved: Type.Optional(Type.Boolean({ description: "list: completed records instead of pending." })),
    sinceDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 3650, description: "list: only changes detected in the last N days (default 30)." })),
    eventIds: Type.Optional(Type.Array(Type.Integer())),
    orders: Type.Optional(OrderRefs),
    itemBack: Type.Optional(Type.Boolean({ description: "check_in: the goods physically came back." })),
    note: Type.Optional(Type.String()),
  }),
  kind: (a) => (a.action === "list" ? "read" : "write"),
  summary: (a) =>
    a.action === "list"
      ? `${a.resolved ? "Completed" : "Pending"} records`
      : `${a.action === "check_in" ? `Check in${a.itemBack === false ? " (item NOT back)" : a.itemBack ? " (item back)" : ""}` : "Reopen"}: ${listRefs([...(a.eventIds ?? []).map((e) => `event ${e}`), ...(a.orders ?? [])])}`,
  async execute(a, ctx) {
    if (a.action === "list") {
      const records = await getCancellationRecords({ resolved: a.resolved ?? false, sinceDays: a.sinceDays ?? 30 });
      return {
        data: {
          count: records.length,
          records: records.map((r) => ({
            eventId: r.eventId,
            orderId: r.externalOrderId,
            id: r.orderId,
            change: `${r.fromStatus ?? "∅"} → ${r.toStatus}`,
            stage: r.stage,
            detected: ist(r.detectedAt),
            ordered: ist(r.orderedAt),
            total: num(r.totalAmount),
            checkedIn: r.checkedInAt ? `${ist(r.checkedInAt)}${r.checkedInByName ? ` by ${r.checkedInByName}` : ""}` : null,
            itemBack: r.itemBack,
            note: r.checkinNote,
            items: r.items.map((i) => `${i.quantity}× ${i.sku}${i.title ? ` (${i.title.slice(0, 60)})` : ""}`),
          })),
        },
      };
    }

    const eventIds = new Set(a.eventIds ?? []);
    if (a.orders?.length) {
      const { ids, missing } = await resolveOrders(a.orders);
      if (missing.length) throw new ToolError(`No such order: ${missing.join(", ")}.`);
      const events = await db
        .select({ id: orderStatusEvents.id })
        .from(orderStatusEvents)
        .where(and(inArray(orderStatusEvents.orderId, ids), inArray(orderStatusEvents.toStatus, ["cancelled", "rto", "returned"])));
      for (const e of events) eventIds.add(e.id);
    }
    if (eventIds.size === 0) throw new ToolError("Name the records (eventIds or orders).");
    const terminal = inArray(orderStatusEvents.toStatus, ["cancelled", "rto", "returned"]);

    if (a.action === "check_in") {
      if (a.itemBack === undefined) throw new ToolError("Say whether the item came back (itemBack).");
      const rows = await db
        .update(orderStatusEvents)
        .set({ checkedInAt: new Date(), checkedInBy: ctx.user.id, itemBack: a.itemBack, checkinNote: a.note?.trim() || null })
        .where(and(inArray(orderStatusEvents.id, [...eventIds]), terminal, isNull(orderStatusEvents.checkedInAt)))
        .returning({ id: orderStatusEvents.id });
      return { data: { checkedIn: rows.length, skipped: eventIds.size - rows.length, note: rows.length < eventIds.size ? "Skipped ones were already checked in or aren't cancellations." : undefined } };
    }
    const rows = await db
      .update(orderStatusEvents)
      .set({ checkedInAt: null, checkedInBy: null, itemBack: null, checkinNote: null })
      .where(and(inArray(orderStatusEvents.id, [...eventIds]), terminal))
      .returning({ id: orderStatusEvents.id });
    return { data: { reopened: rows.length } };
  },
});

/* -------------------------------------------------------------------------- */
/* scan_lookup                                                                */
/* -------------------------------------------------------------------------- */

export const scanLookup = defineTool({
  name: "scan_lookup",
  label: "Look up a barcode",
  description:
    "What a scanned or typed code matches, the way the scan bench reads it: an AWB, a marketplace order id, a shipment id or a SKU. Read only; says which order it is and what's in it.",
  parameters: Type.Object({ codes: Type.Array(Type.String(), { minItems: 1, maxItems: 30 }) }),
  kind: "read",
  summary: (a) => listRefs(a.codes),
  async execute(a) {
    const results = [];
    for (const code of a.codes) {
      results.push({ code, result: await lookupScan(code).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) })) });
    }
    return { data: results };
  },
});
