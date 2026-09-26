import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { db } from "@/db";
import { friendlyItem } from "@/lib/friendly-item";
import { productFamilyKey } from "@/lib/finance-queries";

/**
 * The Finance overview's numbers: real profit on Amazon orders.
 *
 * Every order counts in the range it was placed in, with everything that later
 * happened to it (sale, fees, refund, RTO), so a short range never looks good
 * just because its returns haven't posted yet. Lines that belong to no order
 * (ads, account fees, tax withheld) count on the day Amazon posted them.
 *
 *   Amazon net = every line Amazon posted, paid or still held
 *   Profit     = Amazon net - cost of the goods customers kept
 *
 * Returned goods count as back on the shelf at cost. Most returns are never
 * checked in, so `returns.worst` is the profit if none of those came back.
 * GST sits inside Amazon net; the credits on fees and ads roughly cancel it
 * (see `tax`), so profit treats it as a wash.
 *
 * Everything is worked out from one read of all orders: 2k orders and 8k lines
 * are cheap, and the all-time figures (money with Amazon, the usual return
 * rate) come from the same read as the range.
 */

type Fate =
  | "kept"
  | "returned"
  | "partial_return"
  | "rto"
  | "replacement"
  | "unsettled"
  | "pipeline"
  | "cancelled"
  | "cancelled_after_ship";

/** Goods that left the warehouse. */
const GOODS_OUT = new Set<Fate>(["kept", "returned", "partial_return", "rto", "replacement", "unsettled", "cancelled_after_ship"]);

/** An order this recent may still be returned; older ones have finished returning. */
const RETURN_WINDOW_DAYS = 30;

const BUCKETS = ["principal", "tax", "promo", "tcs_tds", "fees", "postage", "refund_commission", "total"] as const;
type Bucket = (typeof BUCKETS)[number];
type Buckets = Record<Bucket, number>;

interface OrderRec {
  id: number;
  status: string;
  orderedAt: number;
  month: string;
  cost: number | null;
  items: { name: string; mapped: boolean; qty: number; value: number; unitCost: number | null }[];
  /** Shipment, Refund, and every other line on the order. */
  s: Buckets;
  r: Buckets;
  o: Buckets;
  shipLines: number;
  net: number;
  held: number;
  heldShip: number;
  safeT: number;
  undeliverable: number;
  otherReimb: number;
  fate: Fate;
  keptFrac: number;
  backFrac: number;
  backConfirmed: boolean;
}

interface LooseLine {
  type: string;
  description: string;
  status: string;
  total: number;
  tax: number;
  postedAt: number;
  month: string;
}

export interface FlowLine {
  key: string;
  label: string;
  value: number;
  note?: string;
}

export interface MonthRow {
  month: string;
  placed: number;
  kept: number;
  returned: number;
  returnRate: number | null;
  sales: number;
  net: number;
  cogs: number;
  profit: number;
  /** A fifth or more of its orders are still inside the return window. */
  open: boolean;
}

export interface ProductRow {
  key: string;
  name: string;
  unmapped: boolean;
  shipped: number;
  kept: number;
  returnRate: number | null;
  net: number;
  cogs: number;
  profit: number;
  /** Shipped, but no cost price set: profit unknown. */
  noCost: boolean;
}

export interface ProfitView {
  /** Orders placed in the range and what happened to them. */
  orders: {
    placed: number;
    cancelled: number;
    shipped: number;
    kept: number;
    returned: number;
    rto: number;
    replacement: number;
    notShipped: number;
    returnRate: number | null;
    rtoRate: number | null;
    cancelRate: number | null;
  };
  profit: number;
  /** Sales before GST, less what was refunded: what customers kept. */
  keptSales: number;
  margin: number | null;
  perKept: number | null;
  /** Returns still expected on recent orders, at the usual rate. */
  pending: { orders: number; expected: number; impact: number; usualRate: number } | null;
  flowIn: FlowLine[];
  flowOut: FlowLine[];
  net: number;
  cogs: number;
  /** Per order a customer kept. */
  perOrder: { rows: FlowLine[]; profit: number; keptOrders: number } | null;
  unit: { keptEarns: number | null; returnCosts: number | null; rtoCosts: number | null; adsPerShipped: number | null };
  returns: { back: number; confirmed: number; unconfirmedCost: number; worst: number; safeT: number; safeTOrders: number };
  months: MonthRow[];
  products: ProductRow[];
  /** Products that shipped fewer than five units, together. */
  smallProducts: { count: number; shipped: number; kept: number; net: number; cogs: number; profit: number } | null;
  tax: { outputGst: number; adsGst: number; feeGst: number; left: number; tcs: number };
  missingCost: { orders: number; net: number; unmapped: number };
}

export interface MoneyToday {
  paid: number;
  /** Released by Amazon, waiting for the next transfer. */
  nextPayout: number;
  held: number;
  owed: number;
  lastPayoutAt: string | null;
  /** Orders whose sale money is on hold, and the cost of the goods in them. */
  heldOrders: number;
  heldCost: number;
  notShippedOrders: number;
  notShippedCost: number;
}

export interface ProfitData {
  view: ProfitView;
  money: MoneyToday;
  /** Months with orders, newest first, for the range picker. */
  months: string[];
  /** Rows in finance_transactions: zero means the first sync has not run. */
  lineCount: number;
}

const n = (v: unknown) => (v == null ? 0 : Number(v));
const sum = <T>(xs: T[], f: (x: T) => number) => xs.reduce((s, x) => s + (f(x) || 0), 0);
const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

function bucketCols(prefix: string, cond: SQL): SQL {
  return sql.join(
    BUCKETS.map((b) => sql`COALESCE(SUM(t.${sql.raw(b)}) FILTER (WHERE ${cond}), 0) AS ${sql.raw(`${prefix}_${b}`)}`),
    sql`, `,
  );
}

function readBuckets(row: Record<string, unknown>, prefix: string): Buckets {
  return Object.fromEntries(BUCKETS.map((b) => [b, n(row[`${prefix}_${b}`])])) as Buckets;
}

async function load(): Promise<{ orders: OrderRec[]; loose: LooseLine[]; transfers: LooseLine[]; lineCount: number }> {
  const [orderRows, itemRows, looseRows, countRows] = await Promise.all([
    db.execute(sql`
      SELECT o.id, o.status, o.ordered_at,
        to_char(o.ordered_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month,
        (SELECT f.cost_price FROM order_finance f WHERE f.order_id = o.id) AS frozen,
        EXISTS (SELECT 1 FROM returns r WHERE r.order_id = o.id AND r.restocked) AS restocked,
        EXISTS (SELECT 1 FROM order_status_events e WHERE e.order_id = o.id AND e.to_status = 'rto' AND e.item_back) AS item_back,
        COUNT(t.transaction_id) FILTER (WHERE t.type = 'Shipment') AS ship_lines,
        ${bucketCols("s", sql`t.type = 'Shipment'`)},
        ${bucketCols("r", sql`t.type = 'Refund'`)},
        ${bucketCols("o", sql`t.type NOT IN ('Shipment', 'Refund')`)},
        COALESCE(SUM(t.total) FILTER (WHERE t.status = 'DEFERRED'), 0) AS held,
        COALESCE(SUM(t.total) FILTER (WHERE t.status = 'DEFERRED' AND t.type = 'Shipment'), 0) AS held_ship,
        COALESCE(SUM(t.total) FILTER (WHERE t.type = 'Adjustment' AND t.description LIKE 'SERRAC%'), 0) AS safe_t,
        COALESCE(SUM(t.total) FILTER (WHERE t.type = 'MiscellaneousLedgerAdjustment' AND t.description = 'ESUndeliverableFee'), 0) AS undeliverable,
        COALESCE(SUM(t.total) FILTER (WHERE t.type = 'FBAInventoryReimbursement'
          OR (t.type = 'MiscellaneousLedgerAdjustment' AND t.description = 'CancellationFeeRefund')), 0) AS other_reimb
      FROM orders o
      LEFT JOIN finance_transactions t
        ON t.external_order_id = o.external_order_id AND t.channel_account_id = o.channel_account_id
       AND t.status <> 'DEFERRED_RELEASED' AND t.type <> 'Transfer'
      WHERE o.channel = 'amazon'
      GROUP BY o.id
    `),
    db.execute(sql`
      SELECT oi.order_id, oi.quantity, oi.unit_price, oi.product_id,
        COALESCE(p.name, NULLIF(oi.title, ''), oi.external_sku) AS name, p.cost_price
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id AND o.channel = 'amazon'
      LEFT JOIN products p ON p.id = oi.product_id
      WHERE oi.cancelled = false
    `),
    // Lines that belong to no order: ads, account fees, tax withheld, payouts.
    db.execute(sql`
      SELECT t.type, COALESCE(t.description, '') AS description, t.status, t.total, t.tax, t.posted_at,
        to_char(t.posted_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month
      FROM finance_transactions t
      WHERE t.status <> 'DEFERRED_RELEASED'
        AND NOT EXISTS (
          SELECT 1 FROM orders o
          WHERE o.channel = 'amazon' AND o.external_order_id = t.external_order_id AND o.channel_account_id = t.channel_account_id
        )
    `),
    db.execute(sql`SELECT COUNT(*)::int AS n FROM finance_transactions`),
  ]);

  const items = new Map<number, OrderRec["items"]>();
  for (const i of itemRows.rows) {
    const list = items.get(n(i.order_id)) ?? [];
    list.push({
      name: String(i.name ?? ""),
      mapped: i.product_id != null,
      qty: n(i.quantity),
      value: n(i.unit_price) * n(i.quantity),
      unitCost: i.cost_price == null ? null : n(i.cost_price),
    });
    items.set(n(i.order_id), list);
  }

  const orders = orderRows.rows.map((row): OrderRec => {
    const live = items.get(n(row.id)) ?? [];
    // Same rule as COST_LOOKUP: a frozen cost wins, else every live item needs a cost.
    const cost =
      live.length === 0
        ? null
        : row.frozen != null
          ? n(row.frozen)
          : live.every((i) => i.unitCost != null)
            ? sum(live, (i) => i.qty * (i.unitCost ?? 0))
            : null;

    const s = readBuckets(row, "s");
    const r = readBuckets(row, "r");
    const o = readBuckets(row, "o");
    const shipLines = n(row.ship_lines);
    const status = String(row.status);
    const sp = s.principal;
    const rp = -r.principal;

    let fate: Fate;
    if (status === "cancelled") fate = shipLines ? "cancelled_after_ship" : "cancelled";
    else if (status === "new" || status === "ready_to_pack" || status === "packed") fate = "pipeline";
    else if (status === "rto") fate = "rto";
    else if (sp === 0 && shipLines > 0) fate = "replacement";
    else if (rp > 0 && sp > 0 && rp / sp >= 0.95) fate = "returned";
    else if (rp > 0) fate = "partial_return";
    else if (shipLines === 0) fate = "unsettled";
    else fate = "kept";

    const keptFrac =
      fate === "kept" || fate === "replacement" || fate === "unsettled"
        ? 1
        : fate === "partial_return"
          ? Math.max(0, Math.min(1, 1 - rp / sp))
          : 0;
    const backFrac =
      fate === "returned" || fate === "partial_return" || fate === "rto" || fate === "cancelled_after_ship" ? 1 - keptFrac : 0;
    const backConfirmed = fate === "rto" ? row.item_back === true : backFrac > 0 && row.restocked === true;

    return {
      id: n(row.id),
      status,
      orderedAt: new Date(row.ordered_at as string).getTime(),
      month: String(row.month),
      cost,
      items: live,
      s,
      r,
      o,
      shipLines,
      net: s.total + r.total + o.total,
      held: n(row.held),
      heldShip: n(row.held_ship),
      safeT: n(row.safe_t),
      undeliverable: n(row.undeliverable),
      otherReimb: n(row.other_reimb),
      fate,
      keptFrac,
      backFrac,
      backConfirmed,
    };
  });

  const all = looseRows.rows.map((t) => ({
    type: String(t.type),
    description: String(t.description),
    status: String(t.status),
    total: n(t.total),
    tax: n(t.tax),
    postedAt: new Date(t.posted_at as string).getTime(),
    month: String(t.month),
  }));

  return {
    orders,
    loose: all.filter((t) => t.type !== "Transfer"),
    transfers: all.filter((t) => t.type === "Transfer"),
    lineCount: n(countRows.rows[0]?.n),
  };
}

/** Kept orders' average margin over cost, less a return's average loss: what one more return costs. */
function returnSwing(orders: OrderRec[]): number {
  const kept = orders.filter((r) => r.fate === "kept");
  const keptCosted = kept.filter((r) => r.cost != null);
  const returned = orders.filter((r) => r.fate === "returned");
  if (!kept.length || !keptCosted.length || !returned.length) return 0;
  const keptNet = sum(kept, (r) => r.net) / kept.length;
  const keptCost = sum(keptCosted, (r) => r.cost ?? 0) / keptCosted.length;
  const returnLoss = sum(returned, (r) => r.net) / returned.length;
  return keptNet - keptCost - returnLoss;
}

function compute(
  rows: OrderRec[],
  loose: LooseLine[],
  ctx: { usualRate: number | null; swing: number; windowStart: number },
): ProfitView {
  const count = (f: Fate) => rows.filter((r) => r.fate === f).length;
  const out = rows.filter((r) => GOODS_OUT.has(r.fate));
  const withCost = (xs: OrderRec[]) => xs.filter((r) => r.cost != null);
  const S = (b: Bucket) => sum(rows, (r) => r.s[b]);
  const R = (b: Bucket) => sum(rows, (r) => r.r[b]);
  const O = (b: Bucket) => sum(rows, (r) => r.o[b]);
  const L = (pred: (t: LooseLine) => boolean) => sum(loose.filter(pred), (t) => t.total);

  /* ------------------------------------------------------ Amazon net, by kind */
  const ads = L((t) => t.type === "ProductAdsPayment");
  const W = {
    sales: S("principal"),
    gst: S("tax"),
    promo: S("promo"),
    refunds: R("principal") + R("tax") + R("promo"),
    fees: S("fees") + R("fees") + O("fees"),
    refundCommission: S("refund_commission") + R("refund_commission") + O("refund_commission"),
    postage: S("postage") + R("postage") + O("postage"),
    accountFees: L((t) => t.type === "ServiceFee"),
    undeliverable:
      sum(rows, (r) => r.undeliverable) +
      L((t) => t.type === "MiscellaneousLedgerAdjustment" && t.description === "ESUndeliverableFee"),
    tcs: S("tcs_tds") + R("tcs_tds") + O("tcs_tds") + L((t) => t.type === "TaxWithholding"),
    ads,
    safeT: sum(rows, (r) => r.safeT) + L((t) => t.type === "Adjustment" && t.description.startsWith("SERRAC")),
    otherReimb:
      sum(rows, (r) => r.otherReimb) +
      L(
        (t) =>
          t.type === "FBAInventoryReimbursement" ||
          (t.type === "MiscellaneousLedgerAdjustment" && t.description === "CancellationFeeRefund"),
      ),
  };
  const net = sum(rows, (r) => r.net) + sum(loose, (t) => t.total);
  const other = net - Object.values(W).reduce((a, b) => a + b, 0);

  /* ------------------------------------------------------------------ goods */
  const cogs = sum(withCost(out), (r) => (r.cost ?? 0) * r.keptFrac);
  const repl = rows.filter((r) => r.fate === "replacement");
  const replCogs = sum(withCost(repl), (r) => r.cost ?? 0);
  const back = out.filter((r) => r.fate === "returned" || r.fate === "partial_return" || r.fate === "rto");
  const unconfirmedCost = sum(
    withCost(out).filter((r) => r.backFrac > 0 && !r.backConfirmed),
    (r) => (r.cost ?? 0) * r.backFrac,
  );
  const profit = net - cogs;
  const keptSales = W.sales + R("principal");

  /* ----------------------------------------------------------------- orders */
  const kept = count("kept");
  const partial = count("partial_return");
  const returned = count("returned") + partial;
  const rto = count("rto");
  const replacement = count("replacement");
  const shipped = kept + returned + rto + replacement + count("unsettled");
  const placed = rows.length;
  const cancelled = count("cancelled") + count("cancelled_after_ship");
  const keptN = kept + partial;

  /* ---------------------------------------------------------- one kept order */
  const keptRows = rows.filter((r) => r.fate === "kept");
  const keptSide = rows.filter((r) => r.fate === "kept" || r.fate === "partial_return");
  const returnedRows = rows.filter((r) => r.fate === "returned");
  const rtoRows = rows.filter((r) => r.fate === "rto");
  const keptCosted = withCost(keptRows);
  let perOrder: ProfitView["perOrder"] = null;
  if (keptN > 0) {
    const sale = sum(
      keptSide,
      (r) => r.s.principal + r.s.tax + r.s.promo + (r.fate === "partial_return" ? r.r.principal + r.r.tax + r.r.promo : 0),
    );
    const parts = {
      sale,
      amazon: sum(keptSide, (r) => r.net) - sale,
      cost: -sum(withCost(keptSide), (r) => (r.cost ?? 0) * r.keptFrac),
      returns: sum(returnedRows, (r) => r.net),
      ads,
      replacements: sum(repl, (r) => r.net) - replCogs,
    };
    const rest = profit - Object.values(parts).reduce((a, b) => a + b, 0);
    const per = (v: number) => v / keptN;
    perOrder = {
      rows: [
        { key: "sale", label: "Customer paid, with GST", value: per(parts.sale) },
        { key: "amazon", label: "Amazon fees and postage", value: per(parts.amazon) },
        { key: "cost", label: "Cost of the goods", value: per(parts.cost) },
        { key: "returns", label: "Returns", value: per(parts.returns) },
        { key: "ads", label: "Ads", value: per(parts.ads) },
        { key: "replacements", label: "Free replacements", value: per(parts.replacements) },
        { key: "rest", label: "RTOs and everything else", value: per(rest) },
      ],
      profit: per(profit),
      keptOrders: keptN,
    };
  }

  /* -------------------------------------------------- returns still to come */
  const recent = rows.filter(
    (r) => r.orderedAt >= ctx.windowStart && (r.fate === "kept" || r.fate === "returned" || r.fate === "partial_return"),
  );
  let pending: ProfitView["pending"] = null;
  if (recent.length && ctx.usualRate != null) {
    const returnedSoFar = recent.filter((r) => r.fate !== "kept").length;
    const expected = Math.max(0, Math.round(ctx.usualRate * recent.length - returnedSoFar));
    if (expected > 0) pending = { orders: recent.length, expected, impact: -expected * ctx.swing, usualRate: ctx.usualRate };
  }

  /* ------------------------------------------------------------------ months */
  const monthKeys = [...new Set([...rows.map((r) => r.month), ...loose.map((t) => t.month)])].sort();
  const months: MonthRow[] = monthKeys.map((m) => {
    const rs = rows.filter((r) => r.month === m);
    const outM = rs.filter((r) => GOODS_OUT.has(r.fate));
    const k = rs.filter((r) => r.fate === "kept").length;
    const ret = rs.filter((r) => r.fate === "returned" || r.fate === "partial_return").length;
    const monthNet = sum(rs, (r) => r.net) + sum(loose.filter((t) => t.month === m), (t) => t.total);
    const monthCogs = sum(withCost(outM), (r) => (r.cost ?? 0) * r.keptFrac);
    const recentShare = rs.length ? rs.filter((r) => r.orderedAt >= ctx.windowStart).length / rs.length : 0;
    return {
      month: m,
      placed: rs.length,
      kept: k,
      returned: ret,
      returnRate: ratio(ret, k + ret),
      sales: sum(rs, (r) => r.s.principal),
      net: monthNet,
      cogs: monthCogs,
      profit: monthNet - monthCogs,
      // A month with a few days in the window is close enough to finished.
      open: recentShare >= 0.2,
    };
  });

  /* ---------------------------------------------------------------- products */
  const fam = new Map<string, ProductRow & { uncosted: number; returnedUnits: number }>();
  for (const r of out) {
    const value = sum(r.items, (i) => i.value);
    for (const i of r.items) {
      const share = value > 0 ? i.value / value : 1 / r.items.length;
      const key = productFamilyKey(i.name);
      let f = fam.get(key);
      if (!f) {
        f = {
          key,
          name: friendlyItem(i.name).name,
          unmapped: true,
          shipped: 0,
          kept: 0,
          returnRate: null,
          net: 0,
          cogs: 0,
          profit: 0,
          noCost: false,
          uncosted: 0,
          returnedUnits: 0,
        };
        fam.set(key, f);
      }
      if (i.mapped) f.unmapped = false;
      f.shipped += i.qty;
      f.kept += i.qty * r.keptFrac;
      if (r.fate !== "rto") f.returnedUnits += i.qty * r.backFrac;
      f.net += r.net * share;
      if (i.unitCost == null) f.uncosted += i.qty * r.keptFrac;
      else
        f.cogs +=
          i.qty * r.keptFrac * (r.cost != null && r.items.length === 1 ? r.cost / Math.max(1, i.qty) : i.unitCost);
    }
  }
  const families = [...fam.values()].map(({ uncosted, returnedUnits, ...f }) => ({
    ...f,
    profit: f.net - f.cogs,
    returnRate: ratio(returnedUnits, f.kept + returnedUnits),
    noCost: f.cogs === 0 && uncosted > 0,
  }));
  const products = families
    .filter((f) => f.shipped >= 5)
    .sort((a, b) => (a.noCost !== b.noCost ? (a.noCost ? 1 : -1) : b.profit - a.profit));
  const small = families.filter((f) => f.shipped < 5);
  const smallProducts = small.length
    ? {
        count: small.length,
        shipped: sum(small, (f) => f.shipped),
        kept: sum(small, (f) => f.kept),
        net: sum(small, (f) => f.net),
        cogs: sum(small, (f) => f.cogs),
        profit: sum(small, (f) => f.profit),
      }
    : null;

  /* --------------------------------------------------------------------- tax */
  const outputGst = S("tax") + R("tax");
  const adsGst = -sum(loose.filter((t) => t.type === "ProductAdsPayment"), (t) => t.tax);
  const feeGst = -(W.fees + W.refundCommission + W.postage + W.accountFees) * (18 / 118);

  const missing = out.filter((r) => r.cost == null);

  const flowIn: FlowLine[] = [
    { key: "sales", label: "Sales", value: W.sales, note: `${shipped.toLocaleString("en-IN")} orders, before GST` },
    { key: "gst", label: "GST collected", value: W.gst, note: "owed to the government" },
    { key: "safeT", label: "SAFE-T claims", value: W.safeT },
    { key: "otherReimb", label: "Other reimbursements", value: W.otherReimb },
    { key: "other", label: "Other", value: other },
  ];
  const flowOut: FlowLine[] = [
    { key: "refunds", label: "Refunds", value: W.refunds, note: `${(returned + rto).toLocaleString("en-IN")} returns and RTOs` },
    { key: "postage", label: "Postage", value: W.postage + W.undeliverable },
    { key: "ads", label: "Ads", value: W.ads },
    { key: "fees", label: "Amazon fees", value: W.fees + W.refundCommission + W.accountFees },
    { key: "tcs", label: "TCS and TDS", value: W.tcs, note: "claimable" },
    { key: "promo", label: "Promotions", value: W.promo },
  ];

  return {
    orders: {
      placed,
      cancelled,
      shipped,
      kept,
      returned,
      rto,
      replacement,
      notShipped: count("pipeline"),
      returnRate: ratio(returned, kept + returned),
      rtoRate: ratio(rto, kept + returned + rto),
      cancelRate: ratio(cancelled, placed),
    },
    profit,
    keptSales,
    margin: ratio(profit, keptSales),
    perKept: keptN > 0 ? profit / keptN : null,
    pending,
    // Money in counts only what is positive, money out only what is negative; the
    // sign of "Other" decides which side it sits on.
    flowIn: [...flowIn.filter((l) => l.value > 0.5), ...flowOut.filter((l) => l.value > 0.5)],
    flowOut: [...flowOut.filter((l) => l.value < -0.5), ...flowIn.filter((l) => l.value < -0.5)].sort(
      (a, b) => a.value - b.value,
    ),
    net,
    cogs,
    perOrder,
    unit: {
      keptEarns:
        keptRows.length && keptCosted.length
          ? sum(keptRows, (r) => r.net) / keptRows.length - sum(keptCosted, (r) => r.cost ?? 0) / keptCosted.length
          : null,
      returnCosts: returnedRows.length ? sum(returnedRows, (r) => r.net) / returnedRows.length : null,
      rtoCosts: rtoRows.length ? sum(rtoRows, (r) => r.net) / rtoRows.length : null,
      adsPerShipped: shipped ? ads / shipped : null,
    },
    returns: {
      back: back.length,
      confirmed: back.filter((r) => r.backConfirmed).length,
      unconfirmedCost,
      worst: profit - unconfirmedCost,
      safeT: W.safeT,
      safeTOrders: rows.filter((r) => r.safeT !== 0).length,
    },
    months,
    products,
    smallProducts,
    tax: { outputGst, adsGst, feeGst, left: -outputGst + adsGst + feeGst, tcs: -W.tcs },
    missingCost: {
      orders: missing.length,
      net: sum(missing, (r) => r.net),
      unmapped: missing.filter((r) => r.items.some((i) => !i.mapped)).length,
    },
  };
}

export async function getProfitData(from: Date, to: Date): Promise<ProfitData> {
  const { orders, loose, transfers, lineCount } = await load();
  const windowStart = Date.now() - RETURN_WINDOW_DAYS * 86_400_000;

  // The usual return rate, from orders old enough to have finished returning.
  const settled = orders.filter(
    (r) => r.orderedAt < windowStart && (r.fate === "kept" || r.fate === "returned" || r.fate === "partial_return"),
  );
  const usualRate = ratio(settled.filter((r) => r.fate !== "kept").length, settled.length);

  const f = from.getTime();
  const t = to.getTime();
  const view = compute(
    orders.filter((r) => r.orderedAt >= f && r.orderedAt < t),
    loose.filter((l) => l.postedAt >= f && l.postedAt < t),
    { usualRate, swing: returnSwing(orders), windowStart },
  );

  /* ------------------------------------------------- money with Amazon, today */
  const paid = sum(transfers, (x) => x.total);
  const held = sum(orders, (r) => r.held) + sum(loose.filter((l) => l.status === "DEFERRED"), (l) => l.total);
  const netAll = sum(orders, (r) => r.net) + sum(loose, (l) => l.total);
  // Whatever Amazon has settled and neither paid out nor still holds is released, waiting for the next transfer.
  const nextPayout = netAll - held - paid;
  const heldOrders = orders.filter((r) => r.heldShip !== 0);
  const notShipped = orders.filter((r) => r.fate === "pipeline");
  const lastPayout = transfers.reduce((m, x) => Math.max(m, x.postedAt), 0);

  return {
    view,
    money: {
      paid,
      nextPayout,
      held,
      owed: nextPayout + held,
      lastPayoutAt: lastPayout ? new Date(lastPayout).toISOString() : null,
      heldOrders: heldOrders.length,
      heldCost: sum(heldOrders, (r) => (r.cost ?? 0) * r.keptFrac),
      notShippedOrders: notShipped.length,
      notShippedCost: sum(notShipped, (r) => r.cost ?? 0),
    },
    months: [...new Set(orders.map((r) => r.month))].sort().reverse(),
    lineCount,
  };
}
