/**
 * Fill a local database with realistic test data so the whole app can be
 * exercised without a single marketplace credential.
 *
 *   npm run seed:demo
 *
 * Orders go in through the real `ingestOrders` path rather than raw inserts, so
 * this also exercises SKU mapping, status reconciliation and stock reservation.
 *
 * Destructive: wipes existing data first. Local testing only.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

import { PDFDocument, StandardFonts } from "pdf-lib";

async function main() {
  const { db } = await import("../src/db");
  const schema = await import("../src/db/schema");
  const { ingestOrders, ingestReturns } = await import("../src/lib/sync");
  const { adjustStock } = await import("../src/lib/inventory");
  const bcrypt = (await import("bcryptjs")).default;
  const { eq, and } = await import("drizzle-orm");

  const {
    users,
    channelAccounts,
    channelListings,
    inventory,
    inventoryLedger,
    products,
    orders,
    orderItems,
    shipments,
    returns,
    batches,
    batchOrders,
    syncRuns,
  } = schema;

  if (!process.env.DATABASE_URL?.includes("localhost")) {
    console.error(
      "Refusing to run: DATABASE_URL does not point at localhost.\n" +
        "This script deletes everything. Point it at your local Docker Postgres.",
    );
    process.exit(1);
  }

  console.log("Clearing existing data…");
  // Order matters — children before parents, since some FKs are RESTRICT.
  await db.delete(batchOrders);
  await db.delete(batches);
  await db.delete(returns);
  await db.delete(shipments);
  await db.delete(orderItems);
  await db.delete(orders);
  await db.delete(inventoryLedger);
  await db.delete(inventory);
  await db.delete(channelListings);
  await db.delete(products);
  await db.delete(syncRuns);
  await db.delete(channelAccounts);
  await db.delete(users);

  /* --------------------------------------------------------------- users -- */

  // Meets the same policy real accounts are held to, so the demo exercises the
  // real login path — including the mandatory MFA-setup screen on first sign-in.
  const DEMO_PASSWORD = "Demo-Pass-123!";
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const [owner] = await db
    .insert(users)
    .values([
      { email: "dad@paribelle.test", name: "Papa", passwordHash, role: "owner" },
      { email: "staff@paribelle.test", name: "Ravi (packer)", passwordHash, role: "staff" },
    ])
    .returning({ id: users.id });

  console.log(`✓ users: dad@paribelle.test / staff@paribelle.test  (${DEMO_PASSWORD})`);
  console.log("  First login for each will prompt to set up MFA — scan the QR with an authenticator app.");

  /* ------------------------------------------------------------ channels -- */

  const [amazonAcct, flipkartAcct, meeshoAcct] = await db
    .insert(channelAccounts)
    .values([
      {
        channel: "amazon",
        label: "Paribelle — Amazon",
        credentials: { refreshToken: "demo-not-a-real-token", sellerId: "A1DEMOSELLER" },
      },
      {
        channel: "flipkart",
        label: "Paribelle — Flipkart",
        credentials: { appId: "demo-app-id", appSecret: "demo-secret", locationId: "WH1" },
      },
      { channel: "meesho", label: "Paribelle — Meesho", credentials: {} },
    ])
    .returning();

  console.log("✓ 3 channel accounts");

  /* ------------------------------------------------------------ products -- */

  const CATALOGUE = [
    { sku: "PB-KRT-BLU-M", name: "Cotton Kurti — Blue", bin: "A-01", stock: 24 },
    { sku: "PB-KRT-BLU-L", name: "Cotton Kurti — Blue", bin: "A-02", stock: 18 },
    { sku: "PB-KRT-RED-M", name: "Cotton Kurti — Red", bin: "A-03", stock: 6 },
    { sku: "PB-KRT-RED-L", name: "Cotton Kurti — Red", bin: "A-04", stock: 2 },
    { sku: "PB-DUP-GRN", name: "Silk Dupatta — Green", bin: "B-11", stock: 40 },
    { sku: "PB-DUP-YEL", name: "Silk Dupatta — Yellow", bin: "B-12", stock: 0 },
    { sku: "PB-SAR-PNK", name: "Georgette Saree — Pink", bin: "C-05", stock: 12 },
    { sku: "PB-SAR-BLK", name: "Georgette Saree — Black", bin: "C-06", stock: 9 },
    { sku: "PB-LEG-BLK", name: "Ankle Leggings — Black", bin: "D-01", stock: 55 },
    { sku: "PB-LEG-NVY", name: "Ankle Leggings — Navy", bin: "D-02", stock: 31 },
  ];

  const productIds = new Map<string, number>();
  for (const item of CATALOGUE) {
    const [row] = await db
      .insert(products)
      .values({
        sku: item.sku,
        name: item.name,
        binLocation: item.bin,
        hsnCode: "6204",
        costPrice: "180.00",
        weightGrams: 300,
      })
      .returning({ id: products.id });

    productIds.set(item.sku, row.id);
    await db.insert(inventory).values({ productId: row.id, onHand: 0, buffer: 2 });
    if (item.stock > 0) {
      await adjustStock({
        productId: row.id,
        delta: item.stock,
        reason: "manual",
        note: "Opening stock",
        userId: owner.id,
      });
    }
  }

  console.log(`✓ ${CATALOGUE.length} products with bins and opening stock`);

  /* ------------------------------------------------------------ listings -- */

  // Each channel names the same product differently — the whole reason
  // channel_listings exists. Two SKUs are left unmapped on purpose so the
  // "unmapped SKU" warning has something to show.
  const UNMAPPED = new Set(["PB-LEG-NVY"]);

  for (const item of CATALOGUE) {
    if (UNMAPPED.has(item.sku)) continue;
    const productId = productIds.get(item.sku)!;

    await db.insert(channelListings).values([
      { productId, channelAccountId: amazonAcct.id, externalSku: item.sku, externalId: `B0DEMO${item.sku.slice(-3)}` },
      { productId, channelAccountId: flipkartAcct.id, externalSku: `FK-${item.sku}` },
      { productId, channelAccountId: meeshoAcct.id, externalSku: item.sku.toLowerCase() },
    ]);
  }

  console.log("✓ channel listings (1 SKU deliberately left unmapped)");

  /* -------------------------------------------------------------- orders -- */

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);
  const hoursAhead = (h: number) => new Date(Date.now() + h * 3_600_000);

  const CITIES = [
    ["Mumbai", "Maharashtra", "400001"],
    ["Bengaluru", "Karnataka", "560001"],
    ["Surat", "Gujarat", "395010"],
    ["Jaipur", "Rajasthan", "302001"],
    ["Kolkata", "West Bengal", "700001"],
    ["Chennai", "Tamil Nadu", "600001"],
  ];

  function city(i: number) {
    const [c, s, p] = CITIES[i % CITIES.length];
    return { shipCity: c, shipState: s, shipPincode: p };
  }

  const NAMES = ["Priya S", "Anil Kumar", "Meera J", "Rahul V", "Fatima K", "Deepak R"];

  // ---- Amazon: a mix of fresh, urgent and already-shipped -------------------
  const amazonOrders = Array.from({ length: 12 }, (_, i) => {
    const item = CATALOGUE[i % CATALOGUE.length];
    return {
      externalOrderId: `403-${7100000 + i}-${2000000 + i}`,
      status: i < 8 ? "new" : i < 10 ? "packed" : "shipped",
      orderedAt: hoursAgo(6 + i * 3),
      buyerName: NAMES[i % NAMES.length],
      ...city(i),
      totalAmount: (499 + i * 37).toFixed(2),
      isCod: i % 4 === 0,
      // The first two are already past their deadline, so the "late" flag has
      // something to light up.
      dispatchBy: i < 2 ? hoursAgo(3) : hoursAhead(6 + i * 4),
      items: [
        {
          externalSku: item.sku,
          title: item.name,
          quantity: (i % 3) + 1,
          unitPrice: (499 + i * 37).toFixed(2),
        },
      ],
      shipment: { awb: `AMZ${900000 + i}`, courier: "Amazon Shipping" },
      raw: { demo: true },
    };
  });

  // ---- Flipkart: shipment-keyed, includes a cancellation --------------------
  const flipkartOrders = Array.from({ length: 10 }, (_, i) => {
    const item = CATALOGUE[(i + 3) % CATALOGUE.length];
    return {
      externalOrderId: `FMPP${41000000 + i}`,
      status: i === 9 ? "cancelled" : i < 6 ? "new" : "ready_to_pack",
      orderedAt: hoursAgo(4 + i * 5),
      buyerName: NAMES[(i + 2) % NAMES.length],
      ...city(i + 1),
      totalAmount: (349 + i * 51).toFixed(2),
      isCod: i % 3 === 0,
      dispatchBy: hoursAhead(4 + i * 5),
      items: [
        {
          externalSku: `FK-${item.sku}`,
          title: item.name,
          quantity: 1,
          unitPrice: (349 + i * 51).toFixed(2),
        },
      ],
      shipment: { externalShipmentId: `FMPP${41000000 + i}`, awb: `FK${770000 + i}`, courier: "Ekart" },
      raw: { demo: true },
    };
  });

  // ---- Meesho: sub-order keyed, one on the unmapped SKU ---------------------
  const meeshoSubOrderIds = Array.from({ length: 8 }, (_, i) => `18023456789${1000 + i}_1`);
  const meeshoOrders = meeshoSubOrderIds.map((id, i) => {
    const item = CATALOGUE[(i + 6) % CATALOGUE.length];
    // Order 5 uses a SKU with no listing, to exercise the unmapped path.
    const sku = i === 5 ? "pb-leg-nvy" : item.sku.toLowerCase();
    return {
      externalOrderId: id,
      status: "new" as const,
      orderedAt: hoursAgo(2 + i * 4),
      buyerName: null,
      ...city(i + 2),
      totalAmount: (299 + i * 43).toFixed(2),
      isCod: false,
      dispatchBy: hoursAhead(10 + i * 3),
      items: [
        {
          externalSku: sku,
          title: `${item.name} · ${["S", "M", "L", "XL"][i % 4]}`,
          quantity: 1,
          unitPrice: (299 + i * 43).toFixed(2),
        },
      ],
      shipment: { externalShipmentId: `PKT${500 + i}`, awb: `SF${330000 + i}`, courier: "Shadowfax" },
      raw: { demo: true },
    };
  });

  const a = await ingestOrders(amazonAcct, amazonOrders as never);
  const f = await ingestOrders(flipkartAcct, flipkartOrders as never);
  const m = await ingestOrders(meeshoAcct, meeshoOrders as never);

  console.log(
    `✓ orders — Amazon ${a.written}, Flipkart ${f.written}, Meesho ${m.written}` +
      (m.unmappedSkus.length ? `  (unmapped: ${m.unmappedSkus.join(", ")})` : ""),
  );

  /* ------------------------------------------------- Meesho label attach -- */

  // Real Meesho labels arrive as one combined PDF. Generate stand-ins so the
  // label printer and crop can be tested without a supplier account.
  const font = await (async () => {
    const d = await PDFDocument.create();
    return d.embedFont(StandardFonts.Helvetica);
  })();

  let attached = 0;
  for (const id of meeshoSubOrderIds) {
    const doc = await PDFDocument.create();
    const f2 = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([288, 432]);

    page.drawText("MEESHO", { x: 20, y: 405, size: 14, font: f2 });
    page.drawText(`SUB ORDER NO: ${id}`, { x: 20, y: 385, size: 8, font: f2 });
    page.drawText("Shadowfax", { x: 20, y: 365, size: 10, font: f2 });
    page.drawText("[||| BARCODE |||]", { x: 20, y: 330, size: 16, font: f2 });
    // Below the halfway line, so the crop option visibly removes it.
    page.drawText("TAX INVOICE", { x: 20, y: 190, size: 11, font: f2 });
    page.drawText("This half is cropped away when", { x: 20, y: 170, size: 8, font: f2 });
    page.drawText('"Crop off invoice" is ticked.', { x: 20, y: 158, size: 8, font: f2 });

    const pdf = Buffer.from(await doc.save());

    const [order] = await db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.channelAccountId, meeshoAcct.id), eq(orders.externalOrderId, id)))
      .limit(1);
    if (!order) continue;

    const [existing] = await db
      .select({ id: shipments.id })
      .from(shipments)
      .where(eq(shipments.orderId, order.id))
      .limit(1);

    if (existing) {
      await db
        .update(shipments)
        .set({ labelPdf: pdf, labelFetchedAt: new Date() })
        .where(eq(shipments.id, existing.id));
    } else {
      await db
        .insert(shipments)
        .values({ orderId: order.id, labelPdf: pdf, labelFetchedAt: new Date() });
    }

    await db
      .update(orders)
      .set({ status: "ready_to_pack" })
      .where(and(eq(orders.id, order.id), eq(orders.status, "new")));

    attached++;
  }

  console.log(`✓ ${attached} Meesho labels generated and attached`);

  /* ------------------------------------------------------------- returns -- */

  await ingestReturns(flipkartAcct, [
    {
      externalReturnId: "RET-88001",
      externalOrderId: "FMPP41000002",
      kind: "return",
      reason: "Size too small",
      awb: "FK770002R",
      status: "In transit",
      expectedAt: hoursAhead(48),
      raw: { demo: true },
    },
    {
      externalReturnId: "RET-88002",
      externalOrderId: "FMPP41000004",
      kind: "rto",
      reason: "Customer unreachable",
      awb: "FK770004R",
      status: "Out for delivery to seller",
      expectedAt: hoursAhead(24),
      raw: { demo: true },
    },
    {
      externalReturnId: "RET-88003",
      externalOrderId: "FMPP41000001",
      kind: "return",
      reason: "Colour different from photo",
      awb: "FK770001R",
      status: "In transit",
      expectedAt: hoursAhead(72),
      raw: { demo: true },
    },
  ] as never);

  console.log("✓ 3 returns awaiting check-in");

  /* --------------------------------------------------------- sync log -- */

  await db.insert(syncRuns).values([
    {
      channelAccountId: amazonAcct.id,
      kind: "orders",
      status: "ok",
      startedAt: hoursAgo(0.2),
      finishedAt: hoursAgo(0.19),
      itemsSeen: 12,
      itemsWritten: 12,
    },
    {
      channelAccountId: flipkartAcct.id,
      kind: "orders",
      status: "failed",
      startedAt: hoursAgo(0.5),
      finishedAt: hoursAgo(0.49),
      error: "[flipkart] token request failed (401): invalid_client — demo credentials",
    },
  ]);

  console.log("✓ sync log seeded (one deliberate failure, to show error surfacing)");

  console.log("\nDone. Start the app with:  npm run dev");
  console.log("Sign in at http://localhost:3000/login as dad@paribelle.test / Demo-Pass-123!");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
