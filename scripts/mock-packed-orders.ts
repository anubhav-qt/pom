import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { sql } from "drizzle-orm";
import { db } from "../src/db";

/**
 * Seed/prune a handful of fake "packed, unmapped AWB" orders for UI testing
 * of the outbound Scan modal's AWB mapper, since the real DB currently has
 * none in that state. Everything it writes is tagged `MOCK-PACKED-%` so it
 * can be found and removed on its own without touching real orders.
 *
 * Usage:
 *   npx tsx scripts/mock-packed-orders.ts seed
 *   npx tsx scripts/mock-packed-orders.ts prune
 */

function rows<T = any>(res: any): T[] {
  return Array.isArray(res) ? res : (res?.rows ?? []);
}

const N = 4;
const externalId = (n: number) => `MOCK-PACKED-${String(n).padStart(3, "0")}`;
const CITIES = [
  ["Mumbai", "MH"],
  ["Bengaluru", "KA"],
  ["Delhi", "DL"],
  ["Chennai", "TN"],
];

async function seed() {
  const [account] = rows(
    await db.execute(
      sql`SELECT id FROM channel_accounts WHERE channel = 'amazon' AND active LIMIT 1`,
    ),
  );
  if (!account) throw new Error("No active amazon channel_accounts row found — cannot seed.");

  for (let n = 1; n <= N; n++) {
    const eid = externalId(n);
    const existing = rows(
      await db.execute(sql`SELECT id FROM orders WHERE external_order_id = ${eid} LIMIT 1`),
    )[0];
    if (existing) {
      console.log(`skip ${eid} (already exists, id=${existing.id})`);
      continue;
    }

    const [city, state] = CITIES[n - 1];
    const [order] = rows(
      await db.execute(sql`
        INSERT INTO orders (
          channel_account_id, channel, external_order_id, status, ordered_at,
          buyer_name, ship_city, ship_state, is_cod, dispatch_by
        ) VALUES (
          ${account.id}, 'amazon', ${eid}, 'ready_to_pack', now(),
          ${`Mock Buyer ${n}`}, ${city}, ${state}, false, now() + interval '1 day'
        )
        RETURNING id
      `),
    );

    await db.execute(sql`
      INSERT INTO order_items (order_id, external_sku, title, quantity, product_id)
      VALUES (${order.id}, ${`MOCK-SKU-${n}`}, ${`Mock item ${n}`}, 1, NULL)
    `);

    await db.execute(sql`
      INSERT INTO order_fulfilment (order_id, state, packed_at)
      VALUES (${order.id}, 'packed', now())
    `);

    if (n === 4) {
      await db.execute(sql`
        INSERT INTO shipments (order_id, awb, packed_at)
        VALUES (${order.id}, 'MOCK-AWB-004', now())
      `);
    }

    console.log(`seeded ${eid} (order id=${order.id})${n === 4 ? " + shipment awb MOCK-AWB-004" : ""}`);
  }
}

async function prune() {
  const orderIds = rows(
    await db.execute(sql`SELECT id FROM orders WHERE external_order_id LIKE 'MOCK-PACKED-%'`),
  ).map((r) => r.id);

  if (orderIds.length === 0) {
    console.log("Nothing to prune.");
    return;
  }

  const del = async (label: string, query: any) => {
    const res: any = await db.execute(query);
    const n = res.rowCount ?? (Array.isArray(res) ? res.length : 0);
    console.log(`deleted ${n} from ${label}`);
  };

  await del(
    "parcel_scans",
    sql`DELETE FROM parcel_scans WHERE order_id = ANY(${orderIds})`,
  );
  await del(
    "inventory_ledger (order ref)",
    sql`DELETE FROM inventory_ledger WHERE ref_type = 'order' AND ref_id = ANY(${orderIds})`,
  );
  await del("shipments", sql`DELETE FROM shipments WHERE order_id = ANY(${orderIds})`);
  await del(
    "order_fulfilment",
    sql`DELETE FROM order_fulfilment WHERE order_id = ANY(${orderIds})`,
  );
  await del("order_items", sql`DELETE FROM order_items WHERE order_id = ANY(${orderIds})`);
  await del(
    "orders",
    sql`DELETE FROM orders WHERE external_order_id LIKE 'MOCK-PACKED-%'`,
  );
}

async function main() {
  const mode = process.argv[2];
  if (mode === "seed") await seed();
  else if (mode === "prune") await prune();
  else {
    console.error("Usage: npx tsx scripts/mock-packed-orders.ts <seed|prune>");
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
