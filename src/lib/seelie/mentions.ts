import "server-only";

import { and, desc, eq, ilike, or } from "drizzle-orm";

import { db } from "@/db";
import { orders, products } from "@/db/schema";

import type { Mention } from "./types";

/**
 * @ in Seelie's box: the owner picks a product or an order, and the message carries it as
 * `@[Blue cotton kurta](product:PB-KU-101)`, so Seelie never has to guess which one.
 */

/** What Seelie is told about picked items. */
export const MENTION_NOTE =
  "@[name](product:SKU) and @[name](order:ID) in a message are a product (by its OMS SKU) or an order (by the marketplace's order id) the owner picked from a list: use that SKU or id as given.";

const ID = /^[^)\s]{1,80}$/;
const label = (s: string) => s.replace(/[[\]()\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
const like = (q: string) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

const CHANNEL: Record<string, string> = { amazon: "Amazon", flipkart: "Flipkart", meesho: "Meesho", paribelle: "paribelle.in" };

export async function findMentions(q: string): Promise<Mention[]> {
  const term = q.trim().slice(0, 60);
  const pattern = like(term);
  const productRows = await db
    .select({ sku: products.sku, name: products.name, image: products.imageUrl })
    .from(products)
    .where(term ? and(eq(products.active, true), or(ilike(products.name, pattern), ilike(products.sku, pattern))) : eq(products.active, true))
    .orderBy(desc(products.createdAt))
    .limit(term ? 6 : 5);
  // Orders only once there's something to match: there are thousands.
  const orderRows =
    term.length >= 3
      ? await db
          .select({ id: orders.externalOrderId, buyer: orders.buyerName, channel: orders.channel, status: orders.status, at: orders.orderedAt, city: orders.shipCity })
          .from(orders)
          .where(or(ilike(orders.externalOrderId, pattern), ilike(orders.buyerName, pattern)))
          .orderBy(desc(orders.orderedAt))
          .limit(4)
      : [];
  const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
  return [
    ...productRows
      .filter((p) => ID.test(p.sku))
      .map((p): Mention => ({ kind: "product", label: label(p.name) || p.sku, sub: p.sku, image: p.image, token: `@[${label(p.name) || p.sku}](product:${p.sku})` })),
    ...orderRows
      .filter((o) => ID.test(o.id))
      .map(
        (o): Mention => ({
          kind: "order",
          label: o.id,
          sub: [CHANNEL[o.channel] ?? o.channel, o.buyer, o.city, day.format(o.at), o.status.replace(/_/g, " ")].filter(Boolean).join(" · "),
          image: null,
          token: `@[${label(o.buyer ? `${o.id} (${o.buyer})` : o.id)}](order:${o.id})`,
        }),
      ),
  ];
}
