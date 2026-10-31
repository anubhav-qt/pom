import "server-only";

import { and, eq, inArray, isNull, lt, lte, notExists, or, sql } from "drizzle-orm";

import type { ParibelleRaw } from "@/channels/paribelle";
import { db } from "@/db";
import { logixmitraShipments, orders, shipments, type LogixmitraShipment } from "@/db/schema";
import { actOnParibelleOrder } from "@/lib/paribelle";

import { logixmitraAccount, LogixmitraError, logixmitraFetch } from "./client";

/**
 * Every new paribelle.in order goes to Logixmitra by itself, with nobody pressing
 * anything: the sync's cron run (every 10 minutes on the ThinkPad) pushes it,
 * books the cheapest courier that serves the pincode (COD with the amount to
 * collect), and keeps the courier and AWB on the order so its label carries them.
 *
 * From then on the parcel is followed by its AWB about once an hour. When the
 * courier picks it up the store is told it shipped (the customer gets the AWB,
 * the order leaves the pack queue); when it's delivered, delivered. A parcel
 * coming back (RTO) is only recorded: what the customer gets for a refused COD
 * parcel stays the owner's call. An order cancelled before pickup has its
 * shipment cancelled at Logixmitra.
 *
 * Only orders placed after the Logixmitra login was saved are sent.
 */

/** A piece of clothing, folded and bagged. */
const PIECE_KG = 0.4;
const BOX = { length: 30, width: 25, heightPerPiece: 5, maxHeight: 25 };
/** How long one run may hold an order before another may try it. */
const LOCK_MS = 10 * 60_000;
const TRACK_EVERY_MS = 55 * 60_000;
const OPEN: ("new" | "ready_to_pack" | "packed")[] = ["new", "ready_to_pack", "packed"];

export interface LogixmitraRun {
  skipped?: string;
  queued: number;
  booked: number;
  failed: number;
  cancelled: number;
  tracked: number;
  errors: string[];
}

/** The cron's pass. Never throws: failures are kept on each order and listed in the answer. */
export async function runLogixmitra(): Promise<LogixmitraRun> {
  const out: LogixmitraRun = { queued: 0, booked: 0, failed: 0, cancelled: 0, tracked: 0, errors: [] };
  const account = await logixmitraAccount().catch(() => null);
  if (!account) return { ...out, skipped: "Logixmitra isn't connected" };
  try {
    out.queued = await queueNewOrders(account.since);
    await cancelDropped(account.sellerId, out);
    await bookDue(account.sellerId, out);
    await trackDue(out);
  } catch (err) {
    out.errors.push(err instanceof Error ? err.message : String(err));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Queueing and booking                                                       */
/* -------------------------------------------------------------------------- */

/** Open paribelle.in orders placed since the login was saved, not yet sent and not shipped by hand. */
async function queueNewOrders(since: Date) {
  const fresh = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.channel, "paribelle"),
        inArray(orders.status, OPEN),
        sql`${orders.orderedAt} >= ${since}`,
        sql`coalesce(${orders.raw}->>'trackingNumber', '') = ''`,
        notExists(db.select({ one: sql`1` }).from(logixmitraShipments).where(eq(logixmitraShipments.orderId, orders.id))),
      ),
    );
  if (!fresh.length) return 0;
  const rows = await db
    .insert(logixmitraShipments)
    .values(fresh.map((o) => ({ orderId: o.id })))
    .onConflictDoNothing()
    .returning({ orderId: logixmitraShipments.orderId });
  return rows.length;
}

/** Takes the row for this run, or null when another run has it. */
async function claim(orderId: number) {
  const [row] = await db
    .update(logixmitraShipments)
    .set({ lockedUntil: new Date(Date.now() + LOCK_MS) })
    .where(
      and(
        eq(logixmitraShipments.orderId, orderId),
        or(isNull(logixmitraShipments.lockedUntil), lt(logixmitraShipments.lockedUntil, new Date())),
      ),
    )
    .returning();
  return row ?? null;
}

async function save(orderId: number, values: Partial<LogixmitraShipment>) {
  await db
    .update(logixmitraShipments)
    .set({ ...values, lockedUntil: null, updatedAt: new Date() })
    .where(eq(logixmitraShipments.orderId, orderId));
}

/** Backs off 15 minutes per failed try, up to six hours. */
async function failed(row: LogixmitraShipment, err: unknown, out: LogixmitraRun, extra: Partial<LogixmitraShipment> = {}) {
  const message = err instanceof Error ? err.message : String(err);
  const attempts = row.attempts + 1;
  await save(row.orderId, {
    ...extra,
    error: message.slice(0, 1000),
    attempts,
    nextTryAt: new Date(Date.now() + Math.min(attempts * 15, 360) * 60_000),
  });
  out.failed++;
  out.errors.push(`order ${row.orderId}: ${message}`);
}

async function bookDue(sellerId: number, out: LogixmitraRun) {
  const due = await db
    .select({ orderId: logixmitraShipments.orderId })
    .from(logixmitraShipments)
    .where(
      and(
        inArray(logixmitraShipments.state, ["new", "pushed"]),
        or(isNull(logixmitraShipments.nextTryAt), lte(logixmitraShipments.nextTryAt, new Date())),
      ),
    )
    .limit(25);
  for (const { orderId } of due) {
    const row = await claim(orderId);
    if (!row) continue;
    const [order] = await db.select({ status: orders.status, orderedAt: orders.orderedAt, raw: orders.raw }).from(orders).where(eq(orders.id, orderId)).limit(1);
    const raw = order?.raw as ParibelleRaw | null;
    if (!order || !raw?.id || !OPEN.includes(order.status as (typeof OPEN)[number]) || raw.trackingNumber) {
      // Cancelled, or shipped by hand meanwhile: nothing to book. A pushed order is withdrawn.
      if (row.lmOrderId) await logixmitraFetch("PATCH", `orders/${row.lmOrderId}/status`, { status: "Cancelled" }).catch(() => null);
      await save(orderId, { state: "cancelled" });
      out.cancelled++;
      continue;
    }

    let pushed = row;
    try {
      if (row.state === "new") {
        const made = await pushOrder(sellerId, order.orderedAt, raw);
        pushed = { ...row, state: "pushed", lmOrderId: made.id, referenceId: made.referenceId, codAmount: codOf(raw) };
        await db
          .update(logixmitraShipments)
          .set({ state: "pushed", lmOrderId: made.id, referenceId: made.referenceId, codAmount: codOf(raw), updatedAt: new Date() })
          .where(eq(logixmitraShipments.orderId, orderId));
        if (made.awb) {
          await booked(orderId, made.courier, made.awb, null);
          out.booked++;
          continue;
        }
      }
      const ship = await bookCheapest(sellerId, pushed, raw);
      await booked(orderId, ship.courier, ship.awb, ship.rate);
      out.booked++;
    } catch (err) {
      await failed(pushed, err, out, { state: pushed.state, lmOrderId: pushed.lmOrderId, referenceId: pushed.referenceId, codAmount: pushed.codAmount });
    }
  }
}

/** Booked: kept here and as the order's shipment, so the label, the scan bench and the popup show it. */
async function booked(orderId: number, courier: string | null, awb: string, rate: number | null) {
  await save(orderId, {
    state: "booked",
    courier,
    awb,
    rate: rate === null ? null : rate.toFixed(2),
    bookedAt: new Date(),
    error: null,
    nextTryAt: null,
  });
  const [existing] = await db.select({ id: shipments.id }).from(shipments).where(eq(shipments.orderId, orderId)).limit(1);
  if (existing) await db.update(shipments).set({ courier, awb }).where(eq(shipments.id, existing.id));
  else await db.insert(shipments).values({ orderId, courier, awb });
}

const isCod = (raw: ParibelleRaw) => (raw.paymentMethod ?? "").toLowerCase() === "cod";
const codOf = (raw: ParibelleRaw) => (isCod(raw) ? (raw.total ?? 0).toFixed(2) : "0.00");
const phoneOf = (s: string | null | undefined) => (s ?? "").replace(/\D/g, "").slice(-10);
const dayOf = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

export function parcelOf(raw: ParibelleRaw) {
  const pieces = Math.max(1, raw.items.reduce((n, it) => n + (it.quantity || 0), 0));
  return {
    pieces,
    weight: Math.max(0.5, Math.round(pieces * PIECE_KG * 100) / 100),
    dimensions: { length: BOX.length, width: BOX.width, height: Math.min(BOX.maxHeight, BOX.heightPerPiece * pieces) },
  };
}

/** The order as Logixmitra's push takes it. */
export function pushBody(sellerId: number, orderedAt: Date, raw: ParibelleRaw) {
  const a = raw.address;
  const missing = [
    !a.name && "name",
    phoneOf(a.phone).length !== 10 && "a 10-digit phone",
    !a.line && "address",
    !/^\d{6}$/.test(a.pincode ?? "") && "a 6-digit pincode",
    !a.city && "city",
    !a.state && "state",
  ].filter(Boolean);
  if (missing.length) throw new LogixmitraError(`The order's address has no ${missing.join(", ")}; ship it by hand.`);
  const cod = isCod(raw);
  const total = raw.total ?? 0;
  return {
    referenceId: raw.orderNumber,
    orderNumber: raw.orderNumber,
    orderDate: dayOf(orderedAt),
    customerName: a.name,
    customerPhone: phoneOf(a.phone),
    addressLine1: a.line,
    pincode: a.pincode,
    city: a.city,
    state: a.state,
    paymentGateway: cod ? "COD" : "Prepaid",
    financialStatus: cod ? "pending" : "paid",
    totalOutstanding: cod ? total : 0,
    amount: String(total),
    totalShippingPrice: raw.shippingCost ?? 0,
    currency: "INR",
    platform: "Custom",
    user_id: sellerId,
    items: raw.items.map((it) => ({
      name: [it.name, it.attributes ? Object.values(it.attributes).join(" / ") : ""].filter(Boolean).join(" - "),
      sku: it.sku,
      quantity: it.quantity,
      unitPrice: it.price ?? 0,
      gstRate: (it.price ?? 0) > 2500 ? 18 : 5,
      deadWeight: PIECE_KG,
      length: BOX.length,
      width: BOX.width,
      height: BOX.heightPerPiece,
    })),
  };
}

interface LmOrder {
  id: string;
  orderNumber?: string;
  referenceId?: string;
  awb?: string | null;
  courier?: string | null;
  [k: string]: unknown;
}

const realAwb = (awb: unknown) => (typeof awb === "string" && awb.trim() && awb.trim() !== "-" ? awb.trim() : null);
const realCourier = (c: unknown) => (typeof c === "string" && c.trim() && c.trim() !== "-" && c !== "Auto Assign" ? c.trim() : null);

async function pushOrder(sellerId: number, orderedAt: Date, raw: ParibelleRaw) {
  const body = pushBody(sellerId, orderedAt, raw);
  let made: LmOrder | null = null;
  try {
    const res = await logixmitraFetch<{ data?: LmOrder | LmOrder[]; failedOrders?: { error?: string; message?: string }[]; message?: string }>(
      "POST",
      "auth/manualcreateOrder",
      { data: [body], user_id: sellerId },
    );
    made = (Array.isArray(res?.data) ? res.data[0] : res?.data) ?? null;
    if (!made?.id) {
      const why = res?.failedOrders?.[0]?.error ?? res?.failedOrders?.[0]?.message ?? res?.message;
      if (!/exist|duplicate/i.test(why ?? "")) throw new LogixmitraError(`Logixmitra didn't take the order${why ? `: ${why}` : ""}.`);
    }
  } catch (err) {
    // Already there (a run that pushed and then failed, or the other database's run): use that one.
    const duplicate = err instanceof LogixmitraError && (err.status === 409 || /exist|duplicate/i.test(err.message));
    if (!duplicate) throw err;
  }
  made ??= await findOrder(sellerId, raw.orderNumber);
  if (!made?.id) throw new LogixmitraError(`Logixmitra says ${raw.orderNumber} exists but doesn't list it.`);
  return { id: made.id, referenceId: made.referenceId ?? raw.orderNumber, awb: realAwb(made.awb), courier: realCourier(made.courier) };
}

async function findOrder(sellerId: number, orderNumber: string): Promise<LmOrder | null> {
  const res = await logixmitraFetch<{ data?: LmOrder[] } | LmOrder[]>("GET", "orders", undefined, { user_id: sellerId, search: orderNumber, paginate: "false" });
  const list = Array.isArray(res) ? res : (res?.data ?? []);
  return list.find((o) => o.orderNumber === orderNumber || o.referenceId === orderNumber) ?? null;
}

async function getOrder(id: string): Promise<LmOrder> {
  const res = await logixmitraFetch<{ data?: LmOrder } & LmOrder>("GET", `orders/${id}`);
  const o = (res?.data ?? res) as LmOrder;
  if (!o?.id) throw new LogixmitraError(`Logixmitra has no order ${id}.`);
  return o;
}

/* Warehouses: the pickup address, read once an hour. */
interface Warehouse {
  id: number;
  pincode: string;
  user_id?: number | null;
  isActive?: boolean;
  isDefault?: boolean;
}
let warehouse: { at: number; value: Warehouse } | null = null;

async function pickup(sellerId: number): Promise<Warehouse> {
  if (warehouse && warehouse.at > Date.now() - 3_600_000) return warehouse.value;
  const res = await logixmitraFetch<{ data?: Warehouse[] } | Warehouse[]>("GET", "auth/getAllWarehouses");
  const all = (Array.isArray(res) ? res : (res?.data ?? [])).filter((w) => w.user_id == null || w.user_id === sellerId);
  const active = all.filter((w) => w.isActive !== false);
  const value = active.find((w) => w.isDefault) ?? active[0];
  if (!value) throw new LogixmitraError("Logixmitra has no pickup warehouse for PariBelle. Add one in the Logixmitra panel.");
  warehouse = { at: Date.now(), value };
  return value;
}

/** The cheapest courier that will take the parcel, from Logixmitra's live rates. */
export function cheapest(rates: { type?: string; rates?: number | string }[]) {
  let best: { courier: string; rate: number } | null = null;
  for (const r of rates) {
    const rate = Number(r.rates);
    if (!r.type || !Number.isFinite(rate) || rate <= 0) continue;
    if (!best || rate < best.rate) best = { courier: r.type, rate };
  }
  return best;
}

/** The AWB in a booking's answer, e.g. "WEB-1->Shipment created successfully (Delhivery AWB: DL1234)". */
export function awbFromMessage(message: string | undefined | null) {
  const m = /\(([^()]*?)\s*AWB\s*[:#-]?\s*([A-Za-z0-9-]{6,})\s*\)/i.exec(message ?? "") ?? /AWB\s*[:#-]?\s*([A-Za-z0-9-]{6,})/i.exec(message ?? "");
  if (!m) return null;
  return m.length === 3 ? { courier: m[1].trim() || null, awb: m[2] } : { courier: null, awb: m[1] };
}

async function bookCheapest(sellerId: number, row: LogixmitraShipment, raw: ParibelleRaw) {
  if (!row.lmOrderId || !row.referenceId) throw new LogixmitraError("The order isn't in Logixmitra yet.");
  const from = await pickup(sellerId);
  const parcel = parcelOf(raw);
  const cod = isCod(raw);
  const quote = await logixmitraFetch<{ success?: boolean; message?: string; data?: { type?: string; rates?: number }[] }>("POST", "integrations/ratecalculate", {
    shipmentType: "FORWARD",
    packageType: "SPS",
    originPincode: from.pincode,
    deliveryPincode: raw.address.pincode,
    paymentMode: cod ? "COD" : "PREPAID",
    weight: parcel.weight,
    invoiceValue: raw.total ?? 0,
    dimensions: parcel.dimensions,
    serviceType: "domestic",
  });
  const pick = cheapest(quote?.data ?? []);
  if (!pick) throw new LogixmitraError(`No courier on Logixmitra serves PIN ${raw.address.pincode}${cod ? " for COD" : ""}${quote?.message ? ` (${quote.message})` : ""}.`);

  const order = await getOrder(row.lmOrderId);
  const already = realAwb(order.awb);
  if (already) return { courier: realCourier(order.courier) ?? pick.courier, awb: already, rate: null };

  const ref = order.referenceId ?? row.referenceId;
  const res = await logixmitraFetch<{ status?: boolean; message?: string; createshipment?: { message?: string }[] }>("PUT", "orders/bulkshipmentcreate", {
    user_id: sellerId,
    data: {
      orderlist: [{ ...order, seller: sellerId, platform: order.platform ?? "Custom", amount: order.amount ?? String(raw.total ?? 0) }],
      coureir: [0],
      ratelist: { [ref]: { rate: [pick.rate], type: [pick.courier] } },
      warehouselist: [from.id],
      dispatchdate: { [ref]: dayOf(new Date()) },
      zone: [""],
    },
  });
  const said = res?.createshipment?.[0]?.message ?? res?.message ?? "";
  const got = awbFromMessage(said);
  // The answer's wording isn't a contract: what Logixmitra now holds is.
  const after = await getOrder(row.lmOrderId).catch(() => null);
  const awb = realAwb(after?.awb) ?? got?.awb ?? null;
  if (!awb) throw new LogixmitraError(`Logixmitra didn't book a courier: ${said || "no answer"}`);
  return { courier: realCourier(after?.courier) ?? got?.courier ?? pick.courier, awb, rate: pick.rate };
}

/* -------------------------------------------------------------------------- */
/* Cancelling                                                                 */
/* -------------------------------------------------------------------------- */

/** Orders cancelled before the courier picked them up lose their Logixmitra shipment too. */
async function cancelDropped(sellerId: number, out: LogixmitraRun) {
  const dropped = await db
    .select({ orderId: logixmitraShipments.orderId })
    .from(logixmitraShipments)
    .innerJoin(orders, eq(orders.id, logixmitraShipments.orderId))
    .where(and(inArray(logixmitraShipments.state, ["new", "pushed", "booked"]), isNull(logixmitraShipments.storeState), eq(orders.status, "cancelled")));
  for (const { orderId } of dropped) {
    const row = await claim(orderId);
    if (!row) continue;
    try {
      if (row.state === "booked" && row.referenceId) {
        await logixmitraFetch("PUT", "orders/cancelshipment", { referenceId: row.referenceId, user_id: sellerId });
      } else if (row.lmOrderId) {
        await logixmitraFetch("PATCH", `orders/${row.lmOrderId}/status`, { status: "Cancelled" });
      }
      await save(orderId, { state: "cancelled", error: null });
      out.cancelled++;
    } catch (err) {
      await failed(row, new LogixmitraError(`The order was cancelled but its Logixmitra shipment wasn't: ${err instanceof Error ? err.message : String(err)}`), out);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Tracking                                                                   */
/* -------------------------------------------------------------------------- */

export type Phase = "waiting" | "moving" | "delivered" | "rto" | "returned" | "cancelled";

/** Where the parcel is, in the words the courier and Logixmitra use. */
export function phaseOf(status: string | null | undefined): Phase {
  const s = (status ?? "").toLowerCase();
  if (!s) return "waiting";
  if (/rto|return/.test(s)) return /deliver/.test(s) ? "returned" : "rto";
  if (/cancel/.test(s)) return "cancelled";
  // Not "Shipped": Logixmitra's panel says that once a courier is booked, before any pickup.
  if (/undeliver|out for delivery|transit|picked|dispatched|reached|arrived|ndr/.test(s)) return "moving";
  if (/delivered/.test(s)) return "delivered";
  return "waiting";
}

async function trackDue(out: LogixmitraRun) {
  const due = await db
    .select()
    .from(logixmitraShipments)
    .where(
      and(
        eq(logixmitraShipments.state, "booked"),
        sql`${logixmitraShipments.awb} is not null`,
        or(isNull(logixmitraShipments.trackedAt), lt(logixmitraShipments.trackedAt, new Date(Date.now() - TRACK_EVERY_MS))),
      ),
    )
    .limit(200);
  for (let i = 0; i < due.length; i += 20) {
    const batch = due.slice(i, i + 20);
    let answers: { awbNumber?: string; success?: boolean; status?: string }[] = [];
    try {
      const res = await logixmitraFetch<{ data?: typeof answers }>("POST", "tracking/track/bulk", { awbNumbers: batch.map((r) => r.awb) });
      answers = res?.data ?? [];
    } catch (err) {
      out.errors.push(`tracking: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const row of batch) {
      const a = answers.find((x) => x.awbNumber === row.awb);
      if (!a?.success || !a.status) {
        await db.update(logixmitraShipments).set({ trackedAt: new Date() }).where(eq(logixmitraShipments.orderId, row.orderId));
        continue;
      }
      out.tracked++;
      await follow(row, a.status, out);
    }
  }
}

/** Writes what the courier said back to the store, once per step. */
async function follow(row: LogixmitraShipment, status: string, out: LogixmitraRun) {
  const phase = phaseOf(status);
  const values: Partial<LogixmitraShipment> = { trackingStatus: status, trackedAt: new Date(), updatedAt: new Date() };
  try {
    const [order] = await db.select({ raw: orders.raw }).from(orders).where(eq(orders.id, row.orderId)).limit(1);
    const storeStatus = (order?.raw as ParibelleRaw | null)?.status ?? "";
    const storeShipped = ["shipped", "delivered"].includes(storeStatus);
    let storeState = row.storeState;

    if ((phase === "moving" || phase === "delivered" || phase === "rto" || phase === "returned") && !storeState) {
      if (!storeShipped && storeStatus !== "cancelled") {
        await actOnParibelleOrder(row.orderId, { action: "ship", courier: row.courier ?? "Logixmitra", awb: row.awb! }, null);
      }
      storeState = "shipped";
    }
    if (phase === "delivered" && storeState !== "delivered") {
      if (storeStatus !== "delivered") await actOnParibelleOrder(row.orderId, { action: "deliver" }, null);
      storeState = "delivered";
    }
    values.storeState = storeState;
    values.error = null;
    if (phase === "delivered" || phase === "returned") values.state = "done";
    if (phase === "cancelled") values.state = "cancelled";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    values.error = `Courier says ${status}, but the store wasn't updated: ${message}`.slice(0, 1000);
    out.errors.push(`order ${row.orderId}: ${message}`);
  }
  await db.update(logixmitraShipments).set(values).where(eq(logixmitraShipments.orderId, row.orderId));
}
