import fs from "fs";
import path from "path";

import { buildLabelSheets } from "../src/lib/label-print";

/** npx tsx scripts/try-label-print.ts out.pdf in1.pdf in2.pdf ... */
async function main() {
  const [outPath, ...inputs] = process.argv.slice(2);
  const files = inputs.map((p) => ({ name: path.basename(p), data: new Uint8Array(fs.readFileSync(p)) }));
  const res = await buildLabelSheets(files, { cutGuides: false });
  fs.writeFileSync(outPath, res.pdf);
  console.log(`${res.labels.length} labels -> ${res.sheets} sheets; duplicates: ${res.duplicates.join(",") || "none"}`);
  for (const f of res.files) {
    console.log(`${f.name}: ${f.pages} pages, ${f.labels} labels, ${f.skipped.length} skipped`, f.error ?? "");
  }
  console.log(`frames removed: ${res.framesRemoved}, unstamped: ${res.unstamped}`);
  for (const l of res.labels.slice(0, 3)) console.log(l.platform, JSON.stringify(l.products));
}
main();
