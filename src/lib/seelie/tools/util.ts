import "server-only";

import { Type, type TSchema } from "@paribelle/pi-ai";
import { inArray, or } from "drizzle-orm";

import { db } from "@/db";
import { channelAccounts, orders, type ChannelAccount } from "@/db/schema";
import { isChannelEnabled } from "@/config/features";

import { ToolError } from "./types";

/**
 * One of a few strings, as a plain `{ type: "string", enum }`: every model API takes
 * that, where a union of literals (anyOf of consts) trips some of them up.
 */
export function StringEnum<const T extends readonly string[]>(values: T, options: { description?: string } = {}) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}

/** An order as people say it: our id (a number) or the marketplace's order id. */
export const OrderRef = Type.Union([Type.Integer(), Type.String()], {
  description: "Our order id (number) or the marketplace order id (e.g. 405-1234567-1234567).",
});

export const OrderRefs = Type.Array(OrderRef, { minItems: 1, maxItems: 500 });

/** Our ids for orders named either way, and the refs that matched nothing. */
export async function resolveOrders(refs: (number | string)[]) {
  const ids = refs.filter((r): r is number => typeof r === "number" || /^\d{1,9}$/.test(String(r))).map(Number);
  const external = refs.filter((r) => typeof r === "string" && !/^\d{1,9}$/.test(r)).map((r) => String(r).trim());
  if (ids.length === 0 && external.length === 0) return { ids: [] as number[], missing: [] as string[] };
  const rows = await db
    .select({ id: orders.id, externalOrderId: orders.externalOrderId })
    .from(orders)
    .where(
      or(
        ids.length ? inArray(orders.id, ids) : undefined,
        external.length ? inArray(orders.externalOrderId, external) : undefined,
      ),
    );
  const foundIds = new Set(rows.map((r) => r.id));
  const foundExt = new Set(rows.map((r) => r.externalOrderId));
  const missing = [
    ...ids.filter((id) => !foundIds.has(id) && !foundExt.has(String(id))).map(String),
    ...external.filter((e) => !foundExt.has(e)),
  ];
  return { ids: [...foundIds], missing };
}

/** A calendar day in India time (YYYY-MM-DD) as the instant it starts. */
export function istDay(day: string, field = "date"): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new ToolError(`${field} must be YYYY-MM-DD.`);
  const d = new Date(`${day}T00:00:00+05:30`);
  if (Number.isNaN(d.getTime())) throw new ToolError(`${field} isn't a real date.`);
  return d;
}

/** The day after, for an inclusive `to`. */
export function nextDay(d: Date) {
  return new Date(d.getTime() + 86_400_000);
}

/** Today in India, as YYYY-MM-DD. */
export function todayIst() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

export const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const IST = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** A moment as India time, "2026-10-02 14:05", which is how every tool reports times. */
export function ist(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(IST.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

/** Marketplace accounts to act on: the one named, or every active enabled one. */
export async function accountsFor(accountId?: number): Promise<ChannelAccount[]> {
  const all = await db.select().from(channelAccounts);
  if (accountId !== undefined) {
    const account = all.find((a) => a.id === accountId);
    if (!account) throw new ToolError(`No marketplace account ${accountId}. sync_status lists them.`);
    return [account];
  }
  const live = all.filter((a) => a.active && isChannelEnabled(a.channel));
  if (live.length === 0) throw new ToolError("No active marketplace account is connected.");
  return live;
}

export function optional<T extends TSchema>(schema: T) {
  return Type.Optional(schema);
}

/** "3 orders" / "1 order". */
export function plural(n: number, word: string, many = `${word}s`) {
  return `${n} ${n === 1 ? word : many}`;
}

export function listRefs(refs: (number | string)[], max = 4) {
  const shown = refs.slice(0, max).join(", ");
  return refs.length > max ? `${shown} +${refs.length - max} more` : shown;
}
