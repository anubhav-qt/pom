import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });
import { sql } from "drizzle-orm";
import { db } from "../src/db";
import { parseVariantTitle } from "../src/lib/variant-title";

function rows(res: any): any[] {
  return Array.isArray(res) ? res : (res?.rows ?? []);
}

async function main() {
  const r = rows(await db.execute(sql`SELECT DISTINCT title FROM order_items WHERE title IS NOT NULL ORDER BY title`));
  const groups = new Map<string, { label: string; variants: Set<string> }>();
  for (const x of r) {
    const p = parseVariantTitle(x.title);
    console.log(
      `size=${(p.size ?? "-").padEnd(4)} color=${(p.color ?? "-").padEnd(18)} | ${p.label}`,
    );
    let g = groups.get(p.baseKey);
    if (!g) { g = { label: p.label, variants: new Set() }; groups.set(p.baseKey, g); }
    g.variants.add(`${p.size ?? "-"}/${p.color ?? "-"}`);
  }
  console.log(`\n=== ${groups.size} product groups ===`);
  for (const [, g] of groups) console.log(`${g.label}  (${g.variants.size} variants: ${[...g.variants].join(", ")})`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
