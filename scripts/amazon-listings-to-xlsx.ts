/**
 * Pulls the seller's full Amazon listings catalogue straight from SP-API and
 * dumps it to a raw .xlsx for manual cleanup before it is shaped into a
 * Paribelle import.
 *
 * Unlike scripts/amazon-to-paribelle.ts — which expects a hand-downloaded
 * "All Listings Report" TSV and emits the final import ZIP — this one drives
 * the Reports API itself (GET_MERCHANT_LISTINGS_ALL_DATA), then enriches each
 * ASIN through Catalog Items for images, brand and product type. Nothing is
 * filtered or normalised: every column the report carries is written through
 * as-is, plus the enriched columns, so the cleanup pass has everything.
 *
 *   npx tsx scripts/amazon-listings-to-xlsx.ts [output.xlsx]
 *
 * Default output: tmp/amazon-listings-raw.xlsx
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

/** LWA tokens last an hour; re-mint at 50 minutes so nothing expires mid-run. */
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

/**
 * Listings reports are a snapshot of the catalogue as it stands, so unlike the
 * orders reports they take no dataStartTime/dataEndTime — sending one is
 * rejected.
 */
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

/* ------------------------------------------------- title/colour/size parse -- */

const SIZE_RE = /^(XS|S|M|L|XL|2XL|3XL|4XL|5XL|6XL|XXL|XXXL|FREE ?SIZE|ONE ?SIZE)$/i;

function canonicalSize(s: string): string {
  const up = s.trim().toUpperCase().replace(/\s+/g, " ");
  if (up === "FREE SIZE" || up === "FREESIZE") return "Free Size";
  if (up === "ONE SIZE" || up === "ONESIZE") return "One Size";
  return up;
}

/**
 * Same patterns scripts/amazon-to-paribelle.ts learned from this seller's
 * catalogue. Kept here so the raw sheet already carries a best-effort split —
 * the cleanup pass can correct it rather than start from scratch.
 */
function parseListing(name: string): { baseTitle: string; colour: string; size: string } {
  const paren = name.match(/^(.*)\s*\(([^)]*)\)\s*$/);
  if (paren) {
    const base = paren[1].trim();
    const tokens = paren[2].split(",").map((t) => t.trim());
    if (tokens.length === 2 && SIZE_RE.test(tokens[1])) {
      return { baseTitle: base, colour: tokens[0], size: canonicalSize(tokens[1]) };
    }
    if (tokens.length === 5 && SIZE_RE.test(tokens[2])) {
      return { baseTitle: base, colour: tokens[4], size: canonicalSize(tokens[2]) };
    }
    return { baseTitle: name, colour: "", size: "" };
  }
  const truncated = name.match(/^(.*),\s*([A-Za-z0-9 ]+)$/);
  if (truncated && SIZE_RE.test(truncated[2])) {
    return { baseTitle: truncated[1].trim(), colour: "", size: canonicalSize(truncated[2]) };
  }
  return { baseTitle: name, colour: "", size: "" };
}

/* -------------------------------------------------------------- catalog -- */

interface CatalogInfo {
  images: string[];
  brand: string;
  productType: string;
  classification: string;
  colour: string;
  size: string;
}

interface CatalogItemsResponse {
  items?: Array<{
    asin?: string;
    images?: Array<{
      marketplaceId?: string;
      images?: Array<{ variant?: string; link?: string; width?: number; height?: number }>;
    }>;
    summaries?: Array<{
      marketplaceId?: string;
      brand?: string;
      colour?: string;
      color?: string;
      size?: string;
      itemClassification?: string;
    }>;
    productTypes?: Array<{ marketplaceId?: string; productType?: string }>;
  }>;
}

/**
 * Batched lookup — 20 ASINs per call, which is the endpoint's page cap and
 * dramatically cheaper than the per-ASIN getCatalogItem route the older script
 * used. Best-effort: a failed batch is logged and skipped rather than aborting
 * a run that may span thousands of listings.
 */
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
      const group =
        item.images?.find((g) => g.marketplaceId === ctx.marketplaceId) ?? item.images?.[0];

      // Keep the widest render of each variant, then order MAIN first so the
      // first URL is always the hero shot.
      const byVariant = new Map<string, { link: string; width: number }>();
      for (const img of group?.images ?? []) {
        if (!img.link || !img.variant) continue;
        const seen = byVariant.get(img.variant);
        if (!seen || (img.width ?? 0) > seen.width) {
          byVariant.set(img.variant, { link: img.link, width: img.width ?? 0 });
        }
      }
      const ordered = ["MAIN", "PT01", "PT02", "PT03", "PT04", "PT05"];
      const preferred = ordered.map((v) => byVariant.get(v)?.link).filter((l): l is string => !!l);
      const images = preferred.length ? preferred : [...byVariant.values()].map((v) => v.link);

      const summary =
        item.summaries?.find((s) => s.marketplaceId === ctx.marketplaceId) ?? item.summaries?.[0];
      const productType =
        (item.productTypes?.find((p) => p.marketplaceId === ctx.marketplaceId) ?? item.productTypes?.[0])
          ?.productType ?? "";

      out.set(item.asin, {
        images,
        brand: summary?.brand ?? "",
        productType,
        classification: summary?.itemClassification ?? "",
        colour: summary?.colour ?? summary?.color ?? "",
        size: summary?.size ?? "",
      });
    }

    const done = Math.min(i + 20, unique.length);
    console.log(`  ${done}/${unique.length}`);
    await sleep(600); // endpoint is documented at ~2 req/sec
  }
  return out;
}

/* ----------------------------------------------------------------- main -- */

async function main() {
  const outPath = process.argv[2] ?? path.join("tmp", "amazon-listings-raw.xlsx");

  // Credentials live per-account in the OMS database, not in .env — the same
  // lookup scripts/amazon-to-paribelle.ts uses.
  const { db } = await import("../src/db");
  const { channelAccounts } = await import("../src/db/schema");
  const { eq } = await import("drizzle-orm");
  const accounts = await db.select().from(channelAccounts).where(eq(channelAccounts.channel, "amazon"));
  const account =
    accounts.find((a) => String((a.credentials as any)?.refreshToken ?? "").startsWith("Atzr|")) ?? accounts[0];
  if (!account) throw new Error("No Amazon channel account found in the OMS database.");

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

  console.log(`\nRequesting ${LISTINGS_REPORT}...`);
  const reportId = await requestListingsReport(ctx);
  console.log(`  reportId ${reportId}`);
  const documentId = await pollReport(ctx, reportId);
  console.log(`  documentId ${documentId}`);
  const tsv = await downloadReport(ctx, documentId);

  const rows = parseTsv(tsv);
  console.log(`\n${rows.length} listing rows`);
  const statuses = new Map<string, number>();
  for (const r of rows) statuses.set(r.status || "(blank)", (statuses.get(r.status || "(blank)") ?? 0) + 1);
  console.log("By status:", [...statuses].map(([s, n]) => `${s}=${n}`).join(", "));

  const catalog = await fetchCatalog(ctx, rows.map((r) => r.asin1));

  // Every report column, in the order Amazon emitted it, then the enriched
  // ones. Nothing dropped — this is the sheet the cleanup pass works from.
  const reportColumns = Object.keys(rows[0] ?? {});
  const sheetRows = rows.map((row) => {
    const info = catalog.get(row.asin1);
    const parsed = parseListing(row["item-name"] ?? "");
    return {
      ...row,
      "_Brand": info?.brand ?? "",
      "_ProductType": info?.productType ?? "",
      "_Classification": info?.classification ?? "",
      "_CatalogColour": info?.colour ?? "",
      "_CatalogSize": info?.size ?? "",
      "_ParsedBaseTitle": parsed.baseTitle,
      "_ParsedColour": parsed.colour,
      "_ParsedSize": parsed.size,
      "_Images": (info?.images ?? []).join(", "),
      "_ImageCount": info?.images?.length ?? 0,
    };
  });

  const columns = [
    ...reportColumns,
    "_Brand", "_ProductType", "_Classification", "_CatalogColour", "_CatalogSize",
    "_ParsedBaseTitle", "_ParsedColour", "_ParsedSize", "_Images", "_ImageCount",
  ];

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows, { header: columns }), "Listings");
  XLSX.writeFile(wb, outPath);

  const withImages = sheetRows.filter((r) => r._ImageCount > 0).length;
  const types = new Map<string, number>();
  for (const r of sheetRows) types.set(r._ProductType || "(unknown)", (types.get(r._ProductType || "(unknown)") ?? 0) + 1);

  console.log(`\nWrote ${outPath}`);
  console.log(`  ${sheetRows.length} rows · ${columns.length} columns`);
  console.log(`  ${withImages}/${sheetRows.length} have images`);
  console.log("  Product types:", [...types].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}=${n}`).join(", "));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
