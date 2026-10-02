import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
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
/* Reels                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The song library the Reels screen picks from. Each row holds only the
 * reel-worthy stretch of a song (about 70 s around its hook, AAC), plus the
 * beat map `scripts/reel-songs.ts` measured from it, so rendering never has to
 * analyse audio. Rows are added from a local machine; see docs/reels/procedure.md.
 */
export const reelTracks = pgTable(
  "reel_tracks",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    artist: text("artist").notNull(),
    /** punjabi, hindi, haryanvi, ... Free text, for the library listing. */
    language: text("language").notNull().default("punjabi"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    bpm: real("bpm").notNull(),
    /** Where the audio came from (a YouTube link, usually), for the record. */
    source: text("source"),
    /** Seconds into the full song where the stored stretch begins. */
    windowStart: real("window_start").notNull().default(0),
    duration: real("duration").notNull(),
    audio: bytea("audio").notNull(),
    audioMime: text("audio_mime").notNull().default("audio/mp4"),
    /** `TrackAnalysis` from src/lib/reels/beats.ts, times relative to the stored stretch. */
    analysis: jsonb("analysis").notNull(),
    active: boolean("active").notNull().default(true),
    useCount: integer("use_count").notNull().default(0),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /**
     * When the song went into a reel. Each song makes one reel: once used it
     * leaves the library for good (`npm run songs -- free <id>` puts it back).
     */
    usedAt: timestamp("used_at", { withTimezone: true }),
    /** The job that used it, which keeps it for remakes. No foreign key: jobs are deleted after two days, the song stays used. */
    usedByJob: integer("used_by_job"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("reel_tracks_title_artist_idx").on(t.title, t.artist)],
);

/**
 * One reel being made, from upload to the finished MP4. The inputs live in
 * `reel_job_files` so "different song" or "use my picks" can render again
 * without a new upload. Jobs are short-lived: anything older than two days is
 * deleted when the next one starts.
 */
export const reelJobs = pgTable(
  "reel_jobs",
  {
    id: serial("id").primaryKey(),
    createdBy: integer("created_by").references(() => users.id),
    /** photos | video */
    kind: text("kind").notNull(),
    /** uploading | queued | selecting | analyzing | rendering | done | error */
    status: text("status").notNull().default("uploading"),
    progress: real("progress").notNull().default(0),
    error: text("error"),
    /** The failure was Gemini's, so the screen offers to go on without it. */
    aiFailed: boolean("ai_failed").notNull().default(false),
    /** Gemini's verdict per photo, in upload order. */
    picks: jsonb("picks"),
    /** Gemini's direction for a photo reel (`ReelDirection`): scenes, seconds, song, transitions. */
    direction: jsonb("direction"),
    /** The last render's plan: song, cue, shot order and timings. */
    plan: jsonb("plan"),
    trackId: integer("track_id").references(() => reelTracks.id, { onDelete: "set null" }),
    /** Tracks this job has already rendered with, so "different song" moves on. */
    triedTracks: jsonb("tried_tracks").$type<number[]>().notNull().default([]),
    output: bytea("output"),
    outputSilent: bytea("output_silent"),
    /** Bumped on every finished render, so the player never shows a stale file. */
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reel_jobs_created_idx").on(t.createdAt)],
);

/** A job's uploads: photos with their small previews, or a video in chunks. */
export const reelJobFiles = pgTable(
  "reel_job_files",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id")
      .notNull()
      .references(() => reelJobs.id, { onDelete: "cascade" }),
    /** photo | thumb | video (a video arrives as numbered chunks) */
    kind: text("kind").notNull(),
    idx: integer("idx").notNull(),
    name: text("name"),
    bytes: bytea("bytes").notNull(),
  },
  (t) => [uniqueIndex("reel_job_files_slot_idx").on(t.jobId, t.kind, t.idx)],
);

/**
 * "Do you like this reel?", one answer per finished render. Jobs are deleted
 * after two days, so each answer keeps its own copy of what the reel was: the
 * song, the scenes, Gemini's direction and picks, and which model and prompt
 * version directed it. That is what docs/reels/feedback.md reads to improve
 * the prompt in src/lib/reels/select.ts.
 */
export const reelFeedback = pgTable(
  "reel_feedback",
  {
    id: serial("id").primaryKey(),
    /** No foreign keys to the job or the song: both can go, the answer stays. */
    jobId: integer("job_id").notNull(),
    /** The render the answer is about: a remake is a new version, and gets its own answer. */
    version: integer("version").notNull(),
    liked: boolean("liked").notNull(),
    /** photos | video */
    kind: text("kind").notNull(),
    /** Gemini directed it (else the rules did). */
    directed: boolean("directed").notNull().default(false),
    /** `PROMPT_VERSION` in select.ts when Gemini directed it. */
    promptVersion: text("prompt_version"),
    model: text("model"),
    trackId: integer("track_id"),
    /** What the reel was (`ReelFeedbackSnapshot` in src/lib/reels/feedback.ts). */
    reel: jsonb("reel").notNull(),
    createdBy: integer("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reel_feedback_job_version_idx").on(t.jobId, t.version),
    index("reel_feedback_created_idx").on(t.createdAt),
  ],
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

/* -------------------------------------------------------------------------- */
/* Seelie                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Seelie, the OMS's agent. Its LLM runs through CLIProxyAPI on the ThinkPad,
 * so these tables only ever fill there; the sync leaves them out
 * (infra/sync/policy.json).
 *
 * One chat per conversation, listed in Seelie's sidebar. `model` and
 * `thinking` are what the composer last used, so reopening a chat keeps them.
 */
export const seelieChats = pgTable(
  "seelie_chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull().default(""),
    model: text("model"),
    thinking: text("thinking"),
    /** Changes to the OMS run without an approval card. Changes to a marketplace or to paribelle.in still ask. */
    autoApprove: boolean("auto_approve").notNull().default(false),
    pinned: boolean("pinned").notNull().default(false),
    /**
     * A long chat compacted (routines.ts): what Seelie reads in place of the messages up to
     * and including `summaryThrough`. The screen still shows every message.
     */
    summary: text("summary"),
    summaryThrough: integer("summary_through"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Last activity, which orders the sidebar. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("seelie_chats_user_updated_idx").on(t.userId, t.updatedAt)],
);

/**
 * One reply from Seelie: everything it did for one message, from the first
 * token to the last tool. The process that starts a run keeps it in memory and
 * mirrors it here, so any other process (the ThinkPad runs one per core) can
 * show it, approve its changes or stop it.
 */
export const seelieRuns = pgTable(
  "seelie_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => seelieChats.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    /** running | waiting (on an approval) | done | error | aborted | interrupted */
    status: text("status").notNull().default("running"),
    model: text("model").notNull(),
    thinking: text("thinking").notNull(),
    /** The reply being streamed right now (an assistant message), for viewers in other processes. */
    partial: jsonb("partial"),
    error: text("error"),
    /** Stop was pressed in a process that doesn't hold the run; the holder sees it and aborts. */
    abortRequested: boolean("abort_requested").notNull().default(false),
    /** Token totals across the run's turns. */
    usage: jsonb("usage"),
    /** hostname:pid of the process running it. */
    owner: text("owner"),
    /** Bumped while the run is alive. A stale one means its process died: the run reads as interrupted. */
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("seelie_runs_chat_idx").on(t.chatId, t.startedAt)],
);

/**
 * A chat's transcript, in order: pi's messages (user, assistant with its
 * thinking and tool calls, and tool results) exactly as the model saw them.
 */
export const seelieMessages = pgTable(
  "seelie_messages",
  {
    id: serial("id").primaryKey(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => seelieChats.id, { onDelete: "cascade" }),
    runId: uuid("run_id").references(() => seelieRuns.id, { onDelete: "set null" }),
    seq: integer("seq").notNull(),
    /** user | assistant | toolResult */
    role: text("role").notNull(),
    message: jsonb("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("seelie_messages_chat_seq_idx").on(t.chatId, t.seq)],
);

/**
 * Every tool call Seelie makes, with what the transcript doesn't hold: when it
 * ran, how long it took, and the approval a change waited on.
 */
export const seelieToolCalls = pgTable(
  "seelie_tool_calls",
  {
    id: serial("id").primaryKey(),
    runId: uuid("run_id")
      .notNull()
      .references(() => seelieRuns.id, { onDelete: "cascade" }),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => seelieChats.id, { onDelete: "cascade" }),
    /** The model's id for the call, which the transcript's tool result repeats. */
    callId: text("call_id").notNull(),
    tool: text("tool").notNull(),
    /** read | write (the OMS) | market (changes a marketplace) | store (changes paribelle.in); the last two always ask */
    kind: text("kind").notNull(),
    args: jsonb("args"),
    /** One line saying what the call does, for the approval card. */
    summary: text("summary"),
    /** awaiting | denied | running | done | error */
    status: text("status").notNull(),
    /** null for lookups; auto | approved | denied for changes */
    approval: text("approval"),
    decidedBy: integer("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("seelie_tool_calls_run_call_idx").on(t.runId, t.callId),
    index("seelie_tool_calls_chat_idx").on(t.chatId),
  ],
);

/**
 * Seelie's own settings, one row per key. `store` is the paribelle.in admin
 * login it signs in with (encrypted with AUTH_SECRET), entered once by the owner.
 */
export const seelieSettings = pgTable("seelie_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The pictures, clips and sounds Seelie's video tools work with that aren't already
 * somewhere in the OMS: clips attached in a chat, images fetched from a URL, product
 * cut-outs, generated scenes, frames saved from a video. The files are on the
 * ThinkPad's media folder (SEELIE_MEDIA_DIR); this is their index. Tools name them
 * `asset:<id>`.
 */
export const seelieAssets = pgTable(
  "seelie_assets",
  {
    id: serial("id").primaryKey(),
    chatId: uuid("chat_id").references(() => seelieChats.id, { onDelete: "set null" }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    /** image | video | audio | subtitles */
    kind: text("kind").notNull(),
    /** upload | url | cutout | generated | frame | photoshoot | edited | mask */
    source: text("source").notNull(),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    /** The file, relative to the media folder. */
    file: text("file").notNull(),
    bytes: integer("bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    /** Seconds, for video and audio. */
    duration: real("duration"),
    hasAudio: boolean("has_audio"),
    /** Where it came from: the URL, the prompt, the assets it was made from. */
    meta: jsonb("meta"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("seelie_assets_chat_idx").on(t.chatId)],
);

/**
 * Seelie's video library: every video it renders, with the filter graph and inputs
 * that made each version, so any of them can be rendered again. The files are in the
 * media folder (videos/<id>/v<version>.mp4). Tools name them `video:<id>`.
 */
export const seelieVideos = pgTable(
  "seelie_videos",
  {
    id: serial("id").primaryKey(),
    chatId: uuid("chat_id").references(() => seelieChats.id, { onDelete: "set null" }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    /** What was asked for, in the person's words. */
    prompt: text("prompt"),
    /** The latest version (0 before the first render). */
    version: integer("version").notNull().default(0),
    /** Every render, oldest first (`VideoVersion` in src/lib/seelie/media/library.ts). */
    versions: jsonb("versions").notNull().default([]),
    /** The library song it uses. Each song makes one video or reel. */
    trackId: integer("track_id").references(() => reelTracks.id, { onDelete: "set null" }),
    /** The owner's verdict and what they said about it, which Seelie learns from. */
    liked: boolean("liked"),
    notes: text("notes"),
    /** Where it went: paribelle.in products and Instagram posts (`Published` in library.ts). */
    published: jsonb("published").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("seelie_videos_updated_idx").on(t.updatedAt)],
);

/**
 * Seelie's product studio. Only photoshoots generate images (the Antigravity image
 * model, capped at a handful of images per account every ~5 hours, a cap Google
 * doesn't report); every other photo edit is Seelie's own code.
 *
 * A garment as Seelie has studied it: its photos and the exact description it wrote
 * after looking at all of them, reused by every later shoot of that product.
 * `key` names the product: "sku:<oms sku>", "store:<paribelle id>", "asin:<asin>",
 * or "look:<name>" for one known only from photos.
 */
export const seelieGarments = pgTable("seelie_garments", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  /** Seelie's description after studying every photo (`GarmentSpec` in src/lib/seelie/studio/prompts.ts). */
  spec: jsonb("spec"),
  /** The product's photos as assets: `{ ref, view, note? }` (view: front, back, side, detail, worn, flat). */
  photos: jsonb("photos").notNull().default([]),
  updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A recurring model for shoots (a synthetic person): reference images keep the face the same across a set. */
export const seeliePersonas = pgTable("seelie_personas", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  /** Up to 4 image asset ids: face first, then full length. */
  refs: jsonb("refs").notNull().default([]),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One photoshoot: a garment, a persona and its looks, each with every attempt, the
 * check of each attempt and the one chosen (`ShootLook` in src/lib/seelie/studio/shoots.ts).
 */
export const seelieShoots = pgTable(
  "seelie_shoots",
  {
    id: serial("id").primaryKey(),
    chatId: uuid("chat_id").references(() => seelieChats.id, { onDelete: "set null" }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    garmentKey: text("garment_key").references(() => seelieGarments.key, { onDelete: "set null" }),
    personaId: integer("persona_id").references(() => seeliePersonas.id, { onDelete: "set null" }),
    /** What the owner asked for, in their words. */
    brief: text("brief"),
    looks: jsonb("looks").notNull().default([]),
    /** planned | shooting | waiting (on the image cap) | done */
    status: text("status").notNull().default("planned"),
    liked: boolean("liked"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("seelie_shoots_updated_idx").on(t.updatedAt)],
);

/**
 * Every image-model call: the ledger the image budget is worked out from, since the
 * account's cap shows nowhere else. `outcome`: ok | limit (HTTP 429, with the reset
 * time it gave) | empty (no image came back) | error.
 */
export const seelieImageCalls = pgTable(
  "seelie_image_calls",
  {
    id: serial("id").primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    chatId: uuid("chat_id").references(() => seelieChats.id, { onDelete: "set null" }),
    shootId: integer("shoot_id").references(() => seelieShoots.id, { onDelete: "set null" }),
    look: text("look"),
    model: text("model").notNull(),
    size: text("size"),
    aspect: text("aspect"),
    refs: integer("refs").notNull().default(0),
    outcome: text("outcome").notNull(),
    resetAt: timestamp("reset_at", { withTimezone: true }),
    ms: integer("ms"),
    error: text("error"),
  },
  (t) => [index("seelie_image_calls_at_idx").on(t.at)],
);

/**
 * Seelie's routines: a message it gets on a schedule (India time), each run replying in
 * the routine's own chat. The ThinkPad's sync service asks /api/cron/seelie every minute
 * for the ones due.
 */
export const seelieRoutines = pgTable(
  "seelie_routines",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Made at the first run (and again if the chat was deleted). */
    chatId: uuid("chat_id").references(() => seelieChats.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    /** RoutineSchedule (lib/seelie/schedule.ts). */
    schedule: jsonb("schedule").notNull(),
    model: text("model"),
    thinking: text("thinking"),
    /** Ordinary writes run without asking; ads, posts, marketplaces and paribelle.in still wait. Kept in step with the chat's switch. */
    autoApprove: boolean("auto_approve").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    /** Null while switched off. */
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunId: uuid("last_run_id").references(() => seelieRuns.id, { onDelete: "set null" }),
    /** Why the last time didn't run (missed, still waiting on an approval, an error). */
    lastNote: text("last_note"),
    /** The last run the owner has seen (opened, or closed its note). */
    seenRunId: uuid("seen_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("seelie_routines_due_idx").on(t.enabled, t.nextRunAt), index("seelie_routines_user_idx").on(t.userId)],
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
export type SeelieChat = typeof seelieChats.$inferSelect;
export type SeelieRun = typeof seelieRuns.$inferSelect;
export type SeelieToolCall = typeof seelieToolCalls.$inferSelect;
