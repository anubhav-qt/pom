import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Postgres `bytea`. Drizzle has no first-class bytea column, and we need one
 * for Meesho label pages — those arrive as an uploaded PDF and can never be
 * re-fetched from an API, so they have to be persisted somewhere.
 */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const channelEnum = pgEnum("channel", ["amazon", "flipkart", "meesho"]);

/**
 * Canonical order lifecycle. Every marketplace has its own vocabulary
 * (Flipkart "APPROVED", Meesho "Pending", Amazon "Unshipped"); adapters map
 * into these and the UI only ever speaks this language.
 */
export const orderStatusEnum = pgEnum("order_status", [
  "new", // pulled in, not yet actioned
  "ready_to_pack", // label available, waiting at the packing bench
  "packed", // scanned + packed, awaiting manifest
  "manifested", // handed to courier
  "shipped",
  "delivered",
  "cancelled",
  "rto", // returned to origin
  "returned", // customer return
]);

export const returnKindEnum = pgEnum("return_kind", ["return", "rto", "exchange"]);

export const syncKindEnum = pgEnum("sync_kind", ["orders", "returns", "inventory", "backfill"]);
export const syncStatusEnum = pgEnum("sync_status", ["running", "ok", "failed"]);

export const userRoleEnum = pgEnum("user_role", ["owner", "staff"]);

export const batchKindEnum = pgEnum("batch_kind", ["picklist", "manifest"]);

/**
 * Our own dispatch-floor state, kept deliberately apart from `orders.status`.
 *
 * `orders.status` is the marketplace's opinion and is overwritten by every
 * sync. This is ours: it says where a parcel has got to on our bench, and no
 * sync ever writes it. The two are read together — the marketplace decides
 * whether an order is still live, we decide whether it is packed.
 */
export const fulfilmentStateEnum = pgEnum("fulfilment_state", [
  "to_pack",
  "packed", // scanned and boxed, waiting for the courier
  "manifested", // handed over
]);

/** Which bench a scan happened at. */
export const scanStationEnum = pgEnum("scan_station", ["outbound", "inbound"]);

/* -------------------------------------------------------------------------- */
/* People                                                                     */
/* -------------------------------------------------------------------------- */

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    /** Drives the 365-day forced rotation. Reset whenever the password changes. */
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * TOTP secret, present once enrollment starts. Kept even while mfaEnabled
     * is false so a half-finished setup can be resumed rather than restarted.
     */
    mfaSecret: text("mfa_secret"),
    mfaEnabled: boolean("mfa_enabled").notNull().default(false),
    role: userRoleEnum("role").notNull().default("staff"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

/* -------------------------------------------------------------------------- */
/* Channels                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One row per connected marketplace seller account. Credentials live in
 * `credentials` as JSON — the shape differs per channel (LWA refresh token for
 * Amazon, appId/appSecret for Flipkart, nothing at all for Meesho file import).
 */
export const channelAccounts = pgTable(
  "channel_accounts",
  {
    id: serial("id").primaryKey(),
    channel: channelEnum("channel").notNull(),
    label: text("label").notNull(),
    credentials: jsonb("credentials").$type<Record<string, string>>().notNull().default({}),
    active: boolean("active").notNull().default(true),

    // Incremental sync cursors. We never re-scan history; each cron run asks
    // the channel only for what changed since these timestamps.
    ordersSyncedThrough: timestamp("orders_synced_through", { withTimezone: true }),
    returnsSyncedThrough: timestamp("returns_synced_through", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("channel_accounts_channel_idx").on(t.channel)],
);

/* -------------------------------------------------------------------------- */
/* Catalogue + stock                                                          */
/* -------------------------------------------------------------------------- */

/** Our own SKU. The single source of truth for what a product *is*. */
export const products = pgTable(
  "products",
  {
    id: serial("id").primaryKey(),
    sku: text("sku").notNull(),
    name: text("name").notNull(),
    imageUrl: text("image_url"),
    hsnCode: text("hsn_code"),
    costPrice: numeric("cost_price", { precision: 12, scale: 2 }),
    weightGrams: integer("weight_grams"),
    /** Where it sits in the warehouse — printed on picklists to speed picking. */
    binLocation: text("bin_location"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("products_sku_idx").on(t.sku)],
);

/**
 * Maps our SKU to whatever identifier each marketplace uses. Without this,
 * inventory sync and picking are impossible — the same shirt is `PB-SHRT-BLU-M`
 * to us, an ASIN to Amazon, an FSN to Flipkart and a free-text SKU to Meesho.
 */
export const channelListings = pgTable(
  "channel_listings",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    channelAccountId: integer("channel_account_id")
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    /** The seller SKU string as the marketplace knows it. */
    externalSku: text("external_sku").notNull(),
    /** ASIN / FSN / Meesho product id, where one exists. */
    externalId: text("external_id"),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("channel_listings_account_sku_idx").on(t.channelAccountId, t.externalSku),
    index("channel_listings_product_idx").on(t.productId),
  ],
);

/**
 * One stock number per SKU for the whole warehouse. `reserved` covers units
 * committed to orders that are not yet dispatched, so what we publish to the
 * marketplaces is `onHand - reserved` and we stop overselling.
 */
export const inventory = pgTable("inventory", {
  productId: integer("product_id")
    .primaryKey()
    .references(() => products.id, { onDelete: "cascade" }),
  onHand: integer("on_hand").notNull().default(0),
  reserved: integer("reserved").notNull().default(0),
  /** Stock held back from marketplaces as a safety margin against oversell. */
  buffer: integer("buffer").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only audit of every stock movement, so a wrong count can be traced. */
export const inventoryLedger = pgTable(
  "inventory_ledger",
  {
    id: serial("id").primaryKey(),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    reason: text("reason").notNull(), // 'order_packed' | 'return_received' | 'manual' | 'stock_take'
    refType: text("ref_type"),
    refId: integer("ref_id"),
    note: text("note"),
    userId: integer("user_id").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("inventory_ledger_product_idx").on(t.productId, t.createdAt)],
);

/* -------------------------------------------------------------------------- */
/* Orders                                                                     */
/* -------------------------------------------------------------------------- */

export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    channelAccountId: integer("channel_account_id")
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    channel: channelEnum("channel").notNull(),

    /** The id the marketplace shows — what dad reads out on a support call. */
    externalOrderId: text("external_order_id").notNull(),
    status: orderStatusEnum("status").notNull().default("new"),
    orderedAt: timestamp("ordered_at", { withTimezone: true }).notNull(),

    buyerName: text("buyer_name"),
    shipCity: text("ship_city"),
    shipState: text("ship_state"),
    shipPincode: text("ship_pincode"),

    totalAmount: numeric("total_amount", { precision: 12, scale: 2 }),
    /** COD orders need cash reconciliation at handover; prepaid do not. */
    isCod: boolean("is_cod").notNull().default(false),

    /** Marketplace-imposed ship-by date. Drives the "late" flag in the queue. */
    dispatchBy: timestamp("dispatch_by", { withTimezone: true }),

    /**
     * When the channel last changed this order (Amazon's `LastUpdateDate`).
     * The fast-lane sync compares this against what the channel reports and
     * skips re-fetching line items for orders that have not moved — that skip
     * is what keeps a routine sync down to a second or two.
     */
    channelUpdatedAt: timestamp("channel_updated_at", { withTimezone: true }),

    /**
     * Amazon Easy Ship's own shipment status, verbatim — `Delivered`,
     * `ReturnedToSeller`, `LabelCanceled`, … This account ships Easy Ship, and
     * its `OrderStatus` stays `Shipped` even after a parcel comes back, so this
     * field is the only signal that an RTO physically reached the warehouse.
     */
    easyshipStatus: text("easyship_status"),

    /** Untouched channel payload, for debugging a mismapping without a re-sync. */
    raw: jsonb("raw"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("orders_account_external_idx").on(t.channelAccountId, t.externalOrderId),
    index("orders_status_idx").on(t.status, t.orderedAt),
    index("orders_dispatch_by_idx").on(t.dispatchBy),
  ],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** Null when the channel SKU has no mapping yet — surfaced as "unmapped". */
    productId: integer("product_id").references(() => products.id),
    externalItemId: text("external_item_id"),
    externalSku: text("external_sku").notNull(),
    /** Marketplace catalogue id (Amazon ASIN / Flipkart FSN). Kept on the line
     *  so a product image can be looked up even before the SKU is mapped. */
    externalAsin: text("external_asin"),
    title: text("title"),
    quantity: integer("quantity").notNull().default(1),
    unitPrice: numeric("unit_price", { precision: 12, scale: 2 }),
    cancelled: boolean("cancelled").notNull().default(false),
  },
  (t) => [index("order_items_order_idx").on(t.orderId)],
);

/**
 * A physical parcel. Usually 1:1 with an order, but Flipkart and Amazon can
 * split one order across shipments, so it is modelled separately.
 */
export const shipments = pgTable(
  "shipments",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    externalShipmentId: text("external_shipment_id"),
    courier: text("courier"),
    awb: text("awb"),

    /**
     * Label PDF bytes. Only populated for Meesho, where the label arrives as an
     * uploaded file and cannot be re-fetched. Amazon and Flipkart labels are
     * pulled on demand at print time so we are not storing hundreds of MB.
     */
    labelPdf: bytea("label_pdf"),
    labelFetchedAt: timestamp("label_fetched_at", { withTimezone: true }),

    packedAt: timestamp("packed_at", { withTimezone: true }),
    packedBy: integer("packed_by").references(() => users.id),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  },
  (t) => [
    index("shipments_order_idx").on(t.orderId),
    index("shipments_awb_idx").on(t.awb),
  ],
);

/* -------------------------------------------------------------------------- */
/* Returns                                                                    */
/* -------------------------------------------------------------------------- */

export const returns = pgTable(
  "returns",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id").references(() => orders.id, { onDelete: "set null" }),
    channelAccountId: integer("channel_account_id")
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    channel: channelEnum("channel").notNull(),
    externalReturnId: text("external_return_id").notNull(),
    kind: returnKindEnum("kind").notNull(),
    reason: text("reason"),
    awb: text("awb"),
    /** Channel-side status text, kept verbatim — too varied to normalise. */
    status: text("status"),
    expectedAt: timestamp("expected_at", { withTimezone: true }),

    /** Set when the parcel is physically checked back in at the warehouse. */
    receivedAt: timestamp("received_at", { withTimezone: true }),
    receivedBy: integer("received_by").references(() => users.id),
    /** Whether the goods came back sellable — decides if stock goes back on. */
    restocked: boolean("restocked").notNull().default(false),
    conditionNote: text("condition_note"),

    /** What the marketplace refunded the customer for this return. */
    refundAmount: numeric("refund_amount", { precision: 12, scale: 2 }),
    /** Return-shipping label cost Amazon billed (or will bill) us for. */
    labelCost: numeric("label_cost", { precision: 12, scale: 2 }),
    /** Marketplace resolution verbatim: RefundAtFirstScan, StandardRefund, Replacement… */
    resolution: text("resolution"),
    /** When the customer raised the return on the marketplace. */
    requestedAt: timestamp("requested_at", { withTimezone: true }),
    /**
     * Our decision once the return is dealt with: reshelved, damaged,
     * written_off (never came back) or claim_raised. Null while it is open.
     */
    outcome: text("outcome"),

    raw: jsonb("raw"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("returns_account_external_idx").on(t.channelAccountId, t.externalReturnId),
    index("returns_received_idx").on(t.receivedAt),
  ],
);

/* -------------------------------------------------------------------------- */
/* Money                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One row per Amazon Finances transaction (API v2024-06-19), split into the
 * buckets the Finance screen reports on. `total` is Amazon's own figure; the
 * buckets are carved out of it, and whatever is left over stays in the
 * remainder, so a row always adds up to what Amazon says it is.
 *
 * Deferred money is listed twice by Amazon: once as DEFERRED, later as
 * DEFERRED_RELEASED (the same row after release) plus a fresh RELEASED row on
 * the day it is paid. Anything that sums money must skip DEFERRED_RELEASED.
 */
export const financeTransactions = pgTable(
  "finance_transactions",
  {
    transactionId: text("transaction_id").primaryKey(),
    channelAccountId: integer("channel_account_id")
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    /** Shipment, Refund, ServiceFee, ProductAdsPayment, Transfer, Adjustment… */
    type: text("type").notNull(),
    /** DEFERRED, RELEASED or DEFERRED_RELEASED. */
    status: text("status").notNull(),
    description: text("description"),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
    externalOrderId: text("external_order_id"),
    /** Amazon's payout group; the RELEASED lines of a group add up to its payout. */
    groupId: text("group_id"),
    /** On a RELEASED row: the DEFERRED row it replaces. */
    deferredId: text("deferred_id"),

    total: numeric("total", { precision: 12, scale: 2 }).notNull(),
    principal: numeric("principal", { precision: 12, scale: 2 }).notNull().default("0"),
    tax: numeric("tax", { precision: 12, scale: 2 }).notNull().default("0"),
    promo: numeric("promo", { precision: 12, scale: 2 }).notNull().default("0"),
    /** TCS + TDS withheld. */
    tcsTds: numeric("tcs_tds", { precision: 12, scale: 2 }).notNull().default("0"),
    /** Closing fee, commission and other Amazon fees (not postage). */
    fees: numeric("fees", { precision: 12, scale: 2 }).notNull().default("0"),
    /** Easy Ship / merchant postage and its refunds. */
    postage: numeric("postage", { precision: 12, scale: 2 }).notNull().default("0"),
    /** What Amazon claws back from us when it refunds a customer. */
    refundCommission: numeric("refund_commission", { precision: 12, scale: 2 }).notNull().default("0"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("finance_tx_order_idx").on(t.externalOrderId),
    index("finance_tx_posted_idx").on(t.postedAt),
    index("finance_tx_group_idx").on(t.groupId),
    index("finance_tx_deferred_idx").on(t.deferredId),
  ],
);

/**
 * What an order cost us, and a note — the two things Amazon cannot tell us.
 * Filled in by hand on the Finance ledger; profit = Amazon net − this cost.
 */
export const orderFinance = pgTable("order_finance", {
  orderId: integer("order_id")
    .primaryKey()
    .references(() => orders.id, { onDelete: "cascade" }),
  costPrice: numeric("cost_price", { precision: 12, scale: 2 }),
  note: text("note"),
  updatedBy: integer("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/* -------------------------------------------------------------------------- */
/* Picklists and manifests                                                    */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Our floor state (never synced)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Where a parcel has got to on our dispatch bench. One row per order, created
 * the first time anybody acts on it.
 *
 * This exists because `orders.status` cannot hold both opinions at once. It
 * used to: we wrote `packed` and `manifested` into the same column the sync
 * overwrites from Amazon, and `reconcileStatus` had to defend our values from
 * being dragged backwards on every run. That made "has this been packed" and
 * "what does Amazon think" the same question, when they are not — Amazon calls
 * an Easy Ship order `Shipped` at courier pickup, which is after we pack, and
 * says nothing at all about our bench before that.
 *
 * Splitting them means a sync can write whatever Amazon says without ever
 * touching our record of what we physically did, which is the only copy of that
 * fact that exists anywhere.
 */
export const orderFulfilment = pgTable(
  "order_fulfilment",
  {
    orderId: integer("order_id")
      .primaryKey()
      .references(() => orders.id, { onDelete: "cascade" }),
    state: fulfilmentStateEnum("state").notNull().default("to_pack"),

    packedAt: timestamp("packed_at", { withTimezone: true }),
    packedBy: integer("packed_by").references(() => users.id),
    manifestedAt: timestamp("manifested_at", { withTimezone: true }),
    manifestedBy: integer("manifested_by").references(() => users.id),
    /**
     * Set when someone clears a manifested order off the Shipped (24h) queue
     * by hand — a purely local "stop showing me this" acknowledgement, not a
     * status change. The order and its history are untouched everywhere else
     * (Shipped/Delivered/All orders, dashboards, RTO tracking); this only
     * gates the 24h queue's own filter.
     */
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    dismissedBy: integer("dismissed_by").references(() => users.id),

    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("order_fulfilment_state_idx").on(t.state)],
);

/**
 * Append-only log of every barcode scan, including the ones that changed
 * nothing.
 *
 * A duplicate scan, a scan of a cancelled order, a scan of something already
 * checked in — all of it is recorded. The point of a scan station is being able
 * to answer "what did we actually do with that parcel, and when", and a log
 * that silently drops the awkward cases cannot answer it. `applied` separates
 * the scans that moved something from the ones that were a no-op.
 */
export const parcelScans = pgTable(
  "parcel_scans",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id").references(() => orders.id, { onDelete: "cascade" }),
    station: scanStationEnum("station").notNull(),
    /** Exactly what came off the scanner or the keyboard, before normalising. */
    code: text("code").notNull(),
    /** Which barcode it turned out to be: order_id / awb / shipment_id / return_id. */
    matchedOn: text("matched_on"),
    /** Inbound only: whether the goods came back sellable. */
    itemBack: boolean("item_back"),
    note: text("note"),
    /** False when the scan was a duplicate or otherwise changed nothing. */
    applied: boolean("applied").notNull().default(true),
    /** Set when the scan was refused, so the reason survives. */
    rejectedReason: text("rejected_reason"),

    scannedBy: integer("scanned_by").references(() => users.id),
    scannedAt: timestamp("scanned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("parcel_scans_order_idx").on(t.orderId, t.scannedAt),
    index("parcel_scans_station_idx").on(t.station, t.scannedAt),
  ],
);

export const batches = pgTable("batches", {
  id: serial("id").primaryKey(),
  kind: batchKindEnum("kind").notNull(),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  note: text("note"),
});

export const batchOrders = pgTable(
  "batch_orders",
  {
    id: serial("id").primaryKey(),
    batchId: integer("batch_id")
      .notNull()
      .references(() => batches.id, { onDelete: "cascade" }),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("batch_orders_pair_idx").on(t.batchId, t.orderId)],
);

/**
 * One row per label sheet generated on the PDF Printer page, with the finished
 * PDF itself. Kept permanently: it is both the file the new tab shows and the
 * log of what was printed, so "which sheet did that label go out on" can be
 * answered months later. A sheet is a few hundred KB.
 */
export const labelPrintRuns = pgTable(
  "label_print_runs",
  {
    id: serial("id").primaryKey(),
    createdBy: integer("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    pdf: bytea("pdf").notNull(),
    labelCount: integer("label_count").notNull(),
    sheetCount: integer("sheet_count").notNull(),
    /** Per uploaded file: name, page and label counts, what was skipped and why. */
    sources: jsonb("sources").notNull(),
    /** Per label, in print order: platform, order id and product read from its invoice. */
    labels: jsonb("labels").notNull(),
    duplicateOrderIds: jsonb("duplicate_order_ids").notNull().default([]),
    framesRemoved: integer("frames_removed").notNull().default(0),
    unstamped: integer("unstamped").notNull().default(0),
  },
  (t) => [index("label_print_runs_created_idx").on(t.createdAt)],
);

/* -------------------------------------------------------------------------- */
/* Sync bookkeeping                                                           */
/* -------------------------------------------------------------------------- */

/**
 * One row per cron sync attempt. When labels stop printing on a Monday morning
 * this table is the first place to look, so it records counts and the error.
 */
export const syncRuns = pgTable(
  "sync_runs",
  {
    id: serial("id").primaryKey(),
    channelAccountId: integer("channel_account_id")
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    kind: syncKindEnum("kind").notNull(),
    status: syncStatusEnum("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    itemsSeen: integer("items_seen").notNull().default(0),
    itemsWritten: integer("items_written").notNull().default(0),
    /**
     * How many items this run expects to process, once known — set as soon as
     * the order list page(s) come back, before the slower per-order detail
     * calls start. Lets the UI show a real N-of-total bar instead of a spinner
     * that means nothing.
     */
    totalEstimate: integer("total_estimate"),
    error: text("error"),
  },
  (t) => [index("sync_runs_account_started_idx").on(t.channelAccountId, t.startedAt)],
);

/**
 * Append-only record of every order status transition the sync observes — one
 * row the first time an order reaches a given status. The "Cancelled / RTO"
 * screen is this table filtered to the terminal statuses: a cancellation stays
 * visible as its own dated record even after the order row itself has moved on,
 * and it appears here on the very next sync after the marketplace flips the
 * status.
 */
export const orderStatusEvents = pgTable(
  "order_status_events",
  {
    id: serial("id").primaryKey(),
    orderId: integer("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    channelAccountId: integer("channel_account_id")
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    channel: channelEnum("channel").notNull(),
    /** Denormalised so the screen can show it without joining orders. */
    externalOrderId: text("external_order_id").notNull(),
    /** Null when the order was already in `toStatus` the first time we saw it. */
    fromStatus: orderStatusEnum("from_status"),
    toStatus: orderStatusEnum("to_status").notNull(),
    /** The sync run that detected the change, for tracing. */
    syncRunId: integer("sync_run_id").references(() => syncRuns.id, { onDelete: "set null" }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * Check-in for cancellations and RTO. Null `checkedInAt` = still pending:
     * the parcel is on its way back and nobody has confirmed it arrived. Set
     * when a person ticks it off on the Cancelled/RTO screen (or automatically,
     * with `checkedInBy` left null, for a transition where the order had never
     * shipped so there is nothing physical to receive). `itemBack` records
     * whether the goods actually came back once someone looked.
     */
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    checkedInBy: integer("checked_in_by").references(() => users.id),
    itemBack: boolean("item_back"),
    checkinNote: text("checkin_note"),
  },
  (t) => [
    // One row per (order, destination status): a re-run of an overlapping sync
    // window cannot create a duplicate event.
    uniqueIndex("order_status_events_order_to_idx").on(t.orderId, t.toStatus),
    index("order_status_events_to_idx").on(t.toStatus, t.detectedAt),
    index("order_status_events_account_idx").on(t.channelAccountId, t.detectedAt),
    // The Cancelled/RTO screen's default view: still-pending check-ins.
    index("order_status_events_pending_idx").on(t.checkedInAt, t.toStatus),
  ],
);

/**
 * Cached product image URLs keyed by marketplace catalogue id. The Orders API
 * gives us no image, only an ASIN — the image comes from a separate,
 * rate-limited Catalog Items call, so the result is cached here and reused
 * across every order line that shares the ASIN.
 */
export const catalogImages = pgTable(
  "catalog_images",
  {
    id: serial("id").primaryKey(),
    channelAccountId: integer("channel_account_id")
      .notNull()
      .references(() => channelAccounts.id, { onDelete: "cascade" }),
    asin: text("asin").notNull(),
    /** Null once we have looked and the catalogue had no usable image — stops
     *  us asking again every sync. */
    imageUrl: text("image_url"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("catalog_images_account_asin_idx").on(t.channelAccountId, t.asin)],
);

/**
 * The restock planner's working list — a scratchpad, not a source of truth.
 * One row per (base product, size, colour) variant seen in today's open orders.
 * `needed` is snapshotted when the plan is (re)generated; `have` is typed in by
 * hand after a shelf check; `buyOverride` pins the buy quantity instead of the
 * default `max(0, needed - have)`. "Reset from latest sync" truncates this table
 * and rebuilds it from the current orders, so every hand edit is deliberately
 * disposable.
 */
export const restockPlanItems = pgTable(
  "restock_plan_items",
  {
    id: serial("id").primaryKey(),
    /** Grouping key: the title with its trailing "(...)" removed, lower-cased. */
    baseKey: text("base_key").notNull(),
    /** Display name: base with leading brand / gender words stripped. */
    baseLabel: text("base_label").notNull(),
    imageUrl: text("image_url"),
    /** A representative marketplace catalogue id for the product. */
    asin: text("asin"),
    /** How many distinct seller SKUs rolled into this product. */
    skuCount: integer("sku_count").notNull().default(0),
    size: text("size").notNull().default(""),
    color: text("color").notNull().default(""),
    /** Units in open orders for this variant, at last (re)generation. */
    needed: integer("needed").notNull().default(0),
    /** On the shelf right now — entered by hand. */
    have: integer("have").notNull().default(0),
    /** Explicit buy quantity; null = auto (max(0, needed - have)). */
    buyOverride: integer("buy_override"),
    excluded: boolean("excluded").notNull().default(false),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("restock_plan_variant_idx").on(t.baseKey, t.size, t.color)],
);

export type User = typeof users.$inferSelect;
export type ChannelAccount = typeof channelAccounts.$inferSelect;
export type RestockPlanItem = typeof restockPlanItems.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type OrderItem = typeof orderItems.$inferSelect;
export type Shipment = typeof shipments.$inferSelect;
export type Return = typeof returns.$inferSelect;
export type Channel = (typeof channelEnum.enumValues)[number];
export type OrderStatus = (typeof orderStatusEnum.enumValues)[number];
export type OrderStatusEvent = typeof orderStatusEvents.$inferSelect;
export type CatalogImage = typeof catalogImages.$inferSelect;
export type OrderFulfilment = typeof orderFulfilment.$inferSelect;
export type FulfilmentState = (typeof fulfilmentStateEnum.enumValues)[number];
export type ParcelScan = typeof parcelScans.$inferSelect;
export type ScanStation = (typeof scanStationEnum.enumValues)[number];
