import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { after } from "next/server";

import { adapterFor } from "@/channels";
import { AmazonAdapter } from "@/channels/amazon";
import type { CanonicalOrder, CanonicalReturn } from "@/channels/types";
import { isChannelEnabled } from "@/config/features";
import { db } from "@/db";
import {
  catalogImages,
  channelAccounts,
  channelListings,
  inventory,
  orderItems,
  orders,
  orderStatusEvents,
  products,
  returns,
  shipments,
  syncRuns,
  type ChannelAccount,
  type OrderStatus,
} from "@/db/schema";

/** Statuses that mean the parcel had physically left us — a transition out of
 *  one of these into cancelled/RTO leaves something to receive back, so it
 *  needs a human check-in. Anything else auto-resolves. */
const SHIPPED_ISH: OrderStatus[] = ["packed", "manifested", "shipped", "delivered"];

/**
 * How far a status is through the pipeline. Used so a channel that still thinks
 * an order is "new" cannot drag it back from "packed" — the warehouse floor is
 * ahead of the marketplace between packing and manifesting, and losing that
 * would make someone pack the same parcel twice.
 */
const STATUS_RANK: Record<OrderStatus, number> = {
  new: 0,
  ready_to_pack: 1,
  packed: 2,
  manifested: 3,
  shipped: 4,
  delivered: 5,
  cancelled: 99,
  rto: 99,
  returned: 99,
};

/** Channel-declared endings always win, whatever the floor thinks. */
const TERMINAL: OrderStatus[] = ["cancelled", "rto", "returned"];

export function reconcileStatus(current: OrderStatus, incoming: OrderStatus): OrderStatus {
  if (TERMINAL.includes(incoming)) return incoming;
  if (TERMINAL.includes(current)) return current;
  return STATUS_RANK[incoming] > STATUS_RANK[current] ? incoming : current;
}

/* -------------------------------------------------------------------------- */
/* Ingest                                                                     */
/* -------------------------------------------------------------------------- */

export interface IngestResult {
  seen: number;
  written: number;
  unmappedSkus: string[];
}

/**
 * Write canonical orders into the database. Idempotent — re-running with the
 * same input is a no-op, which is what makes the deliberately-overlapping sync
 * cursors safe.
 */
export async function ingestOrders(
  account: ChannelAccount,
  incoming: CanonicalOrder[],
  opts: { syncRunId?: number } = {},
): Promise<IngestResult> {
  if (incoming.length === 0) return { seen: 0, written: 0, unmappedSkus: [] };

  // One row per order id. Postgres refuses an ON CONFLICT DO UPDATE that would
  // touch the same row twice in one statement, so a duplicate that the
  // per-order loop used to absorb silently would now fail the whole batch.
  // Last occurrence wins — for a paged fetch that is the more recent read.
  const seenCount = incoming.length;
  incoming = [...new Map(incoming.map((o) => [o.externalOrderId, o])).values()];

  // Resolve every channel SKU to one of our products in a single query. Orders
  // the adapter flagged `itemsKnownCurrent` bring no items and leave the
  // existing rows untouched, so they contribute nothing to resolve here.
  const skus = [
    ...new Set(
      incoming.filter((o) => !o.itemsKnownCurrent).flatMap((o) => o.items.map((i) => i.externalSku)),
    ),
  ];
  const listings = skus.length
    ? await db
        .select()
        .from(channelListings)
        .where(
          and(
            eq(channelListings.channelAccountId, account.id),
            inArray(channelListings.externalSku, skus),
          ),
        )
    : [];
  const skuToProduct = new Map(listings.map((l) => [l.externalSku, l.productId]));
  const unmappedSkus = skus.filter((s) => !skuToProduct.has(s));

  // Snapshot the current status of every incoming order in one query, so a
  // transition into a terminal state (or any real status change) can be
  // recorded as its own row in order_status_events on this same run.
  const priorRows = await db
    .select({ externalOrderId: orders.externalOrderId, status: orders.status })
    .from(orders)
    .where(
      and(
        eq(orders.channelAccountId, account.id),
        inArray(orders.externalOrderId, incoming.map((o) => o.externalOrderId)),
      ),
    );
  const priorStatus = new Map(priorRows.map((r) => [r.externalOrderId, r.status]));
  const isTerminal = (s: OrderStatus) => s === "cancelled" || s === "rto" || s === "returned";
  const statusEvents: (typeof orderStatusEvents.$inferInsert)[] = [];

  // Everything below writes in batches rather than per order. A sync where
  // nothing has changed still has to upsert every order in the window, so the
  // per-order round trip was the whole cost of a routine run — 82 orders meant
  // 82 sequential round trips to a serverless Postgres and about ten seconds
  // of almost pure latency. Chunked multi-row statements turn that into a
  // handful of round trips.
  //
  // CHUNK keeps each statement under Postgres's 65535 bind-parameter ceiling.
  // The widest row here is `orders` at ~16 columns, so 500 leaves ample room.
  const CHUNK = 500;
  const chunks = <T,>(xs: T[]) =>
    Array.from({ length: Math.ceil(xs.length / CHUNK) }, (_, i) =>
      xs.slice(i * CHUNK, (i + 1) * CHUNK),
    );

  const orderRows = incoming.map((o) => ({
    channelAccountId: account.id,
    channel: account.channel,
    externalOrderId: o.externalOrderId,
    status: o.status,
    orderedAt: o.orderedAt,
    buyerName: o.buyerName ?? null,
    shipCity: o.shipCity ?? null,
    shipState: o.shipState ?? null,
    shipPincode: o.shipPincode ?? null,
    totalAmount: o.totalAmount ?? null,
    isCod: o.isCod ?? false,
    dispatchBy: o.dispatchBy ?? null,
    channelUpdatedAt: o.channelUpdatedAt ?? null,
    easyshipStatus: o.easyshipStatus ?? null,
    raw: o.raw,
  }));

  // `raw` has to come from `excluded` now rather than a per-order literal —
  // one statement covers many orders, so there is no single value to inline.
  const upserted: { id: number; externalOrderId: string; status: OrderStatus }[] = [];
  for (const batch of chunks(orderRows)) {
    const rows = await db
      .insert(orders)
      .values(batch)
      .onConflictDoUpdate({
        target: [orders.channelAccountId, orders.externalOrderId],
        set: {
          // Status reconciliation happens in SQL so concurrent syncs cannot
          // read-then-write a stale value.
          status: sql`
            CASE
              WHEN excluded.status IN ('cancelled','rto','returned') THEN excluded.status
              WHEN ${orders.status} IN ('cancelled','rto','returned') THEN ${orders.status}
              WHEN ${statusRankSql("excluded.status")} > ${statusRankSql(`"orders"."status"`)}
                THEN excluded.status
              ELSE ${orders.status}
            END
          `,
          dispatchBy: sql`COALESCE(excluded.dispatch_by, ${orders.dispatchBy})`,
          totalAmount: sql`COALESCE(excluded.total_amount, ${orders.totalAmount})`,
          channelUpdatedAt: sql`COALESCE(excluded.channel_updated_at, ${orders.channelUpdatedAt})`,
          easyshipStatus: sql`COALESCE(excluded.easyship_status, ${orders.easyshipStatus})`,
          raw: sql`excluded.raw`,
          updatedAt: sql`now()`,
        },
      })
      .returning({
        id: orders.id,
        externalOrderId: orders.externalOrderId,
        status: orders.status,
      });
    upserted.push(...rows);
  }

  const written = upserted.length;
  const idFor = new Map(upserted.map((r) => [r.externalOrderId, r.id]));

  for (const row of upserted) {
    // Record the transition, if there was one. `priorStatus` is null for an
    // order we had never seen — for those we only log an arrival that is
    // already terminal (an order that showed up cancelled), not a routine new
    // order. The unique index on (order_id, to_status) makes this idempotent,
    // so two overlapping syncs racing on the same change is harmless.
    const before = priorStatus.get(row.externalOrderId) ?? null;
    if (!((before !== null && before !== row.status) || (before === null && isTerminal(row.status)))) {
      continue;
    }
    // `rto` is only ever set from Amazon's `ReturnedToSeller` — the parcel is
    // physically back and needs a "received & shelved" check-in, even the
    // first time we see the order. A `cancelled`/`returned` order needs a
    // check-in only if it had actually shipped; one cancelled before dispatch
    // (or first seen already cancelled) has nothing to receive, so it is
    // resolved on the spot with no `checkedInBy`.
    const needsCheckin =
      row.status === "rto" ||
      (isTerminal(row.status) && before !== null && SHIPPED_ISH.includes(before));
    statusEvents.push({
      orderId: row.id,
      channelAccountId: account.id,
      channel: account.channel,
      externalOrderId: row.externalOrderId,
      fromStatus: before,
      toStatus: row.status,
      syncRunId: opts.syncRunId ?? null,
      ...(isTerminal(row.status) && !needsCheckin
        ? {
            checkedInAt: new Date(),
            itemBack: false,
            checkinNote: "auto — order had not shipped, nothing to receive",
          }
        : {}),
    });
  }

  // An order the adapter flagged as unchanged brings no items and must not have
  // its existing rows touched. Otherwise items are replaced wholesale — an
  // order has a handful of lines and the channel is authoritative about them,
  // so diffing would be more code for no benefit.
  const refreshed = incoming.filter((o) => !o.itemsKnownCurrent);
  const refreshedIds = refreshed
    .map((o) => idFor.get(o.externalOrderId))
    .filter((id): id is number => id !== undefined);

  for (const batch of chunks(refreshedIds)) {
    await db.delete(orderItems).where(inArray(orderItems.orderId, batch));
  }

  const itemRows = refreshed.flatMap((o) => {
    const orderId = idFor.get(o.externalOrderId);
    if (orderId === undefined) return [];
    return o.items.map((it) => ({
      orderId,
      productId: skuToProduct.get(it.externalSku) ?? null,
      externalItemId: it.externalItemId ?? null,
      externalSku: it.externalSku,
      externalAsin: it.externalAsin ?? null,
      title: it.title ?? null,
      quantity: it.quantity,
      unitPrice: it.unitPrice ?? null,
      cancelled: it.cancelled ?? false,
    }));
  });
  for (const batch of chunks(itemRows)) {
    await db.insert(orderItems).values(batch);
  }

  // Shipments stay per-order: only Meesho supplies them, a handful at a time
  // from a label upload, so there is nothing here worth batching.
  for (const o of incoming) {
    if (!o.shipment) continue;
    const orderId = idFor.get(o.externalOrderId);
    if (orderId === undefined) continue;

    const existing = await db
      .select({ id: shipments.id })
      .from(shipments)
      .where(eq(shipments.orderId, orderId))
      .limit(1);

    const values = {
      orderId,
      externalShipmentId: o.shipment.externalShipmentId ?? null,
      courier: o.shipment.courier ?? null,
      awb: o.shipment.awb ?? null,
      ...(o.shipment.labelPdf
        ? { labelPdf: o.shipment.labelPdf, labelFetchedAt: new Date() }
        : {}),
    };

    if (existing[0]) {
      await db.update(shipments).set(values).where(eq(shipments.id, existing[0].id));
    } else {
      await db.insert(shipments).values(values);
    }
  }

  for (const batch of chunks(statusEvents)) {
    await db
      .insert(orderStatusEvents)
      .values(batch)
      .onConflictDoNothing({ target: [orderStatusEvents.orderId, orderStatusEvents.toStatus] });
  }

  await recomputeReserved();

  // Product images come from a separate, rate-limited catalogue call, so this
  // is fire-and-forget with a per-run cap — a routine sync fills a few in and
  // moves on. Never allowed to slow down or break an ingest.
  const freshAsins = incoming
    .filter((o) => !o.itemsKnownCurrent)
    .flatMap((o) => o.items.map((i) => i.externalAsin))
    .filter((a): a is string => !!a);
  await enrichCatalogImages(account, freshAsins).catch(() => {});

  return { seen: seenCount, written, unmappedSkus };
}

/**
 * Fill in `catalog_images` for ASINs we don't have an image for yet, capped per
 * call so it can't blow the Catalog Items rate limit or stall a sync. Also
 * back-fills `products.image_url` for any mapped product still missing one.
 * Every failure here is swallowed — an image is a nice-to-have.
 */
export async function enrichCatalogImages(
  account: ChannelAccount,
  asins: string[],
  cap = 20,
) {
  if (account.channel !== "amazon") return;
  const adapter = adapterFor(account);
  if (!(adapter instanceof AmazonAdapter)) return;

  const wanted = [...new Set(asins.filter(Boolean))];
  if (wanted.length === 0) return;

  const known = await db
    .select({ asin: catalogImages.asin })
    .from(catalogImages)
    .where(
      and(eq(catalogImages.channelAccountId, account.id), inArray(catalogImages.asin, wanted)),
    );
  const knownSet = new Set(known.map((k) => k.asin));
  const todo = wanted.filter((a) => !knownSet.has(a)).slice(0, cap);
  if (todo.length === 0) return;

  const found = await adapter.fetchCatalogImages(todo);

  // Record every ASIN we asked about — even the ones with no image — so we
  // don't keep re-requesting them every sync.
  await db
    .insert(catalogImages)
    .values(todo.map((asin) => ({ channelAccountId: account.id, asin, imageUrl: found.get(asin) ?? null })))
    .onConflictDoUpdate({
      target: [catalogImages.channelAccountId, catalogImages.asin],
      set: { imageUrl: sql`COALESCE(excluded.image_url, ${catalogImages.imageUrl})`, fetchedAt: new Date() },
    });

  // Give mapped products their image if they have none.
  for (const [asin, url] of found) {
    if (!url) continue;
    await db
      .update(products)
      .set({ imageUrl: url })
      .where(
        and(
          isNull(products.imageUrl),
          inArray(
            products.id,
            db
              .select({ id: channelListings.productId })
              .from(channelListings)
              .innerJoin(orderItems, eq(orderItems.externalSku, channelListings.externalSku))
              .where(
                and(
                  eq(channelListings.channelAccountId, account.id),
                  eq(orderItems.externalAsin, asin),
                ),
              ),
          ),
        ),
      );
  }
}

function statusRankSql(expr: string) {
  return sql.raw(`CASE ${expr}
      WHEN 'new' THEN 0
      WHEN 'ready_to_pack' THEN 1
      WHEN 'packed' THEN 2
      WHEN 'manifested' THEN 3
      WHEN 'shipped' THEN 4
      WHEN 'delivered' THEN 5
      ELSE 0 END`);
}

export async function ingestReturns(account: ChannelAccount, incoming: CanonicalReturn[]) {
  let written = 0;

  for (const r of incoming) {
    // Link the return back to its order where we can, so the returns screen can
    // show what was actually in the parcel.
    let orderId: number | null = null;
    if (r.externalOrderId) {
      const [o] = await db
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.channelAccountId, account.id),
            eq(orders.externalOrderId, r.externalOrderId),
          ),
        )
        .limit(1);
      orderId = o?.id ?? null;
    }

    await db
      .insert(returns)
      .values({
        orderId,
        channelAccountId: account.id,
        channel: account.channel,
        externalReturnId: r.externalReturnId,
        kind: r.kind,
        reason: r.reason ?? null,
        awb: r.awb ?? null,
        status: r.status ?? null,
        expectedAt: r.expectedAt ?? null,
        raw: r.raw,
      })
      .onConflictDoUpdate({
        target: [returns.channelAccountId, returns.externalReturnId],
        set: {
          status: r.status ?? null,
          awb: r.awb ?? null,
          expectedAt: r.expectedAt ?? null,
          orderId,
          raw: r.raw,
        },
      });
    written++;
  }

  return { seen: incoming.length, written };
}

/**
 * Recompute committed stock from the orders table rather than incrementing a
 * counter on every event. A derived number cannot drift out of sync after a
 * failed sync, a duplicate webhook or a manual status change — and at this
 * volume the full recompute is a single cheap query.
 */
export async function recomputeReserved() {
  await db.execute(sql`
    UPDATE inventory AS inv
    SET reserved = COALESCE((
          SELECT SUM(oi.quantity)
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          WHERE oi.product_id = inv.product_id
            AND oi.cancelled = false
            AND o.status IN ('new', 'ready_to_pack', 'packed')
        ), 0),
        updated_at = now()
  `);
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */

/** How far back to look for returns on an account that has never synced. */
const INITIAL_LOOKBACK_DAYS = 14;

/**
 * The *minimum* look-back for the fast lane. Every run re-scans at least this
 * far regardless of the cursor, so clock skew or an order Amazon back-dates
 * can't slip through a gap. It stays cheap because unchanged orders skip the
 * slow line-item call and every write is an idempotent upsert.
 */
const RECENT_WINDOW_MS = 72 * 60 * 60 * 1000;

/**
 * Ceiling on the look-back when the cursor is old. The fast lane pays roughly a
 * second per changed order, so an account left unsynced for months must not try
 * to walk the whole gap in one invocation — it would time out and never record
 * progress. Anything older than this is the backfill's job (`backfillAccount`),
 * and the run reports the shortfall rather than silently pretending it caught up.
 */
const MAX_CATCHUP_MS = 30 * 86_400_000;

/**
 * Where this run should start reading from.
 *
 * The saved cursor is the point of this: a 72h fixed window is only safe if a
 * sync actually runs every 72h, and this app has no cron — it had a four-day
 * gap in September 2026, during which an order changed on Amazon, fell out of
 * the window before the next run, and stayed wrong in our DB permanently. The
 * cursor closes that hole; RECENT_WINDOW_MS still forces a minimum overlap.
 */
function ordersSince(account: ChannelAccount): { since: Date; truncated: boolean } {
  const now = Date.now();
  const floor = now - RECENT_WINDOW_MS;
  const cursor = account.ordersSyncedThrough?.getTime();

  // A minute of overlap absorbs the boundary: `cursorFrom` records the newest
  // LastUpdateDate we ingested, and an order updated in that same second would
  // otherwise sit exactly on the exclusive edge of LastUpdatedAfter.
  const wanted = cursor === undefined ? floor : Math.min(cursor - 60_000, floor);
  const capped = Math.max(wanted, now - MAX_CATCHUP_MS);
  return { since: new Date(capped), truncated: capped > wanted };
}

/**
 * Run one incremental sync for one account. Sized to finish comfortably inside
 * a serverless invocation: it takes a bounded slice of work, records where it
 * got to, and lets the next cron run continue.
 */
export async function syncAccount(
  account: ChannelAccount,
  kind: "orders" | "returns" = "orders",
  limit = 100,
  options?: {
    /** Reuse an already-created run row instead of inserting a new one. */
    runId?: number;
    onProgress?: (info: { seen: number; total: number }) => void | Promise<void>;
  },
) {
  const adapter = adapterFor(account);

  if (!adapter.supportsLiveSync) {
    return { skipped: true as const, reason: `${account.channel} has no live API` };
  }

  const run = options?.runId
    ? { id: options.runId }
    : (
        await db
          .insert(syncRuns)
          .values({ channelAccountId: account.id, kind })
          .returning({ id: syncRuns.id })
      )[0];

  try {
    const ordersWindow = ordersSince(account);
    const since =
      kind === "orders"
        ? ordersWindow.since
        : (account.returnsSyncedThrough ??
          new Date(Date.now() - INITIAL_LOOKBACK_DAYS * 86_400_000));

    let seen = 0;
    let written = 0;
    let syncedThrough = since;
    let hasMore = false;

    if (kind === "orders") {
      // Everything we already hold that could plausibly reappear in this
      // window, keyed for the adapter's skip-if-unchanged check so a routine
      // sync makes almost no per-order calls.
      const knownRows = await db
        .select({
          externalOrderId: orders.externalOrderId,
          channelUpdatedAt: orders.channelUpdatedAt,
        })
        .from(orders)
        .where(
          and(
            eq(orders.channelAccountId, account.id),
            gte(orders.channelUpdatedAt, new Date(since.getTime() - 86_400_000)),
          ),
        );
      const unchangedSince = new Map(
        knownRows
          .filter((r) => r.channelUpdatedAt)
          .map((r) => [r.externalOrderId, r.channelUpdatedAt!.getTime()] as const),
      );

      const res = await adapter.fetchOrders({
        since,
        limit,
        unchangedSince,
        onProgress: async (info) => {
          // Live progress, written straight to the row so any request polling
          // it — regardless of which server instance handles that request —
          // sees the same number.
          await db
            .update(syncRuns)
            .set({ itemsSeen: info.seen, totalEstimate: info.total })
            .where(eq(syncRuns.id, run.id));
          await options?.onProgress?.(info);
        },
      });
      const ingested = await ingestOrders(account, res.orders, { syncRunId: run.id });
      seen = ingested.seen;
      written = ingested.written;
      syncedThrough = res.syncedThrough;
      hasMore = res.hasMore;
    } else {
      const res = await adapter.fetchReturns({ since, limit });
      const ingested = await ingestReturns(account, res.returns);
      seen = ingested.seen;
      written = ingested.written;
      syncedThrough = res.syncedThrough;
    }

    await db
      .update(channelAccounts)
      .set(
        kind === "orders"
          ? { ordersSyncedThrough: syncedThrough }
          : { returnsSyncedThrough: syncedThrough },
      )
      .where(eq(channelAccounts.id, account.id));

    await db
      .update(syncRuns)
      .set({
        status: "ok",
        finishedAt: new Date(),
        itemsSeen: seen,
        itemsWritten: written,
      })
      .where(eq(syncRuns.id, run.id));

    return {
      skipped: false as const,
      seen,
      written,
      hasMore,
      syncedThrough,
      runId: run.id,
      /** The cursor was older than MAX_CATCHUP_MS; a backfill is needed to close the rest. */
      truncated: kind === "orders" && ordersWindow.truncated,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(syncRuns)
      .set({ status: "failed", finishedAt: new Date(), error: message.slice(0, 2000) })
      .where(eq(syncRuns.id, run.id));
    throw err;
  }
}

/**
 * Kick off an order sync for the "Sync now" button without making the caller
 * wait for it. The run row is created synchronously — so a runId is available
 * immediately for the client to poll — and the actual fetch/ingest work
 * continues after this returns, via `after()`, which keeps the request alive
 * long enough to finish even on a serverless deploy where the response has
 * already gone back to the browser.
 */
export async function startManualOrderSync(accountId: number) {
  const [account] = await db
    .select()
    .from(channelAccounts)
    .where(eq(channelAccounts.id, accountId))
    .limit(1);

  if (!account) return { ok: false as const, error: "Account not found." };

  const adapter = adapterFor(account);
  if (!adapter.supportsLiveSync) {
    return { ok: false as const, error: `${account.channel} has no live API to sync from.` };
  }

  const [run] = await db
    .insert(syncRuns)
    .values({ channelAccountId: account.id, kind: "orders" })
    .returning({ id: syncRuns.id });

  after(async () => {
    // Failure is already recorded on the run row inside syncAccount's own
    // catch block — nothing further to do with the rejection here.
    await syncAccount(account, "orders", 100, { runId: run.id }).catch(() => {});
    // Returns piggyback on the same trigger, silently — currently a no-op for
    // Amazon and fast enough elsewhere that it doesn't need its own bar.
    await syncAccount(account, "returns").catch(() => {});
  });

  return { ok: true as const, runId: run.id };
}

export interface SyncProgress {
  status: "running" | "ok" | "failed";
  itemsSeen: number;
  itemsWritten: number;
  totalEstimate: number | null;
  error: string | null;
}

/** Read by the polling endpoint the client hits while a manual sync runs. */
export async function getSyncProgress(runId: number): Promise<SyncProgress | null> {
  const [run] = await db.select().from(syncRuns).where(eq(syncRuns.id, runId)).limit(1);
  if (!run) return null;
  return {
    status: run.status,
    itemsSeen: run.itemsSeen,
    itemsWritten: run.itemsWritten,
    totalEstimate: run.totalEstimate,
    error: run.error,
  };
}

export async function syncAllAccounts() {
  const accounts = await db
    .select()
    .from(channelAccounts)
    .where(eq(channelAccounts.active, true));

  const results: Record<string, unknown> = {};

  for (const account of accounts) {
    // A channel switched off in config is not synced at all, even if an account
    // row still exists — otherwise the cron keeps hammering a channel we have
    // deliberately parked and fills the sync log with noise.
    if (!isChannelEnabled(account.channel)) continue;

    const key = `${account.channel}:${account.id}`;
    try {
      results[key] = {
        orders: await syncAccount(account, "orders"),
        returns: await syncAccount(account, "returns"),
      };
    } catch (err) {
      // One broken channel must not stop the others — a Flipkart token expiring
      // should never hold up Amazon's morning orders.
      results[key] = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  return results;
}

/* -------------------------------------------------------------------------- */
/* Backfill                                                                   */
/* -------------------------------------------------------------------------- */

export interface BackfillProgress {
  /** The date window just finished, e.g. "2026-06-01…2026-07-01". */
  window: string;
  /** Running totals across the whole backfill so far. */
  ordersSeen: number;
  ordersWritten: number;
  /**
   * Orders this window alone produced. Reported separately from the running
   * totals because a window that returns nothing is the signature of a report
   * Amazon declined to fill (see MAX_REPORT_WINDOW_DAYS) — invisible if the
   * caller only ever sees a total that keeps climbing.
   */
  windowOrders: number;
  /** Set if this window failed (and was skipped) rather than ingested. */
  error?: string;
}

/**
 * Amazon will not build an All Orders report spanning more than ~31 days, and
 * it does not say so: `createReport` is accepted, the report reaches DONE, and
 * the document downloads as a header row and nothing else. An oversized window
 * is therefore indistinguishable from a quiet month unless the size is capped
 * here.
 *
 * This cost us the entire history once already — the default was 45 days, so
 * every full window came back empty and only the short remainder window at the
 * end of the range ever produced orders (sync_runs #2, 2026-08-31: 51 orders
 * for what should have been six months). 30 leaves a day of headroom under the
 * limit and divides a long range evenly enough.
 */
const MAX_REPORT_WINDOW_DAYS = 30;

/**
 * One-time (and re-runnable) full history load via the channel's bulk report
 * endpoint. Unlike the fast lane this is not rate-limited per order — one
 * report covers a whole date range — so it is the only sane way to pull months
 * of history. It walks the range in windows, ingesting each through the same
 * `ingestOrders` pipeline as the live sync, and records itself as a `backfill`
 * row in `sync_runs`.
 *
 * Meant to be run from a script or a trusted backend trigger, never from a
 * serverless request — a full run can take many minutes.
 */
export async function backfillAccount(
  account: ChannelAccount,
  opts: {
    start: Date;
    end?: Date;
    /**
     * Size of each report window, in days. Capped at MAX_REPORT_WINDOW_DAYS —
     * see the note there; a larger value is silently useless, not an error.
     */
    chunkDays?: number;
    onProgress?: (info: BackfillProgress) => void | Promise<void>;
  },
) {
  const adapter = adapterFor(account);
  if (!adapter.fetchOrdersViaReports) {
    throw new Error(`${account.channel} has no bulk report endpoint to backfill from.`);
  }

  const [run] = await db
    .insert(syncRuns)
    .values({ channelAccountId: account.id, kind: "backfill" })
    .returning({ id: syncRuns.id });

  let ordersSeen = 0;
  let ordersWritten = 0;
  let windows = 0;
  const failedWindows: string[] = [];
  const emptyWindows: string[] = [];

  try {
    const end = opts.end ?? new Date();
    const chunkMs = Math.min(opts.chunkDays ?? MAX_REPORT_WINDOW_DAYS, MAX_REPORT_WINDOW_DAYS) * 86_400_000;

    for (let from = new Date(opts.start); from < end; from = new Date(from.getTime() + chunkMs)) {
      const to = new Date(Math.min(from.getTime() + chunkMs, end.getTime()));
      const label = `${from.toISOString().slice(0, 10)}…${to.toISOString().slice(0, 10)}`;
      windows++;

      // A window that fails — a report Amazon won't build, a range older than it
      // keeps, a transient 5xx — is logged and skipped. One bad slice must not
      // abandon a multi-year backfill that is otherwise working.
      let windowOrders = 0;
      try {
        for await (const batch of adapter.fetchOrdersViaReports(from, to)) {
          const ingested = await ingestOrders(account, batch, { syncRunId: run.id });
          ordersSeen += ingested.seen;
          ordersWritten += ingested.written;
          windowOrders += ingested.seen;
          await db
            .update(syncRuns)
            .set({ itemsSeen: ordersSeen, itemsWritten: ordersWritten })
            .where(eq(syncRuns.id, run.id));
        }
        if (windowOrders === 0) emptyWindows.push(label);
        await opts.onProgress?.({ window: label, ordersSeen, ordersWritten, windowOrders });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failedWindows.push(label);
        await opts.onProgress?.({ window: label, ordersSeen, ordersWritten, windowOrders, error: message });
      }
    }

    const allFailed = failedWindows.length === windows && windows > 0;
    const note =
      failedWindows.length > 0
        ? `${failedWindows.length}/${windows} windows failed: ${failedWindows.join(", ")}`.slice(0, 2000)
        : null;

    await db
      .update(syncRuns)
      .set({
        status: allFailed ? "failed" : "ok",
        finishedAt: new Date(),
        itemsSeen: ordersSeen,
        itemsWritten: ordersWritten,
        error: note,
      })
      .where(eq(syncRuns.id, run.id));

    if (allFailed) {
      throw new Error(note ?? "every backfill window failed");
    }
    return { runId: run.id, ordersSeen, ordersWritten, failedWindows, emptyWindows };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(syncRuns)
      .set({ status: "failed", finishedAt: new Date(), error: message.slice(0, 2000) })
      .where(eq(syncRuns.id, run.id));
    throw err;
  }
}
