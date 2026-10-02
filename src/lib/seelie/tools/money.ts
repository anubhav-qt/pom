import "server-only";

import { Type } from "@paribelle/pi-ai";

import { db } from "@/db";
import { orderFinance } from "@/db/schema";
import { getLedgerRows, getProductLedger } from "@/lib/finance-queries";
import { getProfitData } from "@/lib/profit";
import { isFinanceChannel, marketplacesOf, type FinanceChannel } from "@/app/(app)/dashboard/channels";
import { isBasis, type Basis } from "@/app/(app)/dashboard/range";

import { defineTool, ToolError } from "./types";
import { ist, istDay, nextDay, OrderRefs, plural, resolveOrders, todayIst, StringEnum } from "./util";

/** [from, to) from YYYY-MM-DD days (to inclusive), a month (YYYY-MM) or "7d"/"30d"/"90d"/"all". */
function period(a: { from?: string; to?: string; range?: string }) {
  if (a.range) {
    const r = a.range.trim();
    if (r === "all") return { from: new Date("2000-01-01"), to: new Date(Date.now() + 86_400_000), label: "all time" };
    const days = /^(\d+)d$/.exec(r);
    if (days) return { from: new Date(Date.now() - Number(days[1]) * 86_400_000), to: new Date(Date.now() + 86_400_000), label: `last ${days[1]} days` };
    const month = /^(\d{4})-(\d{2})$/.exec(r);
    if (month) {
      const y = Number(month[1]);
      const m = Number(month[2]);
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
      return { from: new Date(`${r}-01T00:00:00+05:30`), to: new Date(`${next}-01T00:00:00+05:30`), label: r };
    }
    throw new ToolError(`range is "7d", "30d", "90d", "all" or a month like 2026-09, not "${r}".`);
  }
  const from = istDay(a.from ?? "2000-01-01", "from");
  const to = nextDay(istDay(a.to ?? todayIst(), "to"));
  if (to <= from) throw new ToolError("`to` is before `from`.");
  return { from, to, label: `${a.from ?? "start"} to ${a.to ?? "today"}` };
}

const round = (v: number | null | undefined) => (v === null || v === undefined ? v : Math.round(v * 100) / 100);

export const finance = defineTool({
  name: "finance",
  label: "Finance",
  description: [
    "Money, as the Finance screen works it out from the marketplace's own payments and our cost prices.",
    "overview: profit for a period (orders placed and what became of them, return/RTO/cancel rates, kept sales, margin, money in and out,",
    "per-order economics, tax, products missing a cost) plus the money with the marketplace today (paid, next payout, held, owed).",
    "orders: the ledger, one row per order (net, fees, postage, refunded, held, cost, profit, status, note). products: one row per design",
    "(units, net, cost, profit) where cost prices are set. months: profit month by month.",
    "Period: `range` (7d, 30d, 90d, all, or a month 2026-09) or from/to days. basis: paid (money by the day it moved, default) or ordered.",
  ].join(" "),
  parameters: Type.Object({
    view: StringEnum(["overview", "orders", "products", "months"]),
    range: Type.Optional(Type.String()),
    from: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
    to: Type.Optional(Type.String({ description: "YYYY-MM-DD, inclusive" })),
    basis: Type.Optional(StringEnum(["paid", "ordered"])),
    channel: Type.Optional(Type.String({ description: "all (default), amazon, flipkart or meesho." })),
    status: Type.Optional(Type.String({ description: "orders: delivered, returned, rto, cancelled, shipped or in_progress." })),
    query: Type.Optional(Type.String({ description: "orders/products: filter by order id, item or SKU." })),
    sort: Type.Optional(StringEnum(["profit", "loss", "net", "date"])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000, description: "Rows for orders/products (default 100)." })),
  }),
  kind: "read",
  summary: (a) => `${a.view} · ${a.range ?? `${a.from ?? "start"} → ${a.to ?? "today"}`}${a.channel && a.channel !== "all" ? ` · ${a.channel}` : ""}`,
  async execute(a) {
    const { from, to, label } = period(a);
    const channel: FinanceChannel = isFinanceChannel(a.channel) ? a.channel : "all";
    const basis: Basis = isBasis(a.basis) ? a.basis : "paid";
    const limit = a.limit ?? 100;
    const q = a.query?.trim().toLowerCase();

    if (a.view === "overview" || a.view === "months") {
      const data = await getProfitData(from, to, channel);
      if (a.view === "months") return { data: { period: label, channel, months: data.view.months } };
      const { months: _m, products, ...view } = data.view;
      return {
        data: {
          period: label,
          channel,
          financeLines: data.lineCount,
          ...view,
          topProducts: products.slice(0, 15),
          moneyToday: { ...data.money, lastPayoutAt: ist(data.money.lastPayoutAt) },
        },
      };
    }

    if (a.view === "products") {
      let rows = await getProductLedger(from, to, basis, marketplacesOf(channel));
      if (q) rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.skus.some((s) => s.toLowerCase().includes(q)));
      if (a.sort === "loss") rows.sort((x, y) => (x.profit ?? 0) - (y.profit ?? 0));
      else if (a.sort === "net") rows.sort((x, y) => y.net - x.net);
      else rows.sort((x, y) => (y.profit ?? -Infinity) - (x.profit ?? -Infinity));
      return {
        data: {
          period: label,
          basis,
          count: rows.length,
          noCost: rows.filter((r) => r.cost === null).length,
          products: rows.slice(0, limit).map((r) => ({
            key: r.key,
            name: r.name,
            skus: r.skus.length > 6 ? [...r.skus.slice(0, 6), `+${r.skus.length - 6} more`] : r.skus,
            units: r.units,
            net: round(r.net),
            cost: r.cost,
            costTotal: round(r.costTotal),
            profit: round(r.profit),
          })),
        },
      };
    }

    let rows = await getLedgerRows(from, to, basis, marketplacesOf(channel));
    if (a.status) rows = rows.filter((r) => r.status === a.status);
    if (q) rows = rows.filter((r) => r.externalOrderId.toLowerCase().includes(q) || r.item.toLowerCase().includes(q));
    if (a.sort === "profit") rows.sort((x, y) => (y.profit ?? -Infinity) - (x.profit ?? -Infinity));
    else if (a.sort === "loss") rows.sort((x, y) => (x.profit ?? Infinity) - (y.profit ?? Infinity));
    else if (a.sort === "net") rows.sort((x, y) => y.net - x.net);
    const sum = (f: (r: (typeof rows)[number]) => number | null) => round(rows.reduce((s, r) => s + (f(r) ?? 0), 0));
    return {
      data: {
        period: label,
        basis,
        count: rows.length,
        totals: { net: sum((r) => r.net), fees: sum((r) => r.fees), postage: sum((r) => r.postage), refunded: sum((r) => r.refunded), held: sum((r) => r.held), cost: sum((r) => r.cost), profit: sum((r) => r.profit) },
        orders: rows.slice(0, limit).map((r) => ({
          id: r.orderId,
          orderId: r.externalOrderId,
          ordered: ist(r.orderedAt),
          item: r.item,
          items: r.itemCount,
          status: r.status,
          net: round(r.net),
          fees: round(r.fees),
          postage: round(r.postage),
          refunded: round(r.refunded),
          held: round(r.held),
          cost: round(r.cost),
          profit: round(r.profit),
          ...(r.note ? { note: r.note } : {}),
        })),
      },
    };
  },
});

export const orderNotes = defineTool({
  name: "order_notes",
  label: "Order notes",
  description: "Write the note on orders (the Finance ledger's note column), the same text on each. An empty note clears it.",
  parameters: Type.Object({ orders: OrderRefs, note: Type.String({ maxLength: 500 }) }),
  kind: "write",
  summary: (a) => `${a.note.trim() ? `Note "${a.note.trim().slice(0, 80)}"` : "Clear the note"} on ${plural(a.orders.length, "order")}`,
  async execute(a, ctx) {
    const { ids, missing } = await resolveOrders(a.orders);
    if (missing.length) throw new ToolError(`No such order: ${missing.join(", ")}. Nothing was changed.`);
    const values = { note: a.note.trim().slice(0, 500) || null, updatedBy: ctx.user.id, updatedAt: new Date() };
    for (const orderId of ids) {
      await db.insert(orderFinance).values({ orderId, ...values }).onConflictDoUpdate({ target: orderFinance.orderId, set: values });
    }
    return { text: `Saved on ${plural(ids.length, "order")}.` };
  },
});
