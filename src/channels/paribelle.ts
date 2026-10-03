import "server-only";

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import type { ChannelAccount, OrderStatus } from "@/db/schema";
import { STORE_VENDOR_ID, StoreError, storeApiUrl, storeFetch, type StoreMethod, type StoreRequest } from "@/lib/seelie/store";

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

/**
 * paribelle.in, the shop's own storefront, as a channel. Its API is ours, so there
 * is no marketplace in between: the adapter reads orders and exchanges through the
 * admin routes the storefront's own admin uses, signed in with the paribelle.in login
 * saved in Seelie's settings (lib/seelie/store), and the OMS's stock is published to
 * the store's variants by SKU.
 *
 * The store ships with whatever courier the owner books (it has no courier link), so
 * its labels are made here: an address label with the order, COD amount and items.
 * Writing back (shipped with AWB, delivered, cancelled, exchanges) lives in
 * lib/paribelle.ts, called from the OMS's screens.
 */

/* -------------------------------------------------------------------------- */
/* The API's shapes                                                           */
/* -------------------------------------------------------------------------- */

export interface ParibelleOrderItem {
  id: string;
  productId: string;
  productName: string;
  productSku: string;
  quantity: number;
  price: string | number;
  variantId?: string | null;
  variantDetails?: { sku?: string | null; attributes?: Record<string, string> | null } | null;
}

export interface ParibelleOrder {
  id: string;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  paymentMethod: string | null;
  total: string | number;
  codCharge?: string | number;
  shippingCost?: string | number;
  shippingName: string;
  shippingPhone: string;
  shippingEmail?: string;
  shippingAddress: { fullName?: string; phone?: string; addressLine1?: string; city?: string; state?: string; postalCode?: string; country?: string } | string;
  shippingCity: string;
  shippingState: string;
  shippingPostalCode: string;
  trackingNumber?: string | null;
  carrier?: string | null;
  customerNotes?: string | null;
  cancellationReason?: string | null;
  confirmedAt?: string | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  cancelledAt?: string | null;
  createdAt: string;
  updatedAt: string;
  items?: ParibelleOrderItem[];
  replacementForExchange?: { returnNumber: string; originalOrderNumber: string } | null;
}

export interface ParibelleExchange {
  id: string;
  returnNumber: string;
  orderId: string;
  orderItemId: string;
  requestType: "return" | "exchange";
  quantity: number;
  reason: string;
  status: string;
  productName: string;
  productSku: string;
  variantOptions?: Record<string, string> | null;
  refundTotal?: string | number | null;
  courierCharge?: string | number | null;
  customerNotes?: string | null;
  adminNotes?: string | null;
  rejectionReason?: string | null;
  customerTrackingNumber?: string | null;
  inspectionResult?: "passed" | "failed" | null;
  inspectionNotes?: string | null;
  replacementTrackingNumber?: string | null;
  exchangeVariantId?: string | null;
  exchangeVariant?: { sku?: string; productId?: string; variantAttributes?: Record<string, string> | null; product?: { name?: string } | null } | null;
  orderItem?: { productId?: string } | null;
  completedOrderId?: string | null;
  requestedAt: string;
  approvedAt?: string | null;
  rejectedAt?: string | null;
  inTransitAt?: string | null;
  receivedAt?: string | null;
  replacementShippedAt?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
  order?: { orderNumber?: string } | null;
}

export interface StoreVariant {
  id: string;
  sku: string;
  price: string | number | null;
  compareAtPrice: string | number | null;
  stockQuantity: number | null;
  isActive: boolean;
  variantAttributes?: Record<string, string> | null;
  images?: string[] | null;
}

export interface StoreProduct {
  id: string;
  name: string;
  sku: string;
  stockQuantity: number;
  images?: string[] | null;
  featuredImage?: string | null;
  productVariants?: StoreVariant[];
}

/* -------------------------------------------------------------------------- */
/* Calls                                                                      */
/* -------------------------------------------------------------------------- */

/** One admin API call; store failures become channel errors the sync log shows. */
export async function paribelleCall<T>(method: StoreMethod, path: string, req: StoreRequest = {}): Promise<T> {
  try {
    return await storeFetch<T>(method, path, req);
  } catch (err) {
    if (err instanceof StoreError) throw new ChannelError("paribelle", err.message, err.status);
    throw err;
  }
}

export async function paribelleOrders(): Promise<ParibelleOrder[]> {
  const res = await paribelleCall<ParibelleOrder[] | { data?: ParibelleOrder[] }>("GET", "/orders/admin/all", { timeoutMs: 120_000 });
  return Array.isArray(res) ? res : (res?.data ?? []);
}

export async function paribelleExchanges(): Promise<ParibelleExchange[]> {
  const res = await paribelleCall<ParibelleExchange[] | { data?: ParibelleExchange[] }>("GET", "/exchanges/admin/all", { timeoutMs: 120_000 });
  return Array.isArray(res) ? res : (res?.data ?? []);
}

/** Every product the store sells, with its variants. */
export async function paribelleProducts(): Promise<StoreProduct[]> {
  const out: StoreProduct[] = [];
  for (let page = 1; page < 50; page++) {
    const res = await paribelleCall<{ products?: StoreProduct[]; data?: StoreProduct[]; total?: number } | StoreProduct[]>("GET", "/products", {
      query: { vendorId: STORE_VENDOR_ID, status: "all", page, limit: 100 },
    });
    const list = Array.isArray(res) ? res : (res.products ?? res.data ?? []);
    out.push(...list);
    if (Array.isArray(res) || list.length < 100 || (res.total != null && out.length >= res.total)) break;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                    */
/* -------------------------------------------------------------------------- */

const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const amount = (v: unknown) => {
  const n = num(v);
  return n === null || !Number.isFinite(n) ? null : n.toFixed(2);
};

export const isCodOrder = (o: Pick<ParibelleOrder, "paymentMethod">) => (o.paymentMethod ?? "").toLowerCase() === "cod";

/**
 * Whether the store's order is a real one: a COD order, or one that's been paid (a card
 * or UPI order whose payment never went through is a checkout that didn't finish).
 */
export function isPlacedOrder(o: ParibelleOrder) {
  if (isCodOrder(o)) return true;
  if (["pending", "failed"].includes(o.paymentStatus) && ["pending", "cancelled"].includes(o.status)) return false;
  return true;
}

/** The store's status in the OMS's words. A COD order refused at the door comes back cancelled after it shipped: that's an RTO. */
export function statusOf(o: ParibelleOrder): OrderStatus {
  switch (o.status) {
    case "pending":
    case "confirmed":
    case "processing":
      return "new";
    case "shipped":
      return "shipped";
    case "delivered":
    case "return_requested":
    case "return_approved":
      return "delivered";
    case "cancelled":
      return o.shippedAt ? "rto" : "cancelled";
    case "returned":
    case "refunded":
      return "returned";
    default:
      return "new";
  }
}

/** "Name (M, Pink)": the title shape the OMS reads size and colour from. */
export function titleOf(name: string, attrs: Record<string, string> | null | undefined) {
  if (!attrs) return name;
  const get = (key: string) => Object.entries(attrs).find(([k]) => k.toLowerCase() === key)?.[1];
  const parts = [get("size"), get("colour") ?? get("color")].filter(Boolean);
  return parts.length ? `${name} (${parts.join(", ")})` : name;
}

export const skuOf = (it: ParibelleOrderItem) => it.variantDetails?.sku?.trim() || it.productSku;

function addressOf(o: ParibelleOrder) {
  const a = typeof o.shippingAddress === "object" && o.shippingAddress ? o.shippingAddress : null;
  return {
    name: a?.fullName || o.shippingName,
    phone: a?.phone || o.shippingPhone,
    line: (a ? a.addressLine1 : (o.shippingAddress as string)) || "",
    city: a?.city || o.shippingCity,
    state: a?.state || o.shippingState,
    pincode: a?.postalCode || o.shippingPostalCode,
  };
}

/** What the OMS keeps of an order: no customer account, nothing beyond what shipping and the screens need. */
export function rawOf(o: ParibelleOrder) {
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    paymentStatus: o.paymentStatus,
    paymentMethod: o.paymentMethod,
    total: num(o.total),
    codCharge: num(o.codCharge),
    shippingCost: num(o.shippingCost),
    address: addressOf(o),
    trackingNumber: o.trackingNumber ?? null,
    carrier: o.carrier ?? null,
    customerNotes: o.customerNotes ?? null,
    cancellationReason: o.cancellationReason ?? null,
    confirmedAt: o.confirmedAt ?? null,
    shippedAt: o.shippedAt ?? null,
    deliveredAt: o.deliveredAt ?? null,
    cancelledAt: o.cancelledAt ?? null,
    replacementFor: o.replacementForExchange ?? null,
    items: (o.items ?? []).map((it) => ({
      id: it.id,
      productId: it.productId,
      variantId: it.variantId ?? null,
      sku: skuOf(it),
      name: it.productName,
      attributes: it.variantDetails?.attributes ?? null,
      quantity: it.quantity,
      price: num(it.price),
    })),
  };
}

export type ParibelleRaw = ReturnType<typeof rawOf>;

export function toCanonical(o: ParibelleOrder): CanonicalOrder {
  const a = addressOf(o);
  return {
    externalOrderId: o.orderNumber,
    status: statusOf(o),
    orderedAt: new Date(o.createdAt),
    buyerName: a.name || null,
    shipCity: a.city || null,
    shipState: a.state || null,
    shipPincode: a.pincode || null,
    totalAmount: amount(o.total),
    isCod: isCodOrder(o),
    dispatchBy: null,
    channelUpdatedAt: new Date(o.updatedAt),
    items: (o.items ?? []).map((it) => ({
      externalItemId: it.id,
      externalSku: skuOf(it),
      title: titleOf(it.productName, it.variantDetails?.attributes),
      quantity: it.quantity,
      unitPrice: amount(it.price),
      cancelled: o.status === "cancelled",
    })),
    shipment: o.trackingNumber ? { courier: o.carrier ?? null, awb: o.trackingNumber } : undefined,
    raw: rawOf(o),
  };
}

/** The store's exchange (or an old-style return) as an OMS return. */
export function toReturn(r: ParibelleExchange): CanonicalReturn {
  const want = r.exchangeVariant
    ? titleOf(r.exchangeVariant.product?.name ?? r.productName, r.exchangeVariant.variantAttributes)
    : null;
  return {
    externalReturnId: r.returnNumber,
    externalOrderId: r.order?.orderNumber ?? null,
    kind: r.requestType === "exchange" ? "exchange" : "return",
    reason: [r.reason, r.customerNotes].filter(Boolean).join(": ") || null,
    awb: r.customerTrackingNumber ?? null,
    status: r.status,
    requestedAt: r.requestedAt ? new Date(r.requestedAt) : null,
    refundAmount: r.requestType === "return" ? num(r.refundTotal) : null,
    labelCost: num(r.courierCharge),
    resolution: [r.inspectionResult && `inspection ${r.inspectionResult}`, want && `wants ${want}`].filter(Boolean).join(", ") || null,
    raw: {
      id: r.id,
      returnNumber: r.returnNumber,
      orderId: r.orderId,
      orderItemId: r.orderItemId,
      requestType: r.requestType,
      status: r.status,
      quantity: r.quantity,
      product: titleOf(r.productName, r.variantOptions),
      sku: r.productSku,
      wants: want,
      wantsSku: r.exchangeVariant?.sku ?? null,
      // A size or colour swap of the same piece ships off the exchange; another piece needs a new order.
      sameProduct: !r.exchangeVariant?.productId || !r.orderItem?.productId || r.exchangeVariant.productId === r.orderItem.productId,
      hasReplacement: Boolean(r.exchangeVariantId),
      rejectionReason: r.rejectionReason ?? null,
      inspectionResult: r.inspectionResult ?? null,
      inspectionNotes: r.inspectionNotes ?? null,
      replacementTrackingNumber: r.replacementTrackingNumber ?? null,
      completedOrderId: r.completedOrderId ?? null,
      approvedAt: r.approvedAt ?? null,
      inTransitAt: r.inTransitAt ?? null,
      receivedAt: r.receivedAt ?? null,
      replacementShippedAt: r.replacementShippedAt ?? null,
      completedAt: r.completedAt ?? null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The label                                                                  */
/* -------------------------------------------------------------------------- */

/** 4 x 6 inches, the size thermal label printers take. */
const LABEL_W = 288;
const LABEL_H = 432;

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) line = next;
      else {
        if (line) out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/** Characters the standard fonts can draw (₹ and Indian scripts can't be). */
const plain = (s: string) => s.replace(/₹/g, "Rs ").replace(/[^\x20-\x7E\n]/g, "");

export interface LabelSender {
  name: string;
  address: string;
  phone: string | null;
  gstin: string | null;
}

/** One order's shipping label. */
export async function paribelleLabel(o: ParibelleRaw, from: LabelSender): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Label ${o.orderNumber}`);
  const page = pdf.addPage([LABEL_W, LABEL_H]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0, 0, 0);
  const M = 14;
  const W = LABEL_W - 2 * M;
  let y = LABEL_H - M;

  const text = (p: PDFPage, s: string, size: number, font: PDFFont, x = M) => {
    p.drawText(plain(s), { x, y, size, font, color: ink });
  };
  const rule = () => {
    y -= 6;
    page.drawLine({ start: { x: M, y }, end: { x: LABEL_W - M, y }, thickness: 0.8, color: ink });
    y -= 12;
  };
  const block = (s: string, size: number, font: PDFFont, gap = 2) => {
    for (const line of wrap(plain(s), font, size, W)) {
      y -= size;
      text(page, line, size, font);
      y -= gap;
    }
  };

  const cod = (o.paymentMethod ?? "").toLowerCase() === "cod";
  y -= 18;
  text(page, cod ? `COD  Rs ${Math.round(o.total ?? 0)}` : "PREPAID", 18, bold);
  const tag = `Order ${o.orderNumber}`;
  page.drawText(plain(tag), { x: LABEL_W - M - regular.widthOfTextAtSize(plain(tag), 9), y: y + 5, size: 9, font: regular, color: ink });
  rule();

  block("SHIP TO", 8, bold);
  block(o.address.name, 14, bold);
  block(o.address.line, 11, regular);
  block([o.address.city, o.address.state].filter(Boolean).join(", "), 11, regular);
  block(`PIN ${o.address.pincode}`, 16, bold);
  if (o.address.phone) block(`Phone ${o.address.phone}`, 11, regular);
  rule();

  block("ITEMS", 8, bold);
  for (const it of o.items.slice(0, 6)) {
    const attrs = it.attributes ? Object.values(it.attributes).join(", ") : "";
    block(`${it.quantity} x ${it.name}${attrs ? ` (${attrs})` : ""}`, 9, regular, 1);
    block(`SKU ${it.sku}`, 7, regular, 3);
  }
  if (o.items.length > 6) block(`and ${o.items.length - 6} more`, 9, regular);
  if (o.trackingNumber) {
    rule();
    block(`${o.carrier ?? "Courier"} AWB ${o.trackingNumber}`, 11, bold);
  }

  // The sender at the foot, where returns go.
  y = M + 52;
  page.drawLine({ start: { x: M, y: y + 6 }, end: { x: LABEL_W - M, y: y + 6 }, thickness: 0.8, color: ink });
  block(`FROM ${from.name}`, 8, bold, 1);
  block(from.address, 7, regular, 1);
  block([from.phone && `Phone ${from.phone}`, from.gstin && `GSTIN ${from.gstin}`].filter(Boolean).join("  "), 7, regular, 1);
  return pdf.save();
}

/** Who's sending: the store's business details, as printed on its invoices. */
export async function labelSender(): Promise<LabelSender> {
  const res = await paribelleCall<Record<string, unknown> & { data?: Record<string, unknown> }>("GET", `/vendors/${STORE_VENDOR_ID}`);
  const v = (res?.data ?? res ?? {}) as Record<string, unknown>;
  const s = (k: string) => (v[k] == null ? "" : String(v[k]).trim());
  return {
    name: s("businessName") || s("storeName") || "PariBelle",
    address: [s("address"), s("city"), s("state"), s("postalCode")].filter(Boolean).join(", "),
    phone: s("contactPhone") || null,
    gstin: s("gstNumber") || null,
  };
}

/* -------------------------------------------------------------------------- */
/* The adapter                                                                */
/* -------------------------------------------------------------------------- */

export class ParibelleAdapter implements ChannelAdapter {
  readonly channel = "paribelle" as const;
  /** Off where the shop isn't connected (PARIBELLE_API_URL unset, as on the Vercel fallback). */
  get supportsLiveSync() {
    return storeApiUrl() !== null;
  }
  readonly supportsInventoryPush = true;
  readonly supportsLabelFetch = true;

  constructor(private account: ChannelAccount) {}

  /**
   * The store's admin list has every order (a small shop's whole history in one
   * answer), so a sync reads it all and keeps what changed since `since`, which the
   * ingest's upserts make safe to repeat. The account's first sync keeps everything.
   */
  async fetchOrders(opts: FetchOrdersOptions): Promise<FetchOrdersResult> {
    const all = (await paribelleOrders()).filter(isPlacedOrder);
    const since = this.account.ordersSyncedThrough ? opts.since.getTime() : 0;
    const changed = all.filter((o) => Date.parse(o.updatedAt) >= since || Date.parse(o.createdAt) >= since);
    await opts.onProgress?.({ seen: changed.length, total: changed.length });
    // The whole list was read, so the store is caught up to now.
    return { orders: changed.map(toCanonical), syncedThrough: new Date(), hasMore: false };
  }

  /** A backfill is the same list, kept to the orders placed in the window. */
  async *fetchOrdersViaReports(start: Date, end: Date): AsyncGenerator<CanonicalOrder[]> {
    const from = start.getTime();
    const to = end.getTime();
    const placed = (await paribelleOrders()).filter((o) => {
      const at = Date.parse(o.createdAt);
      return isPlacedOrder(o) && at >= from && at < to;
    });
    for (let i = 0; i < placed.length; i += 200) yield placed.slice(i, i + 200).map(toCanonical);
  }

  async fetchReturns(opts: FetchOrdersOptions) {
    const all = await paribelleExchanges();
    const since = this.account.returnsSyncedThrough ? opts.since.getTime() : 0;
    const changed = all.filter((r) => Date.parse(r.updatedAt ?? r.requestedAt) >= since || Date.parse(r.requestedAt) >= since);
    return { returns: changed.map(toReturn), syncedThrough: new Date() };
  }

  async fetchLabels(externalOrderIds: string[]): Promise<LabelResult[]> {
    const wanted = new Set(externalOrderIds);
    const found = (await paribelleOrders()).filter((o) => wanted.has(o.orderNumber));
    const from = await labelSender();
    const out: LabelResult[] = [];
    for (const o of found) out.push({ externalOrderId: o.orderNumber, pdf: Buffer.from(await paribelleLabel(rawOf(o), from)) });
    return out;
  }

  /**
   * The OMS's sellable stock onto the store's variants, by SKU. Each product is
   * written once with only the variants whose number changes; price and MRP go
   * back as they are.
   */
  async pushInventory(updates: InventoryUpdate[]): Promise<InventoryPushResult[]> {
    const want = new Map(updates.map((u) => [u.externalSku.trim().toLowerCase(), Math.max(0, Math.floor(u.quantity))]));
    const results: InventoryPushResult[] = [];
    const seen = new Set<string>();
    for (const p of await paribelleProducts()) {
      const patch: Record<string, unknown>[] = [];
      const skus: string[] = [];
      const variants = p.productVariants ?? [];
      for (const v of variants) {
        const key = v.sku?.trim().toLowerCase();
        if (!key || !want.has(key)) continue;
        seen.add(key);
        const quantity = want.get(key)!;
        if ((v.stockQuantity ?? 0) === quantity) {
          results.push({ externalSku: v.sku, ok: true });
          continue;
        }
        patch.push({ id: v.id, price: v.price, compareAtPrice: v.compareAtPrice, stockQuantity: quantity, isActive: v.isActive });
        skus.push(v.sku);
      }
      // A product without variants is sold by its own SKU.
      const ownKey = p.sku?.trim().toLowerCase();
      const own = !variants.length && ownKey && want.has(ownKey) ? want.get(ownKey)! : null;
      if (own !== null) seen.add(ownKey!);
      if (!patch.length && (own === null || own === p.stockQuantity)) {
        if (own !== null) results.push({ externalSku: p.sku, ok: true });
        continue;
      }
      try {
        await paribelleCall("PATCH", `/products/${p.id}`, {
          body: patch.length ? { productVariants: patch } : { stockQuantity: own },
          retry: true,
        });
        for (const sku of skus) results.push({ externalSku: sku, ok: true });
        if (own !== null) results.push({ externalSku: p.sku, ok: true });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        for (const sku of skus) results.push({ externalSku: sku, ok: false, error });
        if (own !== null) results.push({ externalSku: p.sku, ok: false, error });
      }
    }
    for (const u of updates) {
      if (!seen.has(u.externalSku.trim().toLowerCase())) results.push({ externalSku: u.externalSku, ok: false, error: "paribelle.in has no product or variant with this SKU" });
    }
    return results;
  }

  /** The account this adapter serves (for the label and write-back helpers). */
  get accountId() {
    return this.account.id;
  }
}
