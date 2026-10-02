import "server-only";

import { Type } from "@paribelle/pi-ai";
import { eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { orderItems, returns } from "@/db/schema";
import { FEATURES } from "@/config/features";
import { adjustStock } from "@/lib/inventory";
import { getReturnsDesk } from "@/app/(app)/returns/queries";

import { defineTool, ToolError } from "./types";
import { ist, listRefs, OrderRefs, plural, resolveOrders, StringEnum } from "./util";

const STAGES = ["transit", "arrived", "overdue", "done"] as const;

export const returnsDesk = defineTool({
  name: "returns_desk",
  label: "Returns desk",
  description: [
    "Customer returns as the Returns screen shows them, with its KPIs (to do, arrived, overdue and the refund owed on them, refunds/labels/reimbursements in 30 days) and top reasons.",
    "Stages: transit (on its way), arrived (Amazon says delivered back, waiting for our check-in), overdue (14+ days, not arrived), done (checked in or closed).",
    "Filter by stage, text (order id, item, reason, AWB) or date. RTOs and cancellations are under `cancellations`.",
  ].join(" "),
  parameters: Type.Object({
    stages: Type.Optional(Type.Array(StringEnum(STAGES))),
    query: Type.Optional(Type.String()),
    requestedFrom: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Rows (default 60). KPIs always cover everything." })),
  }),
  kind: "read",
  enabled: () => FEATURES.returns,
  summary: (a) => [a.stages?.join("/"), a.query && `"${a.query}"`].filter(Boolean).join(" · ") || "Everything",
  async execute(a) {
    const desk = await getReturnsDesk();
    const q = a.query?.trim().toLowerCase();
    const from = a.requestedFrom ? new Date(`${a.requestedFrom}T00:00:00+05:30`).getTime() : null;
    const rows = desk.rows.filter(
      (r) =>
        (!a.stages?.length || (a.stages as string[]).includes(r.stage)) &&
        (!q || [r.externalOrderId, r.item, r.reason, r.awb, r.note].some((v) => v?.toLowerCase().includes(q))) &&
        (from === null || (r.requestedAt !== null && new Date(r.requestedAt).getTime() >= from)),
    );
    const limit = a.limit ?? 60;
    return {
      data: {
        kpis: desk.kpis,
        topReasons60Days: desk.reasons,
        matched: rows.length,
        rows: rows.slice(0, limit).map((r) => ({
          returnId: r.id,
          orderId: r.externalOrderId,
          id: r.orderId,
          item: r.item,
          reason: r.reason,
          stage: r.stage,
          ageDays: r.ageDays,
          requested: ist(r.requestedAt),
          arrived: ist(r.arrivedAt),
          received: ist(r.receivedAt),
          refund: r.refundAmount,
          orderNet: r.orderNet,
          labelCost: r.labelCost,
          labelPaidBy: r.labelPaidBy,
          resolution: r.resolution,
          carrier: r.carrier,
          awb: r.awb,
          restocked: r.restocked,
          outcome: r.outcome,
          note: r.note,
        })),
      },
    };
  },
});

export const returnsUpdate = defineTool({
  name: "returns_update",
  label: "Check in returns",
  description: [
    "Act on customer returns. receive: check the parcel in; restock=true puts its items back in stock (only when they're sellable), else it's recorded damaged.",
    "close: settle a return that won't be checked in, as written_off (never came back) or claim_raised (taken up with Amazon); no stock moves.",
    "reopen: undo a close (a check-in can't be undone: it moved stock). Name returns by returnId or by order.",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["receive", "close", "reopen"]),
    returnIds: Type.Optional(Type.Array(Type.Integer())),
    orders: Type.Optional(OrderRefs),
    restock: Type.Optional(Type.Boolean({ description: "receive: put the items back in sellable stock." })),
    outcome: Type.Optional(StringEnum(["written_off", "claim_raised"])),
    note: Type.Optional(Type.String({ description: "The parcel's condition, or why it was closed." })),
  }),
  kind: "write",
  enabled: () => FEATURES.returns,
  summary: (a) => {
    const what = [...(a.returnIds ?? []).map((r) => `return ${r}`), ...(a.orders ?? [])];
    if (a.action === "receive") return `Check in ${listRefs(what)}, ${a.restock ? "back into stock" : "not restocked (damaged)"}`;
    if (a.action === "close") return `Close ${listRefs(what)} as ${a.outcome === "claim_raised" ? "claim raised" : "written off"}`;
    return `Reopen ${listRefs(what)}`;
  },
  async execute(a, ctx) {
    const ids = new Set(a.returnIds ?? []);
    if (a.orders?.length) {
      const { ids: orderIds, missing } = await resolveOrders(a.orders);
      if (missing.length) throw new ToolError(`No such order: ${missing.join(", ")}.`);
      const found = await db.select({ id: returns.id }).from(returns).where(inArray(returns.orderId, orderIds));
      if (found.length === 0) throw new ToolError("Those orders have no returns.");
      for (const r of found) ids.add(r.id);
    }
    if (ids.size === 0) throw new ToolError("Name the returns (returnIds or orders).");
    if (a.action === "receive" && a.restock === undefined) throw new ToolError("Say whether to restock (restock true/false).");
    if (a.action === "close" && !a.outcome) throw new ToolError("Say how it closes (outcome).");

    const rows = await db.select().from(returns).where(inArray(returns.id, [...ids]));
    const done: number[] = [];
    const refused: { returnId: number; why: string }[] = [];
    for (const row of rows) {
      if (row.receivedAt) {
        refused.push({ returnId: row.id, why: a.action === "reopen" ? "checked in; can't be reopened" : "already checked in" });
        continue;
      }
      if (a.action === "receive") {
        await db
          .update(returns)
          .set({
            receivedAt: new Date(),
            receivedBy: ctx.user.id,
            restocked: a.restock!,
            outcome: a.restock ? "reshelved" : "damaged",
            conditionNote: a.note?.trim() || null,
          })
          .where(eq(returns.id, row.id));
        if (a.restock && row.orderId) {
          const items = await db
            .select({ productId: orderItems.productId, quantity: orderItems.quantity })
            .from(orderItems)
            .where(eq(orderItems.orderId, row.orderId));
          for (const item of items) {
            if (item.productId === null) continue;
            await adjustStock({
              productId: item.productId,
              delta: item.quantity,
              reason: "return_received",
              refType: "return",
              refId: row.id,
              userId: ctx.user.id,
              note: a.note?.trim() || "Restocked from return",
            });
          }
        }
      } else if (a.action === "close") {
        await db
          .update(returns)
          .set({ outcome: a.outcome!, conditionNote: a.note?.trim() || row.conditionNote })
          .where(eq(returns.id, row.id));
      } else {
        await db.update(returns).set({ outcome: null }).where(eq(returns.id, row.id));
      }
      done.push(row.id);
    }
    const notFound = [...ids].filter((id) => !rows.some((r) => r.id === id));
    return {
      text: `${plural(done.length, "return")} ${a.action === "receive" ? "checked in" : a.action === "close" ? "closed" : "reopened"}.`,
      data: { done, refused, notFound },
    };
  },
});
