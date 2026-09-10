import type { ChannelAccount, OrderStatus } from "@/db/schema";

import {
  ChannelError,
  NotSupportedError,
  type CanonicalOrder,
  type ChannelAdapter,
  type FetchOrdersOptions,
  type FetchOrdersResult,
  type InventoryPushResult,
  type InventoryUpdate,
  type LabelResult,
} from "./types";

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";

/**
 * Per-account access token cache. LWA tokens live an hour; a warm serverless
 * instance handling several requests should not re-mint one each time.
 */
const tokenCache = new Map<number, { token: string; expiresAt: number }>();

interface AmazonCredentials {
  /** Obtained once via the Seller Central authorise flow for a private app. */
  refreshToken: string;
  /** Merchant token from Settings › Account Info. Needed for inventory writes. */
  sellerId?: string;
  /** Optional per-account override; falls back to the app-wide env vars. */
  clientId?: string;
  clientSecret?: string;
  marketplaceId?: string;
  endpoint?: string;
  /** "true" routes every call to the SP-API sandbox. See SANDBOX below. */
  sandbox?: string;
}

/**
 * SP-API's sandbox is not a copy of production with test data in it — it is a
 * set of static mock responses keyed off *exact* request parameters. A call
 * with a real ISO timestamp or the India marketplace ID returns an error; only
 * the magic values below produce a payload.
 *
 * That makes sandbox useful for exactly one thing: proving that credentials,
 * token refresh, request signing and response parsing all work. The data it
 * returns is fictional and its shape should not be relied on. Real order
 * behaviour can only be confirmed against production.
 */
const SANDBOX = {
  marketplaceId: "ATVPDKIKX0DER",
  createdAfter: "TEST_CASE_200",
  orderId: "TEST_CASE_200",
};

function sandboxEndpoint(productionEndpoint: string) {
  // https://sellingpartnerapi-eu.amazon.com -> https://sandbox.sellingpartnerapi-eu.amazon.com
  return productionEndpoint.replace("https://", "https://sandbox.");
}

/**
 * Amazon SP-API. Registered as a *private* application against the seller's own
 * account, so there is no OAuth consent dance at runtime — just an LWA refresh
 * token exchanged for short-lived access tokens.
 */
export class AmazonAdapter implements ChannelAdapter {
  readonly channel = "amazon" as const;
  readonly supportsLiveSync = true;
  readonly supportsInventoryPush = true;
  readonly supportsLabelFetch = true;

  private creds: AmazonCredentials;
  private marketplaceId: string;
  private endpoint: string;
  readonly isSandbox: boolean;

  /**
   * Self-imposed pacing for the orderItems endpoint, ahead of hitting 429 at
   * all. Retries recover from a burst; this avoids triggering one in the
   * common case of syncing more than a handful of orders in one run.
   */
  private lastItemsCallAt = 0;
  private static readonly ITEMS_MIN_INTERVAL_MS = 1100;

  constructor(private account: ChannelAccount) {
    this.creds = account.credentials as unknown as AmazonCredentials;
    this.isSandbox = this.creds?.sandbox === "true";

    const production =
      this.creds?.endpoint ??
      process.env.AMAZON_SPAPI_ENDPOINT ??
      "https://sellingpartnerapi-eu.amazon.com";

    this.endpoint = this.isSandbox ? sandboxEndpoint(production) : production;

    this.marketplaceId = this.isSandbox
      ? SANDBOX.marketplaceId
      : (this.creds?.marketplaceId ?? process.env.AMAZON_MARKETPLACE_ID ?? "A21TJRUUN4KGV");

    if (!this.creds?.refreshToken) {
      throw new ChannelError("amazon", "channel account is missing a refreshToken");
    }
  }

  /* ---------------------------------------------------------------- auth -- */

  private async accessToken(): Promise<string> {
    const cached = tokenCache.get(this.account.id);
    // 60s of slack so a token cannot expire mid-flight.
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const clientId = this.creds.clientId ?? process.env.AMAZON_LWA_CLIENT_ID;
    const clientSecret = this.creds.clientSecret ?? process.env.AMAZON_LWA_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new ChannelError("amazon", "AMAZON_LWA_CLIENT_ID / _SECRET are not configured");
    }

    const res = await fetch(LWA_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: this.creds.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    const body = await res.text();
    if (!res.ok) {
      throw new ChannelError("amazon", "LWA token refresh failed", res.status, body);
    }

    const json = JSON.parse(body) as { access_token: string; expires_in: number };
    tokenCache.set(this.account.id, {
      token: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    });
    return json.access_token;
  }

  /* ------------------------------------------------------------- request -- */

  /**
   * SP-API's rate limits are per-operation token buckets, and orderItems in
   * particular is documented at roughly 0.5 req/sec with a small burst — easy
   * to blow through on an account with more than a handful of open orders.
   * Five retries with growing backoff (honouring Retry-After when Amazon sends
   * it) turns that into a slower sync instead of a failed one.
   */
  private async request<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string | undefined> } = {},
    attempt = 0,
  ): Promise<T> {
    const url = new URL(path, this.endpoint);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, v);
    }

    const res = await fetch(url, {
      ...init,
      headers: {
        "x-amz-access-token": await this.accessToken(),
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (res.status === 429 && attempt < 5) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(2000 * 2 ** attempt, 16_000);
      await sleep(waitMs);
      return this.request<T>(path, init, attempt + 1);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new ChannelError("amazon", `${init.method ?? "GET"} ${path} failed`, res.status, text);
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  /* -------------------------------------------------------------- orders -- */

  async fetchOrders({ since, limit = 100, onProgress, unchangedSince }: FetchOrdersOptions): Promise<FetchOrdersResult> {
    const collected: AmazonOrder[] = [];
    let nextToken: string | undefined;
    let hasMore = false;

    do {
      const page = await this.request<{ payload: AmazonOrdersPayload }>("/orders/v0/orders", {
        query: nextToken
          ? { NextToken: nextToken, MarketplaceIds: this.marketplaceId }
          : this.isSandbox
            ? // Sandbox only answers to this exact pair; `since` is ignored.
              { MarketplaceIds: this.marketplaceId, CreatedAfter: SANDBOX.createdAfter }
            : {
                MarketplaceIds: this.marketplaceId,
                LastUpdatedAfter: since.toISOString(),
                MaxResultsPerPage: "100",
              },
      });

      collected.push(...(page.payload.Orders ?? []));
      nextToken = page.payload.NextToken;

      if (collected.length >= limit && nextToken) {
        // Stop here and let the next cron run continue. The cursor below is
        // taken from what we actually ingested, so nothing is skipped.
        hasMore = true;
        break;
      }
    } while (nextToken);

    // Oldest update first. getOrders does not promise an order for its results,
    // and the cursor we hand back is "the newest LastUpdateDate we ingested" —
    // so if the page is cut short at `limit`, every order left behind has to be
    // *newer* than that cursor or the next run will step straight over it.
    // Sorting first is what makes that true. With the old fixed 72h window a
    // skipped order was re-read on the next run anyway; now that the cursor is
    // trusted for catch-up, it would be lost for good.
    collected.sort(
      (a, b) => new Date(a.LastUpdateDate).getTime() - new Date(b.LastUpdateDate).getTime(),
    );

    // Drop orders Amazon hasn't finalised yet. A just-placed order sits at
    // "Pending" until payment clears — no buyer address, no line items, and
    // Seller Central doesn't list it as actionable either. Ingesting it would
    // put a row in the pack queue that the seller can't act on and that isn't
    // yet a confirmed sale. It gets picked up on the next sync once it turns
    // "Unshipped" (the 72h floor re-scans it), or never, if Amazon auto-cancels
    // it.
    const toProcess = collected
      .slice(0, limit)
      .filter((o) => !AMAZON_PENDING_STATUSES.has(o.OrderStatus));
    const orders: CanonicalOrder[] = [];
    for (const [i, o] of toProcess.entries()) {
      orders.push(await this.toCanonical(o, unchangedSince));
      // One tick per order, right after the slow paced call that order just
      // went through — this is the only part of a sync worth reporting on.
      await onProgress?.({ seen: i + 1, total: toProcess.length });
    }

    return {
      orders,
      syncedThrough: cursorFrom(
        orders.map((o) => new Date(o.raw ? (o.raw as AmazonOrder).LastUpdateDate : o.orderedAt)),
        since,
        hasMore,
      ),
      hasMore,
    };
  }

  private async toCanonical(
    o: AmazonOrder,
    unchangedSince?: Map<string, number>,
  ): Promise<CanonicalOrder> {
    const channelUpdatedAt = o.LastUpdateDate ? new Date(o.LastUpdateDate) : null;

    const common = {
      externalOrderId: o.AmazonOrderId,
      status: mapAmazonStatus(o),
      orderedAt: new Date(o.PurchaseDate),
      buyerName: o.ShippingAddress?.Name ?? null,
      shipCity: o.ShippingAddress?.City ?? null,
      shipState: o.ShippingAddress?.StateOrRegion ?? null,
      shipPincode: o.ShippingAddress?.PostalCode ?? null,
      totalAmount: o.OrderTotal?.Amount ?? null,
      // This account's COD orders come back as PaymentMethod "Other" or blank;
      // the ship service level ("Std IN EZ National COD") is the reliable tell.
      isCod: o.PaymentMethod === "COD" || /\bCOD\b/i.test(o.ShipServiceLevel ?? ""),
      dispatchBy: o.LatestShipDate ? new Date(o.LatestShipDate) : null,
      channelUpdatedAt,
      easyshipStatus: o.EasyShipShipmentStatus ?? null,
      raw: o,
    };

    // Fast lane: if Amazon's own LastUpdateDate matches what we already stored,
    // nothing about this order — its status or its line items — has moved since
    // last sync, so skip the slow, rate-limited orderItems call entirely. This
    // is the single biggest saving on a routine sync, where almost every order
    // in the window is one we already have.
    if (
      !this.isSandbox &&
      channelUpdatedAt &&
      unchangedSince?.get(o.AmazonOrderId) === channelUpdatedAt.getTime()
    ) {
      return { ...common, itemsKnownCurrent: true, items: [] };
    }

    // Sandbox keys its item mock off a fixed order id, not the ones its own
    // order list returns, so the real id cannot be used here.
    const itemsOrderId = this.isSandbox ? SANDBOX.orderId : o.AmazonOrderId;

    const wait = AmazonAdapter.ITEMS_MIN_INTERVAL_MS - (Date.now() - this.lastItemsCallAt);
    if (wait > 0) await sleep(wait);
    this.lastItemsCallAt = Date.now();

    const items = await this.request<{ payload: { OrderItems: AmazonOrderItem[] } }>(
      `/orders/v0/orders/${encodeURIComponent(itemsOrderId)}/orderItems`,
    );

    return {
      ...common,
      items: (items.payload.OrderItems ?? []).map((it) => ({
        externalItemId: it.OrderItemId,
        externalSku: it.SellerSKU,
        externalAsin: it.ASIN ?? null,
        title: it.Title ?? null,
        quantity: it.QuantityOrdered,
        unitPrice: it.ItemPrice?.Amount ?? null,
        cancelled: it.QuantityOrdered === 0,
      })),
    };
  }

  /* ------------------------------------------------------------- returns -- */

  /**
   * Returns are deliberately not implemented here for v1.
   *
   * SP-API exposes MFN return data only through the asynchronous Reports API
   * (create report -> poll -> download -> parse TSV), which spans more time than
   * a single serverless invocation and needs its own persisted job state. Order
   * status changes still surface cancellations and RTO through `fetchOrders`,
   * which covers the day-to-day case. Wiring the Reports API is the planned
   * upgrade — see docs/CHANNELS.md.
   */
  async fetchReturns({ since }: FetchOrdersOptions) {
    return { returns: [], syncedThrough: since };
  }

  /* -------------------------------------------------------------- labels -- */

  /**
   * Merchant-fulfilled label retrieval. Requires that a shipment was already
   * purchased through Amazon's Merchant Fulfillment (Buy Shipping) flow —
   * which is how self-ship sellers get an Amazon-branded label.
   *
   * Easy Ship sellers get labels through a different API and should mark the
   * account as Easy Ship; see docs/CHANNELS.md.
   */
  async fetchLabels(externalOrderIds: string[]): Promise<LabelResult[]> {
    const out: LabelResult[] = [];

    for (const orderId of externalOrderIds) {
      const res = await this.request<{ payload: { Shipment?: AmazonShipment } }>(
        `/mfn/v0/shipments`,
        { query: { amazonOrderId: orderId } },
      ).catch((err: unknown) => {
        if (err instanceof ChannelError && err.status === 404) return null;
        throw err;
      });

      const label = res?.payload?.Shipment?.Label;
      if (!label?.FileContents?.Contents) continue;

      out.push({
        externalOrderId: orderId,
        pdf: decodeLabel(label.FileContents),
      });
    }

    return out;
  }

  /* ----------------------------------------------------------- inventory -- */

  /**
   * Uses the Listings Items PATCH endpoint, which updates one SKU per call.
   * At a few hundred changed SKUs a day that is well within rate limits, and
   * it avoids the async Feeds API's submit-and-poll round trip.
   */
  async pushInventory(updates: InventoryUpdate[]): Promise<InventoryPushResult[]> {
    const sellerId = this.creds.sellerId;
    if (!sellerId) {
      throw new ChannelError("amazon", "channel account is missing sellerId (merchant token)");
    }

    const results: InventoryPushResult[] = [];
    for (const u of updates) {
      try {
        await this.request(
          `/listings/2021-08-01/items/${sellerId}/${encodeURIComponent(u.externalSku)}`,
          {
            method: "PATCH",
            query: { marketplaceIds: this.marketplaceId },
            body: JSON.stringify({
              productType: "PRODUCT",
              patches: [
                {
                  op: "replace",
                  path: "/attributes/fulfillment_availability",
                  value: [
                    {
                      fulfillment_channel_code: "DEFAULT",
                      quantity: u.quantity,
                    },
                  ],
                },
              ],
            }),
          },
        );
        results.push({ externalSku: u.externalSku, ok: true });
      } catch (err) {
        results.push({
          externalSku: u.externalSku,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  /* ------------------------------------------------------ reports (bulk) -- */

  private static readonly ALL_ORDERS_REPORT =
    "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL";

  private async createReport(reportType: string, start: Date, end: Date): Promise<string> {
    const res = await this.request<{ reportId?: string }>("/reports/2021-06-30/reports", {
      method: "POST",
      body: JSON.stringify({
        reportType,
        dataStartTime: start.toISOString(),
        dataEndTime: end.toISOString(),
        marketplaceIds: [this.marketplaceId],
      }),
    });
    if (!res.reportId) {
      throw new ChannelError("amazon", "createReport returned no reportId", undefined, JSON.stringify(res));
    }
    return res.reportId;
  }

  /** Poll until the report is DONE, then hand back its document id. */
  private async pollReport(reportId: string, timeoutMs = 20 * 60_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let waitMs = 5_000;
    for (;;) {
      const r = await this.request<{ processingStatus?: string; reportDocumentId?: string }>(
        `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`,
      );
      if (r.processingStatus === "DONE") {
        if (!r.reportDocumentId) {
          throw new ChannelError("amazon", `report ${reportId} is DONE but has no reportDocumentId`);
        }
        return r.reportDocumentId;
      }
      if (r.processingStatus === "FATAL" || r.processingStatus === "CANCELLED") {
        throw new ChannelError("amazon", `report ${reportId} ended ${r.processingStatus}`);
      }
      if (Date.now() > deadline) {
        throw new ChannelError(
          "amazon",
          `report ${reportId} still ${r.processingStatus ?? "pending"} after ${Math.round(timeoutMs / 1000)}s`,
        );
      }
      await sleep(waitMs);
      waitMs = Math.min(Math.round(waitMs * 1.5), 30_000);
    }
  }

  private async downloadReport(documentId: string): Promise<string> {
    const doc = await this.request<{ url?: string; compressionAlgorithm?: string }>(
      `/reports/2021-06-30/documents/${encodeURIComponent(documentId)}`,
    );
    if (!doc.url) throw new ChannelError("amazon", "report document has no download url");

    const res = await fetch(doc.url);
    if (!res.ok) {
      throw new ChannelError("amazon", "report document download failed", res.status, await res.text().catch(() => ""));
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (doc.compressionAlgorithm === "GZIP") {
      // Node builtin, resolved at runtime. The magic comment keeps webpack from
      // trying to bundle it — this method only ever runs server-side (backfill
      // script / trusted trigger), never in the client bundle that pulls this
      // module in transitively via `channels/index.ts`.
      const { gunzipSync } = await import(/* webpackIgnore: true */ "node:zlib");
      return gunzipSync(buf).toString("utf8");
    }
    return buf.toString("utf8");
  }

  /**
   * Full history via the All Orders flat-file report. One report covers the
   * whole [start, end] range with no per-order rate limiting, which is the only
   * practical way to pull months of orders — the live `fetchOrders` path is
   * capped near 0.5 req/sec by the orderItems endpoint. Yields canonical orders
   * in batches so a caller can ingest as it goes rather than holding the lot in
   * memory.
   */
  async *fetchOrdersViaReports(start: Date, end: Date): AsyncGenerator<CanonicalOrder[]> {
    if (this.isSandbox) {
      throw new ChannelError("amazon", "reports backfill is not available against the sandbox");
    }
    const reportId = await this.createReport(AmazonAdapter.ALL_ORDERS_REPORT, start, end);
    const documentId = await this.pollReport(reportId);
    const tsv = await this.downloadReport(documentId);

    const parsed = parseAllOrdersReport(tsv);
    for (let i = 0; i < parsed.length; i += 500) {
      yield parsed.slice(i, i + 500);
    }
  }

  /* ------------------------------------------------------ catalog images -- */

  /**
   * Look up a main product image per ASIN via the Catalog Items API. The
   * Orders API never returns an image, only the ASIN, so this is a separate
   * (rate-limited) call whose result the caller is expected to cache. Batches
   * of 20 identifiers per request. Best-effort: an ASIN Amazon has no image
   * for, or a failed batch, simply doesn't appear in the returned map.
   */
  async fetchCatalogImages(asins: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (this.isSandbox || asins.length === 0) return out;

    const unique = [...new Set(asins.filter(Boolean))];
    for (let i = 0; i < unique.length; i += 20) {
      const batch = unique.slice(i, i + 20);
      let res: CatalogItemsResponse;
      try {
        res = await this.request<CatalogItemsResponse>("/catalog/2022-04-01/items", {
          query: {
            identifiers: batch.join(","),
            identifiersType: "ASIN",
            marketplaceIds: this.marketplaceId,
            includedData: "images",
            pageSize: "20",
          },
        });
      } catch {
        continue; // one bad batch shouldn't lose the rest
      }

      for (const item of res.items ?? []) {
        const link = pickCatalogImage(item);
        if (item.asin && link) out.set(item.asin, link);
      }
    }
    return out;
  }
}

/* ------------------------------------------------------------------ misc -- */

interface CatalogImage {
  link: string;
  height?: number;
  width?: number;
  variant?: string;
}
interface CatalogItem {
  asin?: string;
  images?: { marketplaceId?: string; images?: CatalogImage[] }[];
}
interface CatalogItemsResponse {
  items?: CatalogItem[];
}

/** Prefer the MAIN variant, then the largest image Amazon lists. */
function pickCatalogImage(item: CatalogItem): string | null {
  const all = (item.images ?? []).flatMap((g) => g.images ?? []);
  if (all.length === 0) return null;
  const main = all.filter((im) => im.variant === "MAIN");
  const pool = main.length > 0 ? main : all;
  const best = pool.reduce((a, b) => ((b.width ?? 0) > (a.width ?? 0) ? b : a));
  return best.link || null;
}

/**
 * Map an Amazon order to our canonical status. `OrderStatus` alone is not
 * enough for this seller: it stays `Shipped` even after an Easy Ship parcel is
 * returned, so `EasyShipShipmentStatus` is checked first — `ReturnedToSeller`
 * is the *only* thing that tells us an RTO physically arrived back, and it is
 * the trigger for the check-in on the Cancelled & RTO screen.
 */
function mapAmazonStatus(o: AmazonOrder): OrderStatus {
  const ez = o.EasyShipShipmentStatus;
  if (ez === "ReturnedToSeller") return "rto";
  if (o.OrderStatus === "Canceled") return "cancelled";
  if (o.OrderStatus === "Unfulfillable") return "rto";
  if (ez === "Delivered") return "delivered";
  if (o.OrderStatus === "Shipped") return "shipped";
  // "Unshipped", "PartiallyShipped". "Pending"/"PendingAvailability" are
  // filtered out before they reach here (see AMAZON_PENDING_STATUSES) — if one
  // ever slips through, "new" is the safe fallback.
  return "new";
}

/**
 * Amazon order statuses that mean "not a confirmed sale yet". Filtered in
 * fetchOrders so they never enter the pack queue; they'll be ingested on a
 * later sync once the order moves to "Unshipped".
 */
const AMAZON_PENDING_STATUSES = new Set(["Pending", "PendingAvailability"]);

/**
 * The All Orders flat-file report spells its statuses differently from the JSON
 * Orders API ("Cancelled" with two Ls, "Partially Shipped" with a space) and
 * has no RTO/Unfulfillable value at all — RTO only ever surfaces through the
 * live `fetchOrders` path, never a historical report.
 */
function mapFlatFileStatus(s: string): OrderStatus {
  const t = s.trim();
  if (t === "Unshipped" || t === "Partially Shipped") return "new";
  if (t === "Cancelled" || t === "Canceled") return "cancelled";
  if (["Shipped", "Shipping", "InTransit", "Delivered"].includes(t)) return "shipped";
  // Everything else — a blank cell, "Pending", or a value this report spells a
  // way we haven't seen — defaults to "shipped", NOT "new". This is historical
  // data: an order that's days or weeks old is far more likely already gone
  // than waiting to be packed, and a backfill must never inflate the pack
  // queue. A later live sync corrects any order that's genuinely still open.
  return "shipped";
}

/**
 * Parse a `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL` report — a
 * tab-separated file with one row per order line — into canonical orders.
 * Column names are stable across marketplaces but their order is not, so every
 * field is looked up by header name and a missing header is tolerated rather
 * than throwing (except the order id, without which nothing can be grouped).
 */
function parseAllOrdersReport(tsv: string): CanonicalOrder[] {
  const lines = tsv.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];

  const headers = lines[0].split("\t").map((h) => h.trim());
  const at = (name: string) => headers.indexOf(name);
  const col = {
    orderId: at("amazon-order-id"),
    purchaseDate: at("purchase-date"),
    lastUpdated: at("last-updated-date"),
    status: at("order-status"),
    itemStatus: at("item-status"),
    sku: at("sku"),
    asin: at("asin"),
    name: at("product-name"),
    qty: at("quantity"),
    price: at("item-price"),
    shipService: at("ship-service-level"),
    city: at("ship-city"),
    state: at("ship-state"),
    postal: at("ship-postal-code"),
  };
  if (col.orderId < 0) {
    throw new ChannelError(
      "amazon",
      `unexpected report format — no "amazon-order-id" column (saw: ${headers.slice(0, 8).join(", ")}…)`,
    );
  }

  const byOrder = new Map<string, string[][]>();
  for (const line of lines.slice(1)) {
    const f = line.split("\t");
    const id = f[col.orderId]?.trim();
    if (!id) continue;
    let group = byOrder.get(id);
    if (!group) {
      group = [];
      byOrder.set(id, group);
    }
    group.push(f);
  }

  const num = (v: string | undefined) => {
    const n = Number((v ?? "").trim());
    return Number.isFinite(n) ? n : 0;
  };
  const cell = (row: string[], i: number) => (i >= 0 ? (row[i] ?? "").trim() : "");

  const out: CanonicalOrder[] = [];
  for (const [id, rows] of byOrder) {
    const first = rows[0];
    const isCancelledRow = (r: string[]) => cell(r, col.itemStatus) === "Cancelled";

    const items = rows
      .filter((r) => cell(r, col.sku).length > 0)
      .map((r) => {
        const quantity = Math.max(1, num(r[col.qty]));
        const lineTotal = num(r[col.price]); // the flat file's item-price is the line total
        return {
          externalSku: cell(r, col.sku),
          externalAsin: cell(r, col.asin) || null,
          title: cell(r, col.name) || null,
          quantity,
          unitPrice: lineTotal ? (lineTotal / quantity).toFixed(2) : null,
          cancelled: isCancelledRow(r),
        };
      });

    const total = rows
      .filter((r) => !isCancelledRow(r))
      .reduce((sum, r) => sum + num(r[col.price]), 0);

    out.push({
      externalOrderId: id,
      status: mapFlatFileStatus(cell(first, col.status)),
      orderedAt: new Date(cell(first, col.purchaseDate)),
      buyerName: null, // this report carries no buyer PII
      shipCity: cell(first, col.city) || null,
      shipState: cell(first, col.state) || null,
      shipPincode: cell(first, col.postal) || null,
      totalAmount: total ? total.toFixed(2) : null,
      // "Std IN EZ National COD" etc. — same tell as the live path.
      isCod: /\bCOD\b/i.test(cell(first, col.shipService)),
      dispatchBy: null, // not in this report; the live sync fills it for open orders
      channelUpdatedAt: cell(first, col.lastUpdated) ? new Date(cell(first, col.lastUpdated)) : null,
      easyshipStatus: null, // the report has no Easy Ship status column
      items,
      raw: { report: "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL", rows },
    });
  }
  return out;
}

/**
 * Advance the cursor only as far as we genuinely ingested. When a page was cut
 * short we rewind one second behind the newest record, so a re-read overlaps
 * rather than leaving a hole — upserts make the overlap harmless.
 */
function cursorFrom(dates: Date[], since: Date, hasMore: boolean): Date {
  const valid = dates.filter((d) => !Number.isNaN(d.getTime()));
  if (valid.length === 0) return hasMore ? since : new Date();
  const newest = new Date(Math.max(...valid.map((d) => d.getTime())));
  return hasMore ? new Date(newest.getTime() - 1000) : newest;
}

function decodeLabel(f: { Contents: string; FileType?: string }): Buffer {
  // SP-API returns base64; PDF labels come through directly.
  return Buffer.from(f.Contents, "base64");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ----------------------------------------------------------- API shapes -- */

interface AmazonOrdersPayload {
  Orders?: AmazonOrder[];
  NextToken?: string;
}

interface AmazonOrder {
  AmazonOrderId: string;
  OrderStatus: string;
  PurchaseDate: string;
  LastUpdateDate: string;
  LatestShipDate?: string;
  PaymentMethod?: string;
  ShipServiceLevel?: string;
  /** Easy Ship only: Delivered | ReturnedToSeller | LabelCanceled | … */
  EasyShipShipmentStatus?: string;
  OrderTotal?: { Amount: string; CurrencyCode: string };
  ShippingAddress?: {
    Name?: string;
    City?: string;
    StateOrRegion?: string;
    PostalCode?: string;
  };
}

interface AmazonOrderItem {
  OrderItemId: string;
  SellerSKU: string;
  ASIN?: string;
  Title?: string;
  QuantityOrdered: number;
  ItemPrice?: { Amount: string };
}

interface AmazonShipment {
  ShipmentId: string;
  Label?: { FileContents?: { Contents: string; FileType?: string } };
}

export { NotSupportedError };
