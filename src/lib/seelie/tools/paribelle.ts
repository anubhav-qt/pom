import "server-only";

import { Type } from "@paribelle/pi-ai";
import { and, eq } from "drizzle-orm";

import { isChannelEnabled } from "@/config/features";
import { db } from "@/db";
import { returns } from "@/db/schema";
import { actOnParibelleExchange, actOnParibelleOrder, type ParibelleExchangeAction, type ParibelleOrderAction } from "@/lib/paribelle";

import { enabled as storeConnected } from "./store";
import { defineTool, ToolError } from "./types";
import { OrderRef, resolveOrders, StringEnum } from "./util";

/**
 * paribelle.in's orders and exchanges moved along from the chat, as the order
 * popup and the Returns desk's Exchanges tab do: the store is changed first (it
 * tells the customer), then the OMS takes its answer. Every call asks.
 */

const ORDER_STEPS = ["confirm", "ship", "deliver", "cancel", "cod_refused"] as const;
const EXCHANGE_STEPS = ["approve", "reject", "inspection_passed", "inspection_failed", "ship_replacement", "create_replacement_order", "settle_credit"] as const;

export const paribelleOrders = defineTool({
  name: "paribelle_orders",
  label: "paribelle.in orders and exchanges",
  description: [
    "Change a paribelle.in order or exchange (read them with the order and returns tools; orders.channel = 'paribelle').",
    "Orders (order = our id or the store's order number): confirm (a placed order), ship (courier + awb; the customer gets the tracking,",
    "the parcel leaves the pack queue and its pieces come off the shelf), deliver, cancel (reason, only before it ships), cod_refused",
    "(a COD parcel refused at the door: decision credit with creditAmount, or nothing; owner only).",
    "Exchanges (exchange = its number, e.g. RET-…): approve, reject (reason), inspection_passed (restock false keeps it off the shelf),",
    "inspection_failed (reason, which rejects it), ship_replacement (the same piece in another size, with awb), create_replacement_order",
    "(a different piece: a new order to pack), settle_credit (store credit instead; owner only). The store's rules decide what's allowed when.",
  ].join(" "),
  parameters: Type.Object({
    step: StringEnum([...ORDER_STEPS, ...EXCHANGE_STEPS]),
    order: Type.Optional(OrderRef),
    exchange: Type.Optional(Type.Union([Type.Integer(), Type.String()], { description: "The exchange's number (RET-…) or our returns id." })),
    courier: Type.Optional(Type.String()),
    awb: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String({ description: "cancel, reject, inspection_failed, cod_refused: the customer sees it." })),
    decision: Type.Optional(StringEnum(["credit", "nothing"])),
    creditAmount: Type.Optional(Type.Number({ minimum: 1 })),
    restock: Type.Optional(Type.Boolean()),
  }),
  kind: "store",
  enabled: () => isChannelEnabled("paribelle") && storeConnected(),
  summary: (a) => {
    const target = a.order != null ? `order ${a.order}` : `exchange ${a.exchange ?? "?"}`;
    switch (a.step) {
      case "confirm":
        return `Confirm paribelle.in ${target}`;
      case "ship":
        return `Mark paribelle.in ${target} shipped with ${a.courier ?? "a courier"} AWB ${a.awb ?? "?"} (the customer is told)`;
      case "deliver":
        return `Mark paribelle.in ${target} delivered`;
      case "cancel":
        return `Cancel paribelle.in ${target}: ${a.reason ?? ""}`;
      case "cod_refused":
        return `Record paribelle.in ${target} refused at the door, ${a.decision === "credit" ? `₹${a.creditAmount ?? "?"} store credit` : "no credit"}`;
      case "approve":
        return `Approve paribelle.in ${target}`;
      case "reject":
        return `Reject paribelle.in ${target}: ${a.reason ?? ""}`;
      case "inspection_passed":
        return `Pass paribelle.in ${target}'s inspection${a.restock === false ? " (not back in stock)" : " and put it back in stock"}`;
      case "inspection_failed":
        return `Fail paribelle.in ${target}'s inspection: ${a.reason ?? ""}`;
      case "ship_replacement":
        return `Send paribelle.in ${target}'s replacement${a.awb ? ` with AWB ${a.awb}` : ""}`;
      case "create_replacement_order":
        return `Make a replacement order for paribelle.in ${target}`;
      case "settle_credit":
        return `Settle paribelle.in ${target} as store credit`;
    }
  },
  async execute(a, ctx) {
    const owner = ctx.user.role === "owner";
    if ((a.step === "cod_refused" || a.step === "settle_credit") && !owner) throw new ToolError("Store credit is the owner's call.");

    if ((ORDER_STEPS as readonly string[]).includes(a.step)) {
      if (a.order == null) throw new ToolError("Which order? Give our id or the store's order number.");
      const { ids, missing } = await resolveOrders([a.order]);
      if (!ids.length) throw new ToolError(`No order ${missing[0] ?? a.order} in the OMS.`);
      let act: ParibelleOrderAction;
      switch (a.step) {
        case "ship":
          if (!a.courier?.trim() || !a.awb?.trim()) throw new ToolError("Shipping needs the courier and the AWB.");
          act = { action: "ship", courier: a.courier, awb: a.awb };
          break;
        case "cancel":
          act = { action: "cancel", reason: a.reason ?? "" };
          break;
        case "cod_refused":
          if (!a.decision) throw new ToolError("Say credit (with creditAmount) or nothing.");
          act = { action: "cod_refused", decision: a.decision, creditAmount: a.creditAmount, reason: a.reason };
          break;
        default:
          act = { action: a.step as "confirm" | "deliver" };
      }
      const fresh = await actOnParibelleOrder(ids[0], act, ctx.user.id).catch((err) => {
        throw new ToolError(err instanceof Error ? err.message : String(err));
      });
      return { text: `Done. paribelle.in has order ${fresh?.orderNumber ?? a.order} as ${fresh?.status ?? "changed"}.` };
    }

    if (a.exchange == null) throw new ToolError("Which exchange? Give its number (RET-…).");
    const ref = String(a.exchange).trim();
    const [row] = await db
      .select({ id: returns.id })
      .from(returns)
      .where(and(eq(returns.channel, "paribelle"), /^\d{1,9}$/.test(ref) ? eq(returns.id, Number(ref)) : eq(returns.externalReturnId, ref)))
      .limit(1);
    if (!row) throw new ToolError(`No paribelle.in exchange ${ref} in the OMS. Sync paribelle.in if it's new.`);
    let act: ParibelleExchangeAction;
    switch (a.step) {
      case "reject":
        act = { action: "reject", reason: a.reason ?? "" };
        break;
      case "inspection_passed":
        act = { action: "inspection", result: "passed", restock: a.restock !== false };
        break;
      case "inspection_failed":
        if (!a.reason?.trim()) throw new ToolError("Say what's wrong with it; the customer sees this.");
        act = { action: "inspection", result: "failed", notes: a.reason };
        break;
      case "ship_replacement":
        act = { action: "ship_replacement", awb: a.awb };
        break;
      default:
        act = { action: a.step as "approve" | "create_replacement_order" | "settle_credit" };
    }
    await actOnParibelleExchange(row.id, act, ctx.user.id).catch((err) => {
      throw new ToolError(err instanceof Error ? err.message : String(err));
    });
    const [after] = await db.select({ status: returns.status }).from(returns).where(eq(returns.id, row.id)).limit(1);
    return { text: `Done. Exchange ${ref} is now ${after?.status ?? "updated"} on paribelle.in.` };
  },
});
