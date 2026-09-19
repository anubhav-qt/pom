/**
 * Compares our Paribelle OMS product catalogue against the seller's live
 * Amazon listings, so we can see which Amazon SKUs are already known to us
 * and which ones are new (added on Amazon but never imported here).
 *
 * Pulls the full listings report straight from SP-API (same approach as
 * scripts/amazon-listings-to-xlsx.ts), enriches with Catalog Items images,
 * then cross-references seller-sku / asin1 against products + channel_listings
 * for the saved Amazon channel account.
 *
 *   npx tsx scripts/amazon-inventory-diff.ts [output.xlsx]
 *
 * Default output: tmp/amazon-inventory-diff.xlsx
 */
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import * as XLSX from "xlsx";

config({ path: ".env.local" });
config({ path: ".env" });

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const LISTINGS_REPORT = "GET_MERCHANT_LISTINGS_ALL_DATA";

/* ------------------------------------------------------------------ auth -- */

interface Ctx {
  endpoint: string;
  marketplaceId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken: string;
  issuedAt: number;
}

async function mintToken(ctx: Pick<Ctx, "refreshToken" | "clientId" | "clientSecret">): Promise<string> {
  const res = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: ctx.refreshToken,
      client_id: ctx.clientId,
      client_secret: ctx.clientSecret,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`LWA token refresh failed: ${res.status} ${body}`);
  return (JSON.parse(body) as { access_token: string }).access_token;
}

async function token(ctx: Ctx): Promise<string> {
  if (Date.now() - ctx.issuedAt > 50 * 60_000) {
    ctx.accessToken = await mintToken(ctx);
    ctx.issuedAt = Date.now();
  }
  return ctx.accessToken;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T>(
  ctx: Ctx,
  pathname: string,
  init: RequestInit & { query?: Record<string, string> } = {},
  attempt = 0,
): Promise<T> {
  const url = new URL(pathname, ctx.endpoint);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    ...init,
    headers: {
      "x-amz-access-token": await token(ctx),
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (res.status === 429 && attempt < 6) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(2000 * 2 ** attempt, 16_000);
    await sleep(waitMs);
    return api<T>(ctx, pathname, init, attempt + 1);
  }

  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${pathname} -> ${res.status}: ${text.slice(0, 400)}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

/* --------------------------------------------------------------- report -- */

async function requestListingsReport(ctx: Ctx): Promise<string> {
  const res = await api<{ reportId?: string }>(ctx, "/reports/2021-06-30/reports", {
    method: "POST",
    body: JSON.stringify({
      reportType: LISTINGS_REPORT,
      marketplaceIds: [ctx.marketplaceId],
    }),
  });
  if (!res.reportId) throw new Error("createReport returned no reportId");
  return res.reportId;
}

async function pollReport(ctx: Ctx, reportId: string, timeoutMs = 20 * 60_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let waitMs = 5_000;
  for (;;) {
    const r = await api<{ processingStatus?: string; reportDocumentId?: string }>(
      ctx,
      `/reports/2021-06-30/reports/${encodeURIComponent(reportId)}`,
    );
    if (r.processingStatus === "DONE") {
      if (!r.reportDocumentId) throw new Error(`report ${reportId} DONE with no document`);
      return r.reportDocumentId;
    }
    if (r.processingStatus === "FATAL" || r.processingStatus === "CANCELLED") {
      throw new Error(`report ${reportId} ended ${r.processingStatus}`);
    }
    if (Date.now() > deadline) throw new Error(`report ${reportId} timed out (${r.processingStatus})`);
    process.stdout.write(`  ...${r.processingStatus ?? "pending"}\n`);
    await sleep(waitMs);
    waitMs = Math.min(Math.round(waitMs * 1.5), 30_000);
  }
}

async function downloadReport(ctx: Ctx, documentId: string): Promise<string> {
  const doc = await api<{ url?: string; compressionAlgorithm?: string }>(
    ctx,
    `/reports/2021-06-30/documents/${encodeURIComponent(documentId)}`,
  );
  if (!doc.url) throw new Error("report document has no url");
  const res = await fetch(doc.url);
  if (!res.ok) throw new Error(`document download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return doc.compressionAlgorithm === "GZIP" ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
}

/* ------------------------------------------------------------------ tsv -- */

type Row = Record<string, string>;

function parseTsv(text: string): Row[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const headers = lines[0].split("\t").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row: Row = {};
    headers.forEach((h, i) => (row[h] = (cells[i] ?? "").trim()));
    return row;
  });
}

/* -------------------------------------------------------------- catalog -- */

interface CatalogInfo {
  images: string[];
  brand: string;
  productType: string;
}

interface CatalogItemsResponse {
  items?: Array<{
    asin?: string;
    images?: Array<{
      marketplaceId?: string;
      images?: Array<{ variant?: string; link?: string; width?: number; height?: number }>;
    }>;
    summaries?: Array<{ marketplaceId?: string; brand?: string }>;
    productTypes?: Array<{ marketplaceId?: string; productType?: string }>;
  }>;
}

async function fetchCatalog(ctx: Ctx, asins: string[]): Promise<Map<string, CatalogInfo>> {
  const out = new Map<string, CatalogInfo>();
  const unique = [...new Set(asins.filter(Boolean))];
  console.log(`Enriching ${unique.length} unique ASINs via Catalog Items...`);

  for (let i = 0; i < unique.length; i += 20) {
    const batch = unique.slice(i, i + 20);
    let res: CatalogItemsResponse;
    try {
      res = await api<CatalogItemsResponse>(ctx, "/catalog/2022-04-01/items", {
        query: {
          identifiers: batch.join(","),
          identifiersType: "ASIN",
          marketplaceIds: ctx.marketplaceId,
          includedData: "images,summaries,productTypes",
          pageSize: "20",
        },
      });
    } catch (err) {
      console.warn(`  [catalog] batch ${i / 20 + 1} failed: ${(err as Error).message.slice(0, 160)}`);
      await sleep(600);
      continue;
    }

    for (const item of res.items ?? []) {
      if (!item.asin) continue;
      const group = item.images?.find((g) => g.marketplaceId === ctx.marketplaceId) ?? item.images?.[0];
      const byVariant = new Map<string, { link: string; width: number }>();
      for (const img of group?.images ?? []) {
        if (!img.link || !img.variant) continue;
        const seen = byVariant.get(img.variant);
        if (!seen || (img.width ?? 0) > seen.width) byVariant.set(img.variant, { link: img.link, width: img.width ?? 0 });
      }
      const ordered = ["MAIN", "PT01", "PT02", "PT03", "PT04", "PT05"];
      const preferred = ordered.map((v) => byVariant.get(v)?.link).filter((l): l is string => !!l);
      const images = preferred.length ? preferred : [...byVariant.values()].map((v) => v.link);

      const summary = item.summaries?.find((s) => s.marketplaceId === ctx.marketplaceId) ?? item.summaries?.[0];
      const productType =
        (item.productTypes?.find((p) => p.marketplaceId === ctx.marketplaceId) ?? item.productTypes?.[0])
          ?.productType ?? "";

      out.set(item.asin, { images, brand: summary?.brand ?? "", productType });
    }

    const done = Math.min(i + 20, unique.length);
    console.log(`  ${done}/${unique.length}`);
    await sleep(600);
  }
  return out;
}

/* ----------------------------------------------------------------- main -- */

async function main() {
  const outPath = process.argv[2] ?? path.join("tmp", "amazon-inventory-diff.xlsx");

  const { db } = await import("../src/db");
  const { channelAccounts, channelListings, products } = await import("../src/db/schema");
  const { eq, and } = await import("drizzle-orm");

  const accounts = await db.select().from(channelAccounts).where(eq(channelAccounts.channel, "amazon"));
  const account =
    accounts.find((a) => String((a.credentials as any)?.refreshToken ?? "").startsWith("Atzr|")) ?? accounts[0];
  if (!account) throw new Error("No Amazon channel account found in the OMS database.");

  console.log(`--- Step 1: reading Paribelle DB (what we already have) ---`);
  const known = await db
    .select({
      externalSku: channelListings.externalSku,
      externalId: channelListings.externalId,
      productSku: products.sku,
      productName: products.name,
      active: channelListings.active,
    })
    .from(channelListings)
    .innerJoin(products, eq(channelListings.productId, products.id))
    .where(eq(channelListings.channelAccountId, account.id));

  const bySku = new Map(known.map((k) => [k.externalSku.trim().toLowerCase(), k]));
  const byAsin = new Map(known.filter((k) => k.externalId).map((k) => [k.externalId!.trim().toUpperCase(), k]));
  console.log(`  ${known.length} Amazon listings already linked to Paribelle products (${new Set(known.map((k) => k.productSku)).size} distinct product SKUs)`);

  console.log(`\n--- Step 2: pulling live Amazon listings via SP-API ---`);
  const creds = account.credentials as any;
  const ctx: Ctx = {
    endpoint: creds?.endpoint ?? process.env.AMAZON_SPAPI_ENDPOINT ?? "https://sellingpartnerapi-eu.amazon.com",
    marketplaceId: creds?.marketplaceId ?? process.env.AMAZON_MARKETPLACE_ID ?? "A21TJRUUN4KGV",
    clientId: creds?.clientId ?? process.env.AMAZON_LWA_CLIENT_ID,
    clientSecret: creds?.clientSecret ?? process.env.AMAZON_LWA_CLIENT_SECRET,
    refreshToken: creds?.refreshToken,
    accessToken: "",
    issuedAt: 0,
  };
  if (!ctx.clientId || !ctx.clientSecret || !ctx.refreshToken) {
    throw new Error("Amazon account is missing clientId / clientSecret / refreshToken.");
  }
  ctx.accessToken = await mintToken(ctx);
  ctx.issuedAt = Date.now();
  console.log(`Account "${account.label}" · marketplace ${ctx.marketplaceId}`);

  console.log(`Requesting ${LISTINGS_REPORT}...`);
  const reportId = await requestListingsReport(ctx);
  console.log(`  reportId ${reportId}`);
  const documentId = await pollReport(ctx, reportId);
  console.log(`  documentId ${documentId}`);
  const tsv = await downloadReport(ctx, documentId);

  const rows = parseTsv(tsv);
  console.log(`\n${rows.length} listing rows on Amazon`);
  const statuses = new Map<string, number>();
  for (const r of rows) statuses.set(r.status || "(blank)", (statuses.get(r.status || "(blank)") ?? 0) + 1);
  console.log("By status:", [...statuses].map(([s, n]) => `${s}=${n}`).join(", "));

  const catalog = await fetchCatalog(ctx, rows.map((r) => r.asin1));

  console.log(`\n--- Step 3: diffing Amazon against Paribelle DB ---`);
  const reportColumns = Object.keys(rows[0] ?? {});
  const sheetRows = rows.map((row) => {
    const info = catalog.get(row.asin1);
    const sku = (row["seller-sku"] ?? "").trim().toLowerCase();
    const asin = (row.asin1 ?? "").trim().toUpperCase();
    const matchBySku = bySku.get(sku);
    const matchByAsin = matchBySku ? undefined : byAsin.get(asin);
    const match = matchBySku ?? matchByAsin;
    return {
      ...row,
      "_InParibelle": match ? "YES" : "NEW",
      "_MatchedProductSku": match?.productSku ?? "",
      "_MatchedProductName": match?.productName ?? "",
      "_Brand": info?.brand ?? "",
      "_ProductType": info?.productType ?? "",
      "_Images": (info?.images ?? []).join(", "),
      "_ImageCount": info?.images?.length ?? 0,
    };
  });

  const newRows = sheetRows.filter((r) => r._InParibelle === "NEW");
  console.log(`  ${sheetRows.length - newRows.length} listings already in Paribelle`);
  console.log(`  ${newRows.length} listings NOT in Paribelle (new / never imported)`);

  const columns = [
    ...reportColumns,
    "_InParibelle", "_MatchedProductSku", "_MatchedProductName",
    "_Brand", "_ProductType", "_Images", "_ImageCount",
  ];

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows, { header: columns }), "All Listings");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(newRows, { header: columns }), "New (not in Paribelle)");
  XLSX.writeFile(wb, outPath);

  console.log(`\nWrote ${outPath}`);
  console.log(`  Sheet "All Listings": ${sheetRows.length} rows`);
  console.log(`  Sheet "New (not in Paribelle)": ${newRows.length} rows`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
