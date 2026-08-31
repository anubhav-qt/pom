/**
 * Exercises the Meesho import path end to end without a database.
 *
 * Builds a realistic order sheet and a matching multi-page label PDF, then runs
 * the real parser and splitter over them. This is the one part of the system
 * with no external API to lean on, so it is worth proving on its own.
 *
 *   npx tsx scripts/verify-meesho.ts
 */
import assert from "node:assert/strict";

import { PDFDocument, StandardFonts } from "pdf-lib";
import * as XLSX from "xlsx";

import { parseMeeshoOrderSheet, splitMeeshoLabels } from "../src/channels/meesho";

const SUB_ORDER_IDS = [
  "180234567890123_1",
  "180234567890124_1",
  "180234567890125_1",
  "180234567890125_2",
];

function buildOrderSheet(): Buffer {
  // Column names and ordering mirror a real Meesho supplier-panel export,
  // including the misspelled "Commision" they actually ship.
  const rows = [
    [
      "Sub Order No",
      "Order Date",
      "Customer State",
      "Product Name",
      "SKU",
      "Size",
      "Quantity",
      "Supplier Discounted Price (Incl GST and Commision)",
      "Packet Id",
      "Reason for Credit Entry",
      "AWB Number",
      "Courier Partner",
      "Some Brand New Column",
    ],
    [
      SUB_ORDER_IDS[0],
      "2026-08-05",
      "Maharashtra",
      "Cotton Kurti",
      "PB-KRT-BLU",
      "M",
      1,
      "449.00",
      "PKT001",
      "Pending",
      "SF123456789",
      "Shadowfax",
      "ignore me",
    ],
    [
      SUB_ORDER_IDS[1],
      "2026-08-05",
      "Karnataka",
      "Cotton Kurti",
      "PB-KRT-RED",
      "L",
      2,
      "898.00",
      "PKT002",
      "Ready to Ship",
      "SF123456790",
      "Shadowfax",
      "ignore me",
    ],
    [
      SUB_ORDER_IDS[2],
      "2026-08-06",
      "Gujarat",
      "Silk Dupatta",
      "PB-DUP-GRN",
      "Free Size",
      1,
      "299.00",
      "PKT003",
      "Cancelled",
      "",
      "",
      "ignore me",
    ],
    [
      SUB_ORDER_IDS[3],
      "2026-08-06",
      "Gujarat",
      "Silk Dupatta",
      "PB-DUP-YEL",
      "Free Size",
      1,
      "299.00",
      "PKT003",
      "Pending",
      "VL987654321",
      "Valmo",
      "ignore me",
    ],
    // A blank trailing row, which real exports contain.
    ["", "", "", "", "", "", "", "", "", "", "", "", ""],
  ];

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Orders");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function buildLabelPdf(ids: string[]): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const id of ids) {
    const page = doc.addPage([288, 432]); // 4x6in thermal label
    page.drawText("MEESHO SHIPPING LABEL", { x: 20, y: 400, size: 10, font });
    page.drawText(`SUB ORDER NO: ${id}`, { x: 20, y: 380, size: 9, font });
    page.drawText("TAX INVOICE", { x: 20, y: 180, size: 10, font });
  }

  // A page that belongs to no order — real sheets include summary pages.
  const stray = doc.addPage([288, 432]);
  stray.drawText("MANIFEST SUMMARY", { x: 20, y: 400, size: 10, font });

  return Buffer.from(await doc.save());
}

async function main() {
  /* ------------------------------------------------------------ parsing -- */

  const parsed = parseMeeshoOrderSheet(buildOrderSheet());

  assert.equal(parsed.orders.length, 4, "should parse one order per sub-order row");
  assert.equal(parsed.skippedRows, 1, "should skip the blank trailing row");
  assert.deepEqual(
    parsed.unmappedColumns,
    ["Some Brand New Column"],
    "should report columns it did not recognise",
  );

  const first = parsed.orders[0];
  assert.equal(first.externalOrderId, SUB_ORDER_IDS[0]);
  assert.equal(first.status, "new", '"Pending" should map to new');
  assert.equal(first.shipState, "Maharashtra");
  assert.equal(first.totalAmount, "449.00");
  assert.equal(first.items[0].externalSku, "PB-KRT-BLU");
  assert.equal(first.items[0].title, "Cotton Kurti · M", "size should be kept in the pick title");
  assert.equal(first.shipment?.awb, "SF123456789");

  assert.equal(parsed.orders[1].status, "ready_to_pack", '"Ready to Ship" should map through');
  assert.equal(parsed.orders[1].items[0].quantity, 2);
  assert.equal(parsed.orders[2].status, "cancelled", '"Cancelled" must be caught');

  console.log("✓ order sheet parsed:", parsed.orders.length, "orders");
  console.log("✓ unrecognised columns surfaced:", parsed.unmappedColumns);

  /* ---------------------------------------------------------- splitting -- */

  const labelPdf = await buildLabelPdf(SUB_ORDER_IDS);
  const split = await splitMeeshoLabels(labelPdf, SUB_ORDER_IDS);

  assert.equal(split.labels.length, 4, "each label page should match an order");
  assert.deepEqual(split.unmatchedPages, [5], "the summary page should be reported, not guessed at");

  for (let i = 0; i < SUB_ORDER_IDS.length; i++) {
    assert.equal(
      split.labels[i].externalOrderId,
      SUB_ORDER_IDS[i],
      "labels must land on the right order",
    );
    const single = await PDFDocument.load(split.labels[i].pdf);
    assert.equal(single.getPageCount(), 1, "each split label should be a single page");
  }

  console.log("✓ labels split and matched:", split.labels.length);
  console.log("✓ unmatched pages reported:", split.unmatchedPages);

  /* ---------------------------------------------- prefix-collision guard -- */

  // "…125_1" is not a prefix of "…125_2", but the shorter parent id is a prefix
  // of both — check the longest-first ordering does the right thing.
  const collisionPdf = await buildLabelPdf(["180234567890125_2"]);
  const collision = await splitMeeshoLabels(collisionPdf, [
    "180234567890125",
    "180234567890125_2",
  ]);
  assert.equal(
    collision.labels[0].externalOrderId,
    "180234567890125_2",
    "the most specific matching id must win",
  );

  console.log("✓ prefix collision resolved to the most specific ID");
  console.log("\nAll Meesho import checks passed.");
}

main().catch((err) => {
  console.error("\n✗ verification failed\n", err);
  process.exit(1);
});
