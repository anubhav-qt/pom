/**
 * One-off: turn an Amazon Seller Central "All Listings Report" (TSV) into a
 * Paribelle products.xlsx + ZIP, matching marketplace-backend's
 * ProductsExcelService.importSimplePhysicalZip format exactly (header-name
 * driven, so sheet column order doesn't matter).
 *
 * Images: the report's own image-url column is blank (Amazon stopped
 * populating it), so main product images are fetched live from SP-API
 * Catalog Items by ASIN and written into the Images cell as full Amazon CDN
 * URLs — the importer passes http(s) URLs straight through, no download or
 * images/ folder needed.
 *
 *   npx tsx scripts/amazon-to-paribelle.ts <path-to-report.txt> <output.zip>
 */
import { config } from "dotenv";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import * as XLSX from "xlsx";

config({ path: ".env.local" });
config({ path: ".env" });

const LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token";
const CATEGORY = "Kurtis"; // only apparel category that exists in Paribelle today

/* ------------------------------------------------------------- report --- */

interface Row {
  [key: string]: string;
}

function parseTsv(text: string): Row[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const cells = line.split("\t");
    const row: Row = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

const SIZE_RE = /^(XS|S|M|L|XL|2XL|3XL|4XL|5XL|6XL|XXL|XXXL|FREE ?SIZE|ONE ?SIZE)$/i;

function canonicalSize(s: string): string {
  const up = s.trim().toUpperCase().replace(/\s+/g, " ");
  if (up === "FREE SIZE" || up === "FREESIZE") return "Free Size";
  if (up === "ONE SIZE" || up === "ONESIZE") return "One Size";
  return up;
}

/** Pull { baseTitle, colour, size } out of an Amazon item-name using the
 *  patterns observed in this seller's catalogue:
 *    "<title> (Colour, Size)"                   — 2 tokens
 *    "<title> (IN, Alpha, Size, Regular, Colour)" — 5 tokens
 *    "<title...truncated>, Size"                — title hit Amazon's length
 *                                                  cap and lost its ")"
 *  Anything else: no size/colour info, treated as a single-variant product. */
function parseListing(name: string): { baseTitle: string; colour: string | null; size: string | null } {
  const parenMatch = name.match(/^(.*)\s*\(([^)]*)\)\s*$/);
  if (parenMatch) {
    const base = parenMatch[1].trim();
    const tokens = parenMatch[2].split(",").map((t) => t.trim());
    if (tokens.length === 2 && SIZE_RE.test(tokens[1])) {
      return { baseTitle: base, colour: tokens[0], size: canonicalSize(tokens[1]) };
    }
    if (tokens.length === 5 && SIZE_RE.test(tokens[2])) {
      return { baseTitle: base, colour: tokens[4], size: canonicalSize(tokens[2]) };
    }
    // Unrecognised bracket shape — keep the bracket as part of the name so
    // nothing is silently dropped.
    return { baseTitle: name, colour: null, size: null };
  }

  const truncated = name.match(/^(.*),\s*([A-Za-z0-9 ]+)$/);
  if (truncated && SIZE_RE.test(truncated[2])) {
    return { baseTitle: truncated[1].trim(), colour: null, size: canonicalSize(truncated[2]) };
  }

  return { baseTitle: name, colour: null, size: null };
}

/* --------------------------------------------------------- SP-API auth --- */

async function getAccessToken(refreshToken: string, clientId: string, clientSecret: string): Promise<string> {
  const res = await fetch(LWA_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`LWA token refresh failed: ${res.status} ${body}`);
  return (JSON.parse(body) as { access_token: string }).access_token;
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

interface CatalogImage {
  images: Array<{ variant: string; link: string; height: number; width: number }>;
}

async function fetchCatalogImages(
  asin: string,
  endpoint: string,
  marketplaceId: string,
  accessToken: string,
): Promise<string[]> {
  const url = new URL(`/catalog/2022-04-01/items/${encodeURIComponent(asin)}`, endpoint);
  url.searchParams.set("marketplaceIds", marketplaceId);
  url.searchParams.set("includedData", "images");

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      headers: { "x-amz-access-token": accessToken },
    });
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 8000));
      continue;
    }
    if (res.status === 404) return [];
    const text = await res.text();
    if (!res.ok) {
      console.warn(`  [catalog] ${asin} -> ${res.status}: ${text.slice(0, 200)}`);
      return [];
    }
    const json = JSON.parse(text) as { images?: Array<CatalogImage & { marketplaceId: string }> };
    const forMarketplace = json.images?.find((i) => i.marketplaceId === marketplaceId) ?? json.images?.[0];
    if (!forMarketplace) return [];

    const byVariant = new Map<string, { link: string; width: number }>();
    for (const img of forMarketplace.images) {
      const existing = byVariant.get(img.variant);
      if (!existing || img.width > existing.width) byVariant.set(img.variant, { link: img.link, width: img.width });
    }

    const ordered = ["MAIN", "PT01", "PT02", "PT03"];
    const links = ordered.map((v) => byVariant.get(v)?.link).filter((l): l is string => !!l);
    return links.length ? links : [...byVariant.values()].map((v) => v.link).slice(0, 3);
  }
  return [];
}

/* ---------------------------------------------------------------- zip --- */

/** Minimal STORE-method (uncompressed) ZIP writer — good enough for a single
 *  small xlsx entry and avoids adding a dependency this repo doesn't have. */
function buildZip(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  const crc32Table = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crc32Table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8); // store, no compression
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + entry.data.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, end]);
}

/* --------------------------------------------------------------- main --- */

async function main() {
  const [reportPath, outPath] = process.argv.slice(2);
  if (!reportPath || !outPath) {
    console.error("usage: tsx scripts/amazon-to-paribelle.ts <report.txt> <output.zip>");
    process.exit(1);
  }

  console.log(`Reading ${reportPath}`);
  const rows = parseTsv(fs.readFileSync(reportPath, "utf8"));
  const active = rows.filter((r) => r.status === "Active");
  console.log(`${rows.length} rows total, ${active.length} Active`);

  // ── group into products ────────────────────────────────────────────────
  interface Listing {
    row: Row;
    baseTitle: string;
    colour: string | null;
    size: string | null;
  }
  interface Group {
    productCode: string;
    baseTitle: string;
    colour: string | null;
    listings: Listing[];
  }

  const groups = new Map<string, Group>();
  let seq = 0;
  for (const row of active) {
    const parsed = parseListing(row["item-name"]);
    const key = `${parsed.baseTitle.trim().toLowerCase()}|${(parsed.colour ?? "").trim().toLowerCase()}`;
    let group = groups.get(key);
    if (!group) {
      seq += 1;
      group = {
        productCode: `PBA-${String(seq).padStart(4, "0")}`,
        baseTitle: parsed.baseTitle,
        colour: parsed.colour,
        listings: [],
      };
      groups.set(key, group);
    }
    group.listings.push({ row, baseTitle: parsed.baseTitle, colour: parsed.colour, size: parsed.size });
  }
  console.log(`Grouped into ${groups.size} products`);

  // ── fetch catalog images per unique ASIN ───────────────────────────────
  const account = await (async () => {
    const { db } = await import("../src/db");
    const { channelAccounts } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    const accounts = await db.select().from(channelAccounts).where(eq(channelAccounts.channel, "amazon"));
    return accounts.find((a) => String((a.credentials as any)?.refreshToken ?? "").startsWith("Atzr|")) ?? accounts[0];
  })();
  if (!account) throw new Error("No Amazon channel account found in the OMS database.");

  const creds = account.credentials as any;
  const clientId = creds?.clientId ?? process.env.AMAZON_LWA_CLIENT_ID;
  const clientSecret = creds?.clientSecret ?? process.env.AMAZON_LWA_CLIENT_SECRET;
  const marketplaceId = creds?.marketplaceId ?? process.env.AMAZON_MARKETPLACE_ID ?? "A21TJRUUN4KGV";
  const endpoint = creds?.endpoint ?? process.env.AMAZON_SPAPI_ENDPOINT ?? "https://sellingpartnerapi-eu.amazon.com";
  if (!clientId || !clientSecret || !creds?.refreshToken) {
    throw new Error("Amazon account is missing clientId/clientSecret/refreshToken.");
  }

  console.log(`Using channel account "${account.label}" (marketplace ${marketplaceId})`);
  let accessToken = await getAccessToken(creds.refreshToken, clientId, clientSecret);
  let tokenIssuedAt = Date.now();

  const uniqueAsins = [...new Set(active.map((r) => r.asin1).filter(Boolean))];
  console.log(`Fetching catalog images for ${uniqueAsins.length} unique ASINs...`);

  const imagesByAsin = new Map<string, string[]>();
  let done = 0;
  for (const asin of uniqueAsins) {
    if (Date.now() - tokenIssuedAt > 50 * 60 * 1000) {
      accessToken = await getAccessToken(creds.refreshToken, clientId, clientSecret);
      tokenIssuedAt = Date.now();
    }
    const links = await fetchCatalogImages(asin, endpoint, marketplaceId, accessToken);
    imagesByAsin.set(asin, links);
    done += 1;
    if (done % 25 === 0 || done === uniqueAsins.length) {
      console.log(`  ${done}/${uniqueAsins.length} (${links.length ? "ok" : "no image"})`);
    }
    await sleep(550); // ~2 req/sec, catalog items' documented rate
  }
  const withImages = [...imagesByAsin.values()].filter((v) => v.length > 0).length;
  console.log(`Got images for ${withImages}/${uniqueAsins.length} ASINs`);

  // ── build sheet rows ────────────────────────────────────────────────────
  const productRows: any[] = [];
  const variantRows: any[] = [];
  const usedVariantCodes = new Set<string>();

  for (const group of groups.values()) {
    const first = group.listings[0].row;
    const prices = group.listings.map((l) => parseFloat(l.row.price || "0") || 0);
    const price = Math.min(...prices);
    const mrp = parseFloat(first["maximum-retail-price"] || "0") || 0;
    const compareAtPrice = mrp > price ? mrp : "";

    const images =
      group.listings.map((l) => imagesByAsin.get(l.row.asin1) ?? []).find((imgs) => imgs.length > 0) ?? [];
    const hasVariants = group.listings.length > 1 && group.listings.some((l) => l.size);

    productRows.push({
      "Product Code": group.productCode,
      "Product Name": group.colour ? `${group.baseTitle} — ${group.colour}` : group.baseTitle,
      "Category": CATEGORY,
      "Price": price,
      "Stock": hasVariants ? "" : parseInt(first.quantity || "0", 10) || 0,
      "Images": images.join(", "),
      "Description": first["item-description"] || "",
      "Compare At Price": compareAtPrice,
      "Attributes": group.colour ? `Colour: ${group.colour}` : "",
    });

    if (hasVariants) {
      for (const listing of group.listings) {
        if (!listing.size) continue; // shouldn't happen given hasVariants check, but stay safe
        let variantCode = `${group.productCode}-${listing.size.replace(/\s+/g, "")}`;
        let n = 2;
        while (usedVariantCodes.has(variantCode)) variantCode = `${group.productCode}-${listing.size.replace(/\s+/g, "")}-${n++}`;
        usedVariantCodes.add(variantCode);

        const vPrice = parseFloat(listing.row.price || "0") || 0;
        const vMrp = parseFloat(listing.row["maximum-retail-price"] || "0") || 0;

        variantRows.push({
          "Product Code": group.productCode,
          "Variant Code": variantCode,
          "Attributes": `Size: ${listing.size}`,
          "Price": vPrice,
          "Compare At Price": vMrp > vPrice ? vMrp : "",
          "Stock": parseInt(listing.row.quantity || "0", 10) || 0,
          "Active": "YES",
        });
      }
    }
  }

  console.log(`${productRows.length} product rows, ${variantRows.length} variant rows`);

  // ── write workbook ──────────────────────────────────────────────────────
  const productColumns = [
    "Product Code", "Product Name", "Category", "Price", "Stock",
    "Images", "Description", "Compare At Price", "Attributes",
  ];
  const variantColumns = [
    "Product Code", "Variant Code", "Attributes", "Price",
    "Compare At Price", "Stock", "Active",
  ];

  const wb = XLSX.utils.book_new();
  const productSheet = XLSX.utils.json_to_sheet(productRows, { header: productColumns });
  XLSX.utils.book_append_sheet(wb, productSheet, "Products");
  if (variantRows.length > 0) {
    const variantSheet = XLSX.utils.json_to_sheet(variantRows, { header: variantColumns });
    XLSX.utils.book_append_sheet(wb, variantSheet, "Variants");
  }

  const xlsxBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const zipBuffer = buildZip([{ name: "products.xlsx", data: xlsxBuffer }]);
  fs.writeFileSync(outPath, zipBuffer);
  console.log(`Wrote ${outPath} (${(zipBuffer.length / 1024).toFixed(1)} KB)`);

  // ── warnings ────────────────────────────────────────────────────────────
  const noImage = [...groups.values()].filter((g) => (imagesByAsin.get(g.listings[0].row.asin1) ?? []).length === 0);
  if (noImage.length) {
    console.log(`\n${noImage.length} products have no image (catalog lookup returned none):`);
    noImage.slice(0, 20).forEach((g) => console.log(`  ${g.productCode}: ${g.baseTitle}`));
    if (noImage.length > 20) console.log(`  ...and ${noImage.length - 20} more`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
