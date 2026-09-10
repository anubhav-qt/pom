import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  orderFulfilment,
  orders,
  parcelScans,
  shipments,
  type FulfilmentState,
  type ScanStation,
} from "@/db/schema";

/**
 * Our dispatch-floor state, and the one place that decides how it combines with
 * the marketplace's.
 *
 * The rule is: **the channel says whether an order is still live; we say how far
 * through our bench it is.** Those are different questions and they now live in
 * different columns. `orders.status` is overwritten wholesale by every sync and
 * we never write to it; `order_fulfilment.state` is ours and no sync touches it.
 *
 * Reading the queue therefore always means combining both, which is what
 * `openQueueWhere` is for. Get that predicate wrong in one screen and the
 * counts stop agreeing with each other.
 */

/**
 * Channel statuses meaning "the marketplace still expects us to dispatch this".
 *
 * Amazon only ever reports `new` here (its `Unshipped`); `ready_to_pack` and
 * `packed` are in the list for Flipkart, whose adapter does report them and
 * which is currently switched off. This is the *channel's* opinion only. Our
 * own packed/manifested state is no longer stored here.
 */
export const OPEN_STATUSES = ["new", "ready_to_pack", "packed"] as const;

/** No row means nobody has touched it yet, which is the same as `to_pack`. */
export const stateSql = sql<FulfilmentState>`COALESCE(${orderFulfilment.state}, 'to_pack')`;

/**
 * The "To Ship" queue: the channel still wants it dispatched, and we have not
 * yet handed it to the courier.
 *
 * Manifested orders have to be excluded explicitly now. They used to fall out
 * on their own because we overwrote `orders.status` with `manifested` and that
 * value is not in OPEN_STATUSES, but the channel status now stays `new` right
 * up until Amazon notices the pickup, so without this they would sit in the
 * queue forever.
 *
 * Every query using this must LEFT JOIN `order_fulfilment` on the order id.
 */
export const openQueueWhere = sql`${orders.status} IN ('new','ready_to_pack','packed') AND ${stateSql} <> 'manifested'`;

/** Raw-SQL equivalents, for the handful of places that build SQL by hand. */
export const RAW_OPEN_QUEUE = `o.status IN ('new','ready_to_pack','packed')
      AND COALESCE(f.state, 'to_pack') <> 'manifested'`;

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

async function setState(
  orderIds: number[],
  state: FulfilmentState,
  userId: number | null,
): Promise<number> {
  if (orderIds.length === 0) return 0;

  const now = new Date();
  const stamp =
    state === "packed"
      ? { packedAt: now, packedBy: userId }
      : state === "manifested"
        ? { packedAt: now, packedBy: userId, manifestedAt: now, manifestedBy: userId }
        : { packedAt: null, packedBy: null, manifestedAt: null, manifestedBy: null };

  const rows = await db
    .insert(orderFulfilment)
    .values(orderIds.map((orderId) => ({ orderId, state, ...stamp })))
    .onConflictDoUpdate({
      target: orderFulfilment.orderId,
      set: {
        state: sql`excluded.state`,
        // Keep the first packed stamp rather than the latest: it records when
        // the parcel was actually boxed, and manifesting must not overwrite it.
        packedAt:
          state === "to_pack"
            ? sql`NULL`
            : sql`COALESCE(${orderFulfilment.packedAt}, excluded.packed_at)`,
        packedBy:
          state === "to_pack"
            ? sql`NULL`
            : sql`COALESCE(${orderFulfilment.packedBy}, excluded.packed_by)`,
        manifestedAt: state === "manifested" ? sql`excluded.manifested_at` : sql`NULL`,
        manifestedBy: state === "manifested" ? sql`excluded.manifested_by` : sql`NULL`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ orderId: orderFulfilment.orderId });

  return rows.length;
}

/**
 * Mark parcels packed. Idempotent: re-packing an already-packed order is a
 * no-op rather than an error, because a scanner firing twice is normal.
 * Returns the ids that actually moved, so the caller knows what to count.
 */
export async function markPackedLocal(orderIds: number[], userId: number | null) {
  if (orderIds.length === 0) return { moved: [] as number[] };

  const current = await db
    .select({ orderId: orderFulfilment.orderId, state: orderFulfilment.state })
    .from(orderFulfilment)
    .where(inArray(orderFulfilment.orderId, orderIds));
  const alreadyDone = new Set(
    current.filter((r) => r.state !== "to_pack").map((r) => r.orderId),
  );
  const moved = orderIds.filter((id) => !alreadyDone.has(id));

  await setState(moved, "packed", userId);

  // `shipments.packed_at` is kept in step because label printing and the
  // manifest PDF both read it. It is a mirror of our state, not a second copy
  // of the truth.
  for (const orderId of moved) {
    const [existing] = await db
      .select({ id: shipments.id })
      .from(shipments)
      .where(eq(shipments.orderId, orderId))
      .limit(1);
    if (existing) {
      await db
        .update(shipments)
        .set({ packedAt: new Date(), packedBy: userId })
        .where(eq(shipments.id, existing.id));
    } else {
      await db.insert(shipments).values({ orderId, packedAt: new Date(), packedBy: userId });
    }
  }

  return { moved };
}

/** Hand parcels to courier or mark dispatched on outbound scan. */
export async function markManifestedLocal(orderIds: number[], userId: number | null) {
  if (orderIds.length === 0) return { moved: [] as number[] };

  const current = await db
    .select({ orderId: orderFulfilment.orderId, state: orderFulfilment.state })
    .from(orderFulfilment)
    .where(inArray(orderFulfilment.orderId, orderIds));
  const alreadyDone = new Set(
    current.filter((r) => r.state === "manifested").map((r) => r.orderId),
  );
  const eligible = orderIds.filter((id) => !alreadyDone.has(id));

  await setState(eligible, "manifested", userId);

  for (const orderId of eligible) {
    const [existing] = await db
      .select({ id: shipments.id })
      .from(shipments)
      .where(eq(shipments.orderId, orderId))
      .limit(1);
    if (existing) {
      await db
        .update(shipments)
        .set({ dispatchedAt: new Date() })
        .where(eq(shipments.id, existing.id));
    } else {
      await db.insert(shipments).values({ orderId, dispatchedAt: new Date() });
    }
  }

  return { moved: eligible };
}

/** Put parcels back on the bench when something was scanned or clicked wrongly. */
export async function revertLocal(orderIds: number[]) {
  if (orderIds.length === 0) return { moved: [] as number[] };

  await setState(orderIds, "to_pack", null);
  await db
    .update(shipments)
    .set({ packedAt: null, packedBy: null, dispatchedAt: null })
    .where(inArray(shipments.orderId, orderIds));

  return { moved: orderIds };
}

/* -------------------------------------------------------------------------- */
/* Scan log                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Record a scan. Every scan is logged, including the ones that changed nothing.
 * A refused scan is exactly the event someone will want to look up later
 * ("we definitely scanned that parcel"), and dropping it would make the log
 * useless for the one question it exists to answer.
 */
export async function recordScan(input: {
  orderId: number | null;
  station: ScanStation;
  code: string;
  matchedOn?: string | null;
  itemBack?: boolean | null;
  note?: string | null;
  applied: boolean;
  rejectedReason?: string | null;
  scannedBy: number | null;
}) {
  await db.insert(parcelScans).values({
    orderId: input.orderId,
    station: input.station,
    code: input.code.trim().slice(0, 200),
    matchedOn: input.matchedOn ?? null,
    itemBack: input.itemBack ?? null,
    note: input.note?.trim() || null,
    applied: input.applied,
    rejectedReason: input.rejectedReason ?? null,
    scannedBy: input.scannedBy,
  });
}

/** Recent scans at one station, for the modal's running list. */
export async function recentScans(station: ScanStation, limit = 20) {
  return db
    .select({
      id: parcelScans.id,
      code: parcelScans.code,
      applied: parcelScans.applied,
      rejectedReason: parcelScans.rejectedReason,
      itemBack: parcelScans.itemBack,
      scannedAt: parcelScans.scannedAt,
      externalOrderId: orders.externalOrderId,
    })
    .from(parcelScans)
    .leftJoin(orders, eq(orders.id, parcelScans.orderId))
    .where(eq(parcelScans.station, station))
    .orderBy(sql`${parcelScans.scannedAt} DESC`)
    .limit(limit);
}
