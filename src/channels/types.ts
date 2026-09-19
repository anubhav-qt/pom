import type { Channel, ChannelAccount, OrderStatus } from "@/db/schema";

/**
 * The shape every marketplace is flattened into. Adapters own all the ugliness
 * of their channel; nothing downstream of here knows Amazon from Meesho except
 * for a colour and a label.
 */
export interface CanonicalOrderItem {
  externalItemId?: string | null;
  externalSku: string;
  /** Marketplace catalogue id (Amazon ASIN / Flipkart FSN), for image lookup. */
  externalAsin?: string | null;
  title?: string | null;
  quantity: number;
  unitPrice?: string | null;
  cancelled?: boolean;
}

export interface CanonicalOrder {
  externalOrderId: string;
  status: OrderStatus;
  orderedAt: Date;
  buyerName?: string | null;
  shipCity?: string | null;
  shipState?: string | null;
  shipPincode?: string | null;
  totalAmount?: string | null;
  isCod?: boolean;
  dispatchBy?: Date | null;
  /** When the channel last modified this order, if it says. Stored so the next
   *  sync can skip re-fetching line items that have not changed. */
  channelUpdatedAt?: Date | null;
  /** Amazon Easy Ship shipment status, verbatim (e.g. `ReturnedToSeller`). */
  easyshipStatus?: string | null;
  /** Set by an adapter when it deliberately skipped re-fetching line items
   *  because the channel's own "last updated" timestamp was unchanged. Tells
   *  the ingest to leave the existing order_items rows untouched. */
  itemsKnownCurrent?: boolean;
  items: CanonicalOrderItem[];
  shipment?: {
    externalShipmentId?: string | null;
    courier?: string | null;
    awb?: string | null;
    /** Present only when the label came from a file rather than an API. */
    labelPdf?: Buffer | null;
  };
  raw: unknown;
}

export interface CanonicalReturn {
  externalReturnId: string;
  externalOrderId?: string | null;
  kind: "return" | "rto" | "exchange";
  reason?: string | null;
  awb?: string | null;
  status?: string | null;
  expectedAt?: Date | null;
  /** When the customer raised it. */
  requestedAt?: Date | null;
  refundAmount?: number | null;
  labelCost?: number | null;
  resolution?: string | null;
  raw: unknown;
}

export interface InventoryUpdate {
  externalSku: string;
  /** Sellable quantity to publish: onHand - reserved - buffer, floored at 0. */
  quantity: number;
}

export interface InventoryPushResult {
  externalSku: string;
  ok: boolean;
  error?: string;
}

/**
 * A label ready to print. `pdf` is always a single-shipment PDF so the print
 * service can merge an arbitrary set in queue order.
 */
export interface LabelResult {
  externalOrderId: string;
  pdf: Buffer;
}

export interface FetchOrdersOptions {
  /** Pull everything created or updated at/after this instant. */
  since: Date;
  /** Cap the work a single serverless invocation will attempt. */
  limit?: number;
  /**
   * Called as the adapter works through the slow part — one call per order as
   * its details come in, once `total` is known. Optional: adapters that have
   * no meaningfully slow step (or no way to know a total ahead of time) can
   * ignore it entirely.
   */
  onProgress?: (info: { seen: number; total: number }) => void | Promise<void>;
  /**
   * `externalOrderId` -> the channel "last updated" timestamp we already have
   * stored, as epoch milliseconds. An adapter may use this to skip the slow,
   * rate-limited per-order line-item call for orders that have not changed
   * since the last sync.
   */
  unchangedSince?: Map<string, number>;
  /**
   * Reconcile mode: fetch order-level state only and treat every order already
   * present in `unchangedSince` as having current line items, whatever its
   * timestamp says.
   *
   * A repair sweep re-reads months of orders to correct statuses that drifted,
   * and the fields it is correcting — status, Easy Ship status, totals — all
   * come from the order listing itself. Line items are the expensive part and
   * we already hold them, so paying for them again would turn a two-minute
   * sweep into an hour against a 0.5 req/sec endpoint. An order we have never
   * seen still fetches its items normally.
   */
  statusOnly?: boolean;
}

export interface FetchOrdersResult {
  orders: CanonicalOrder[];
  /**
   * How far the adapter actually got. The caller stores this as the cursor —
   * never `now`, or a page cut short by `limit` would silently skip orders.
   */
  syncedThrough: Date;
  /** True when more remains; the cron loop will pick it up next run. */
  hasMore: boolean;
}

export interface ChannelAdapter {
  channel: Channel;

  /** False for file-import channels; hides "Sync now" and cron for them. */
  readonly supportsLiveSync: boolean;
  readonly supportsInventoryPush: boolean;
  readonly supportsLabelFetch: boolean;

  fetchOrders(opts: FetchOrdersOptions): Promise<FetchOrdersResult>;

  fetchReturns(opts: FetchOrdersOptions): Promise<{
    returns: CanonicalReturn[];
    syncedThrough: Date;
  }>;

  /**
   * Bulk historical pull via a report/export endpoint, where the channel has
   * one. Not rate-limited per order — one call covers a whole date range — so
   * this is what the one-time backfill uses. Never called from the cron.
   * Yields canonical orders in batches so the caller can ingest incrementally.
   */
  fetchOrdersViaReports?(start: Date, end: Date): AsyncGenerator<CanonicalOrder[]>;

  /**
   * Fetch shipping labels for the given external order ids. Adapters that hold
   * labels in the database (Meesho) return them from there instead.
   */
  fetchLabels(externalOrderIds: string[]): Promise<LabelResult[]>;

  pushInventory(updates: InventoryUpdate[]): Promise<InventoryPushResult[]>;
}

export type AdapterFactory = (account: ChannelAccount) => ChannelAdapter;

/** Thrown for channel-side failures we want surfaced verbatim in sync_runs. */
export class ChannelError extends Error {
  constructor(
    public channel: Channel,
    message: string,
    public status?: number,
    public body?: string,
  ) {
    super(`[${channel}] ${message}`);
    this.name = "ChannelError";
  }
}

/** Adapters that cannot do something throw this rather than returning silence. */
export class NotSupportedError extends ChannelError {
  constructor(channel: Channel, what: string) {
    super(channel, `${what} is not supported on this channel`);
    this.name = "NotSupportedError";
  }
}
