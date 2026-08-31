/**
 * Write a sample Meesho order sheet and label PDF to ./tmp so the import form
 * can be exercised by hand, exactly as it will be with real supplier-panel
 * downloads.
 *
 *   npm run fixtures:meesho
 *
 * Then: Settings › Meesho import › upload both files.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PDFDocument, StandardFonts } from "pdf-lib";
import * as XLSX from "xlsx";

const OUT = join(process.cwd(), "tmp");

// Fresh IDs that the demo seeder did not create, so an import is a real insert.
const SUB_ORDERS = Array.from({ length: 6 }, (_, i) => `19988877766${500 + i}_1`);

const PRODUCTS = [
  ["Cotton Kurti — Blue", "pb-krt-blu-m", "M", 449],
  ["Cotton Kurti — Red", "pb-krt-red-m", "M", 449],
  ["Silk Dupatta — Green", "pb-dup-grn", "Free Size", 299],
  ["Georgette Saree — Pink", "pb-sar-pnk", "Free Size", 899],
  ["Ankle Leggings — Black", "pb-leg-blk", "L", 249],
  // Deliberately unlisted, to exercise the unmapped-SKU path on import.
  ["Chiffon Stole — Peach", "pb-stl-pch", "Free Size", 199],
];

const STATUSES = ["Pending", "Ready to Ship", "Pending", "Pending", "Cancelled", "Pending"];

function buildSheet() {
  const rows: unknown[][] = [
    [
      "Sub Order No",
      "Order Date",
      "Customer State",
      "Customer City",
      "Customer Pincode",
      "Product Name",
      "SKU",
      "Size",
      "Quantity",
      "Supplier Discounted Price (Incl GST and Commision)",
      "Packet Id",
      "Reason for Credit Entry",
      "AWB Number",
      "Courier Partner",
      "Dispatch By Date",
    ],
  ];

  const cities = [
    ["Maharashtra", "Pune", "411001"],
    ["Karnataka", "Mysuru", "570001"],
    ["Gujarat", "Rajkot", "360001"],
    ["Rajasthan", "Udaipur", "313001"],
    ["Kerala", "Kochi", "682001"],
    ["Punjab", "Ludhiana", "141001"],
  ];

  SUB_ORDERS.forEach((id, i) => {
    const [name, sku, size, price] = PRODUCTS[i];
    const [state, city, pin] = cities[i];
    rows.push([
      id,
      new Date(Date.now() - (i + 1) * 3_600_000).toISOString().slice(0, 10),
      state,
      city,
      pin,
      name,
      sku,
      size,
      1,
      Number(price).toFixed(2),
      `PKT${900 + i}`,
      STATUSES[i],
      `SF88${1000 + i}`,
      "Shadowfax",
      new Date(Date.now() + (i + 12) * 3_600_000).toISOString().slice(0, 10),
    ]);
  });

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Orders");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function buildLabels() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const [i, id] of SUB_ORDERS.entries()) {
    const page = doc.addPage([288, 432]);
    page.drawText("MEESHO", { x: 20, y: 405, size: 14, font });
    page.drawText(`SUB ORDER NO: ${id}`, { x: 20, y: 385, size: 8, font });
    page.drawText(`AWB: SF88${1000 + i}   Shadowfax`, { x: 20, y: 370, size: 8, font });
    page.drawText("[||||| BARCODE |||||]", { x: 20, y: 330, size: 15, font });
    page.drawText(String(PRODUCTS[i][0]), { x: 20, y: 300, size: 9, font });
    page.drawText("TAX INVOICE", { x: 20, y: 190, size: 11, font });
    page.drawText("Cropped away when the crop", { x: 20, y: 172, size: 8, font });
    page.drawText("option is ticked at print time.", { x: 20, y: 160, size: 8, font });
  }

  // A summary page belonging to no order, as real downloads contain.
  const extra = doc.addPage([288, 432]);
  extra.drawText("MANIFEST SUMMARY", { x: 20, y: 400, size: 12, font });
  extra.drawText(`${SUB_ORDERS.length} shipments`, { x: 20, y: 380, size: 9, font });

  return Buffer.from(await doc.save());
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  writeFileSync(join(OUT, "meesho-orders.xlsx"), buildSheet());
  writeFileSync(join(OUT, "meesho-labels.pdf"), await buildLabels());

  console.log("Wrote:");
  console.log("  tmp/meesho-orders.xlsx  —", SUB_ORDERS.length, "sub-orders (1 cancelled, 1 unlisted SKU)");
  console.log("  tmp/meesho-labels.pdf   —", SUB_ORDERS.length + 1, "pages (last one matches no order)");
  console.log("\nUpload both at Settings › Meesho import.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
