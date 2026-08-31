import type { ChannelAccount, OrderStatus } from "@/db/schema";

import {
  ChannelError,
  type CanonicalOrder,
  type CanonicalReturn,
  type ChannelAdapter,
  type FetchOrdersOptions,
  type FetchOrdersResult,
  type InventoryPushResult,
  type InventoryUpdate,
  type LabelResult,
} from "./types";

const tokenCache = new Map<number, { token: string; expiresAt: number }>();

interface FlipkartCredentials {
  /** From Seller Dashboard > Manage Profile > Developer Access (self-access app). */
  appId: string;
  appSecret: string;
  /** Warehouse/location id used for inventory updates. */
  locationId?: string;
}

/**
 * Flipkart Marketplace Seller API v3.
 *
 * Flipkart's unit of work is the *shipment*, not the order — a single order can
 * fan out into several shipments picked and labelled independently. We treat
 * each shipment as one canonical order, keyed by shipment id, because that is
 * what actually gets packed and handed to a courier.
 */
export class FlipkartAdapter implements ChannelAdapter {
  readonly channel = "flipkart" as const;
  readonly supportsLiveSync = true;
  readonly supportsInventoryPush = true;
  readonly supportsLabelFetch = true;

  private creds: FlipkartCredentials;
  private base: string;

  constructor(private account: ChannelAccount) {
    this.creds = account.credentials as unknown as FlipkartCredentials;
    this.base = process.env.FLIPKART_API_BASE ?? "https://api.flipkart.net";

    if (!this.creds?.appId || !this.creds?.appSecret) {
      throw new ChannelError("flipkart", "channel account is missing appId / appSecret");
    }
  }

  /* ---------------------------------------------------------------- auth -- */

  private async accessToken(): Promise<string> {
    const cached = tokenCache.get(this.account.id);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const basic = Buffer.from(`${this.creds.appId}:${this.creds.appSecret}`).toString("base64");
    const url = new URL("/oauth-service/oauth/token", this.base);
    url.searchParams.set("grant_type", "client_credentials");
    url.searchParams.set("scope", "Seller_Api");

    const res = await fetch(url, { headers: { authorization: `Basic ${basic}` } });
    const body = await res.text();
    if (!res.ok) {
      throw new ChannelError("flipkart", "token request failed", res.status, body);
    }

    const json = JSON.parse(body) as { access_token: string; expires_in: number };
    tokenCache.set(this.account.id, {
      token: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    });
    return json.access_token;
  }

  private async request<T>(
    path: string,
    init: RequestInit & { query?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);

    const res = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${await this.accessToken()}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    const text = await res.text();
    if (!res.ok) {
      throw new ChannelError("flipkart", `${init.method ?? "GET"} ${path} failed`, res.status, text);
    }
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  /* -------------------------------------------------------------- orders -- */

  async fetchOrders({ since, limit = 100 }: FetchOrdersOptions): Promise<FetchOrdersResult> {
    const shipments: FlipkartShipment[] = [];
    let nextUrl: string | undefined;
    let hasMore = false;

    // First call posts a filter; subsequent pages follow the returned nextPageUrl.
    let page = await this.request<FlipkartShipmentSearch>("/sellers/v3/shipments/filter", {
      method: "POST",
      body: JSON.stringify({
        filter: {
          type: "preDispatch",
          states: ["APPROVED", "PACKING_IN_PROGRESS", "PACKED", "READY_TO_DISPATCH"],
          orderDate: { from: since.toISOString() },
        },
        pagination: { pageSize: 20 },
        sort: { field: "orderDate", order: "asc" },
      }),
    });

    for (;;) {
      shipments.push(...(page.shipments ?? []));
      nextUrl = page.nextPageUrl;

      if (!nextUrl) break;
      if (shipments.length >= limit) {
        hasMore = true;
        break;
      }
      page = await this.request<FlipkartShipmentSearch>(nextUrl);
    }

    const orders = shipments.slice(0, limit).map((s) => this.toCanonical(s));

    return {
      orders,
      syncedThrough: cursorFrom(orders.map((o) => o.orderedAt), since, hasMore),
      hasMore,
    };
  }

  private toCanonical(s: FlipkartShipment): CanonicalOrder {
    const first = s.orderItems?.[0];
    return {
      // Shipment id, not order id — this is the thing that gets packed.
      externalOrderId: s.shipmentId,
      status: mapStatus(s.status),
      orderedAt: new Date(first?.orderDate ?? s.dispatchByDate ?? Date.now()),
      buyerName: s.deliveryAddress?.firstName
        ? [s.deliveryAddress.firstName, s.deliveryAddress.lastName].filter(Boolean).join(" ")
        : null,
      shipCity: s.deliveryAddress?.city ?? null,
      shipState: s.deliveryAddress?.state ?? null,
      shipPincode: s.deliveryAddress?.pincode ?? null,
      totalAmount: sumPrices(s.orderItems),
      isCod: (first?.paymentType ?? "").toUpperCase() === "COD",
      dispatchBy: s.dispatchByDate ? new Date(s.dispatchByDate) : null,
      items: (s.orderItems ?? []).map((it) => ({
        externalItemId: it.orderItemId,
        externalSku: it.sku,
        title: it.title ?? null,
        quantity: it.quantity ?? 1,
        unitPrice: it.priceComponents?.sellingPrice?.toString() ?? null,
        cancelled: it.status === "CANCELLED",
      })),
      shipment: {
        externalShipmentId: s.shipmentId,
        courier: s.deliveryPartner ?? null,
        awb: s.trackingId ?? null,
      },
      raw: s,
    };
  }

  /* ------------------------------------------------------------- returns -- */

  async fetchReturns({ since }: FetchOrdersOptions) {
    const res = await this.request<{ returnItems?: FlipkartReturn[] }>("/sellers/v3/returns", {
      query: {
        source: "all",
        createdAfter: since.toISOString(),
      },
    });

    const returns: CanonicalReturn[] = (res.returnItems ?? []).map((r) => ({
      externalReturnId: r.returnId,
      externalOrderId: r.shipmentId ?? r.orderItemId ?? null,
      kind: r.type === "return_courier" || r.type === "RETURN" ? "return" : "rto",
      reason: r.reason ?? null,
      awb: r.trackingId ?? null,
      status: r.status ?? null,
      expectedAt: r.expectedDeliveryDate ? new Date(r.expectedDeliveryDate) : null,
      raw: r,
    }));

    return { returns, syncedThrough: new Date() };
  }

  /* -------------------------------------------------------------- labels -- */

  /**
   * Flipkart returns a single merged PDF for up to 50 shipments per call. We
   * still split nothing here — the print service merges across channels anyway,
   * so a per-channel merged PDF is handed back under the first order id.
   */
  async fetchLabels(externalOrderIds: string[]): Promise<LabelResult[]> {
    const out: LabelResult[] = [];

    for (let i = 0; i < externalOrderIds.length; i += 50) {
      const chunk = externalOrderIds.slice(i, i + 50);
      const url = new URL("/sellers/v3/shipments/labels", this.base);
      url.searchParams.set("shipmentIds", chunk.join(","));

      const res = await fetch(url, {
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          accept: "application/pdf",
        },
      });

      if (!res.ok) {
        throw new ChannelError(
          "flipkart",
          "label fetch failed",
          res.status,
          await res.text().catch(() => ""),
        );
      }

      out.push({
        externalOrderId: chunk[0],
        pdf: Buffer.from(await res.arrayBuffer()),
      });
    }

    return out;
  }

  /* ----------------------------------------------------------- inventory -- */

  async pushInventory(updates: InventoryUpdate[]): Promise<InventoryPushResult[]> {
    const locationId = this.creds.locationId;
    if (!locationId) {
      throw new ChannelError("flipkart", "channel account is missing locationId");
    }

    const results: InventoryPushResult[] = [];
    for (const u of updates) {
      try {
        await this.request(`/sellers/skus/${encodeURIComponent(u.externalSku)}/inventory`, {
          method: "POST",
          body: JSON.stringify({
            locationId,
            inventory: [{ locationId, quantity: u.quantity }],
          }),
        });
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
}

/* ------------------------------------------------------------------ misc -- */

function mapStatus(s: string | undefined): OrderStatus {
  switch ((s ?? "").toUpperCase()) {
    case "APPROVED":
    case "PACKING_IN_PROGRESS":
      return "new";
    case "PACKED":
      return "packed";
    case "READY_TO_DISPATCH":
      return "ready_to_pack";
    case "SHIPPED":
    case "DISPATCHED":
      return "shipped";
    case "DELIVERED":
      return "delivered";
    case "CANCELLED":
      return "cancelled";
    case "RTO":
      return "rto";
    case "RETURNED":
      return "returned";
    default:
      return "new";
  }
}

function sumPrices(items: FlipkartOrderItem[] | undefined): string | null {
  if (!items?.length) return null;
  const total = items.reduce(
    (acc, it) => acc + (it.priceComponents?.sellingPrice ?? 0) * (it.quantity ?? 1),
    0,
  );
  return total ? total.toFixed(2) : null;
}

function cursorFrom(dates: Date[], since: Date, hasMore: boolean): Date {
  const valid = dates.filter((d) => !Number.isNaN(d.getTime()));
  if (valid.length === 0) return hasMore ? since : new Date();
  const newest = new Date(Math.max(...valid.map((d) => d.getTime())));
  return hasMore ? new Date(newest.getTime() - 1000) : newest;
}

/* ----------------------------------------------------------- API shapes -- */

interface FlipkartShipmentSearch {
  shipments?: FlipkartShipment[];
  nextPageUrl?: string;
  hasMore?: boolean;
}

interface FlipkartShipment {
  shipmentId: string;
  status?: string;
  dispatchByDate?: string;
  trackingId?: string;
  deliveryPartner?: string;
  deliveryAddress?: {
    firstName?: string;
    lastName?: string;
    city?: string;
    state?: string;
    pincode?: string;
  };
  orderItems?: FlipkartOrderItem[];
}

interface FlipkartOrderItem {
  orderItemId: string;
  orderId?: string;
  orderDate?: string;
  sku: string;
  title?: string;
  quantity?: number;
  status?: string;
  paymentType?: string;
  priceComponents?: { sellingPrice?: number };
}

interface FlipkartReturn {
  returnId: string;
  shipmentId?: string;
  orderItemId?: string;
  type?: string;
  reason?: string;
  status?: string;
  trackingId?: string;
  expectedDeliveryDate?: string;
}
