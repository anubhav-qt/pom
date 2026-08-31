import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import { sql } from "drizzle-orm";

import { db } from "../src/db";

function rows<T = any>(res: any): T[] {
  return Array.isArray(res) ? res : (res?.rows ?? []);
}

async function main() {
  const range = rows(
    await db.execute(
      sql`SELECT COUNT(*)::int AS n, MIN(ordered_at) AS oldest, MAX(ordered_at) AS newest FROM orders`,
    ),
  )[0];

  const last6 = rows(
    await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM orders WHERE ordered_at >= now() - interval '183 days'`,
    ),
  )[0];

  const byMonth = rows(
    await db.execute(
      sql`SELECT to_char(date_trunc('month', ordered_at), 'YYYY-MM') AS month, COUNT(*)::int AS n
          FROM orders GROUP BY 1 ORDER BY 1`,
    ),
  );

  const runs = rows(
    await db.execute(
      sql`SELECT kind, status, started_at, items_written FROM sync_runs ORDER BY started_at DESC LIMIT 12`,
    ),
  );

  console.log("orders total:", range);
  console.log("orders in last 183 days:", last6);
  console.log("orders by month:");
  for (const r of byMonth) console.log("  ", r.month, r.n);
  console.log("recent sync runs:");
  for (const r of runs)
    console.log("  ", r.started_at, r.kind, r.status, "written=" + r.items_written);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
