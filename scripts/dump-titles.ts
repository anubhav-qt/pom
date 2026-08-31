import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });
import { sql } from "drizzle-orm";
import { db } from "../src/db";

function rows(res: any): any[] {
  return Array.isArray(res) ? res : (res?.rows ?? []);
}

async function main() {
  const r = rows(
    await db.execute(
      sql`SELECT DISTINCT title, external_sku FROM order_items WHERE title IS NOT NULL ORDER BY title`,
    ),
  );
  for (const x of r) console.log(`${x.external_sku}\t${x.title}`);
  console.log(`\n${r.length} distinct titles`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
