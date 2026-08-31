/**
 * Full Amazon SP-API exercise — every call this app makes, end to end.
 *
 *   npm run check:amazon:full                       # uses the saved account
 *   npm run check:amazon:full -- Atzr|IwEBI... --seller A1XXXX
 *   npm run check:amazon:full -- Atzr|... --sandbox
 *
 * Walks: LWA token → getOrders → orderItems (checks ASIN is present) →
 * Catalog Items images → Reports API (create + poll + download the All Orders
 * report) → MFN shipments lookup. Read-only throughout — it never pushes
 * inventory or buys a label. Stops at the first hard failure and prints
 * Amazon's own error.
 */
import { config } from "dotenv";

config({ path: ".env.local" });
config({ path: ".env" });

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const SANDBOX = { marketplaceId: "ATVPDKIKX0DER", createdAfter: "TEST_CASE_200", orderId: "TEST_CASE_200" };

const g = (s: string) => `\x1b[32m${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m${s}\x1b[0m`;
const ok = (m: string) => console.log(`  ${g("✓")} ${m}`);
const bad = (m: string) => console.log(`  ${r("✗")} ${m}`);
const info = (m: string) => console.log(`    ${m}`);
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const sandbox = args.includes("--sandbox");
  let refreshToken = args.find((a) => a.startsWith("Atzr|"));
  let sellerId = arg("seller");

  const clientId = process.env.AMAZON_LWA_CLIENT_ID;
  const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET;

  console.log("\n1. Configuration");
  if (!clientId || !clientSecret) return bad("AMAZON_LWA_CLIENT_ID / _SECRET missing from .env.local");
  ok(`client ID ${clientId.slice(0, 26)}…  · secret ${clientSecret.length} chars`);

  if (!refreshToken) {
    try {
      const { db } = await import("../src/db");
      const { channelAccounts } = await import("../src/db/schema");
      const { eq } = await import("drizzle-orm");
      const accounts = await db.select().from(channelAccounts).where(eq(channelAccounts.channel, "amazon"));
      const acct =
        accounts.find((a) => String((a.credentials as Record<string, string>)?.refreshToken ?? "").startsWith("Atzr|")) ??
        accounts[0];
      const creds = acct?.credentials as Record<string, string> | undefined;
      if (creds?.refreshToken) {
        refreshToken = creds.refreshToken;
        sellerId ??= creds.sellerId;
        ok(`using saved account "${acct.label}"`);
      }
    } catch {
      info("(no database reachable — pass the refresh token as an argument)");
    }
  }
  if (!refreshToken) {
    bad("no refresh token — pass it:  npm run check:amazon:full -- Atzr|IwEBI...");
    process.exit(1);
  }

  const endpointBase = process.env.AMAZON_SPAPI_ENDPOINT ?? "https://sellingpartnerapi-eu.amazon.com";
  const endpoint = sandbox ? endpointBase.replace("https://", "https://sandbox.") : endpointBase;
  const marketplaceId = sandbox ? SANDBOX.marketplaceId : (process.env.AMAZON_MARKETPLACE_ID ?? "A21TJRUUN4KGV");
  info(`endpoint ${endpoint}  · marketplace ${marketplaceId}  · mode ${sandbox ? "SANDBOX" : "PRODUCTION"}`);

  /* ----------------------------------------------------------- 2. token -- */
  console.log("\n2. LWA token exchange");
  const tokenRes = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
  });
  const tokenText = await tokenRes.text();
  if (!tokenRes.ok) {
    bad(`LWA ${tokenRes.status}`);
    info(tokenText);
    process.exit(1);
  }
  const accessToken = (JSON.parse(tokenText) as { access_token: string }).access_token;
  ok("access token minted");

  const api = async (path: string, query: Record<string, string | undefined> = {}, init: RequestInit = {}) => {
    const url = new URL(path, endpoint);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
    const res = await fetch(url, {
      ...init,
      headers: { "x-amz-access-token": accessToken, "content-type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, json: text ? JSON.parse(text) : {}, text };
  };

  /* ---------------------------------------------------------- 3. orders -- */
  console.log("\n3. GET /orders/v0/orders");
  const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const ordersRes = await api("/orders/v0/orders", sandbox
    ? { MarketplaceIds: marketplaceId, CreatedAfter: SANDBOX.createdAfter }
    : { MarketplaceIds: marketplaceId, LastUpdatedAfter: since, MaxResultsPerPage: "10" });
  if (!ordersRes.ok) {
    bad(`SP-API ${ordersRes.status}`);
    info(ordersRes.text);
    process.exit(1);
  }
  const orderList = (ordersRes.json.payload?.Orders ?? []) as Record<string, unknown>[];
  ok(`${orderList.length} order(s) in the window`);
  const firstOrderId = sandbox ? SANDBOX.orderId : (orderList[0]?.AmazonOrderId as string | undefined);

  /* ------------------------------------------------------- 4. orderItems -- */
  let sampleAsin: string | undefined;
  if (firstOrderId) {
    console.log(`\n4. GET /orders/v0/orders/${firstOrderId}/orderItems`);
    const itemsRes = await api(`/orders/v0/orders/${encodeURIComponent(firstOrderId)}/orderItems`);
    if (!itemsRes.ok) {
      bad(`SP-API ${itemsRes.status}`);
      info(itemsRes.text);
    } else {
      const items = (itemsRes.json.payload?.OrderItems ?? []) as Record<string, unknown>[];
      ok(`${items.length} line item(s)`);
      sampleAsin = items[0]?.ASIN as string | undefined;
      (items[0]?.ASIN ? ok : bad)(`ASIN on line item ${sampleAsin ? `(${sampleAsin})` : "— MISSING, images won't resolve"}`);
      (items[0]?.SellerSKU ? ok : bad)("SellerSKU on line item");
    }
  } else {
    info("no recent order — skipping orderItems / catalog / MFN checks");
  }

  /* ---------------------------------------------------- 5. catalog image -- */
  if (sampleAsin && !sandbox) {
    console.log("\n5. GET /catalog/2022-04-01/items  (images)");
    const catRes = await api("/catalog/2022-04-01/items", {
      identifiers: sampleAsin,
      identifiersType: "ASIN",
      marketplaceIds: marketplaceId,
      includedData: "images",
      pageSize: "1",
    });
    if (!catRes.ok) {
      bad(`Catalog Items ${catRes.status}`);
      info(catRes.text.slice(0, 400));
    } else {
      const first = (catRes.json.items ?? [])[0] as { images?: { images?: { link?: string; variant?: string }[] }[] } | undefined;
      const link = first?.images?.flatMap((x) => x.images ?? [])?.[0]?.link;
      (link ? ok : bad)(link ? `image URL resolved (${link.slice(0, 60)}…)` : "no image in catalogue for this ASIN");
    }
  }

  /* --------------------------------------------------------- 6. reports -- */
  if (!sandbox) {
    console.log("\n6. Reports API — GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL");
    const created = await api("/reports/2021-06-30/reports", {}, {
      method: "POST",
      body: JSON.stringify({
        reportType: "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL",
        dataStartTime: new Date(Date.now() - 7 * 86_400_000).toISOString(),
        dataEndTime: new Date().toISOString(),
        marketplaceIds: [marketplaceId],
      }),
    });
    if (!created.ok) {
      bad(`createReport ${created.status}`);
      info(created.text.slice(0, 400));
    } else {
      const reportId = created.json.reportId as string;
      ok(`report created (${reportId})`);
      let docId: string | undefined;
      for (let i = 0; i < 10 && !docId; i++) {
        await sleep(6000);
        const poll = await api(`/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`);
        const status = poll.json.processingStatus as string;
        info(`  poll ${i + 1}: ${status}`);
        if (status === "DONE") docId = poll.json.reportDocumentId as string;
        if (status === "FATAL" || status === "CANCELLED") break;
      }
      if (!docId) {
        info("still processing after ~60s — that is normal; the backfill script waits up to 20 min");
      } else {
        const doc = await api(`/reports/2021-06-30/documents/${encodeURIComponent(docId)}`);
        const dl = await fetch(doc.json.url as string);
        const buf = Buffer.from(await dl.arrayBuffer());
        let tsv = buf.toString("utf8");
        if (doc.json.compressionAlgorithm === "GZIP") {
          const { gunzipSync } = await import("node:zlib");
          tsv = gunzipSync(buf).toString("utf8");
        }
        const header = tsv.split(/\r?\n/)[0] ?? "";
        const cols = header.split("\t");
        (cols.includes("amazon-order-id") ? ok : bad)(`report downloaded — ${cols.length} columns`);
        (cols.includes("asin") ? ok : bad)("`asin` column present");
        (cols.includes("item-price") ? ok : bad)("`item-price` column present");
        info(`  first columns: ${cols.slice(0, 8).join(", ")}`);
      }
    }
  }

  /* ------------------------------------------------------------ 7. MFN -- */
  if (firstOrderId && !sandbox) {
    console.log("\n7. GET /mfn/v0/shipments  (label retrieval)");
    const mfn = await api("/mfn/v0/shipments", { amazonOrderId: firstOrderId });
    if (mfn.status === 404) {
      ok("route + auth OK (404 = no Buy Shipping purchase for this order, expected for Easy Ship)");
    } else if (mfn.ok) {
      ok("shipment found — a Buy Shipping label is retrievable");
    } else {
      bad(`MFN ${mfn.status}`);
      info(mfn.text.slice(0, 300));
    }
  }

  console.log(`\n${g("Done.")}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error("\nUnexpected failure:\n", err);
  process.exit(1);
});
