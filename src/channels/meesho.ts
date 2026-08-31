import { PDFDocument } from "pdf-lib";
import * as XLSX from "xlsx";

import type { ChannelAccount, OrderStatus } from "@/db/schema";

import {
  NotSupportedError,
  type CanonicalOrder,
  type CanonicalReturn,
  type ChannelAdapter,
  type FetchOrdersOptions,
  type FetchOrdersResult,
  type InventoryPushResult,
  type InventoryUpdate,
  type LabelResult,
} from "./types";

/**
 * Meesho has no self-serve supplier API — credentials are issued only to
 * onboarded integration partners. So this adapter is a *file importer*: the
 * seller downloads the order sheet and the combined label PDF from the Meesho
 * supplier panel and drops both here.
 *
 * It implements the same ChannelAdapter interface as the live channels on
 * purpose. If Meesho API access is ever granted, only this file changes — the
 * sync engine, the packing UI and the label printer stay exactly as they are.
 */
export class MeeshoAdapter implements ChannelAdapter {
  readonly channel = "meesho" as const;
  readonly supportsLiveSync = false;
  readonly supportsInventoryPush = false;
  readonly supportsLabelFetch = false;

  constructor(private account: ChannelAccount) {}

  async fetchOrders(_opts: FetchOrdersOptions): Promise<FetchOrdersResult> {
    throw new NotSupportedError("meesho", "live order sync");
  }

  async fetchReturns(
    _opts: FetchOrdersOptions,
  ): Promise<{ returns: CanonicalReturn[]; syncedThrough: Date }> {
    throw new NotSupportedError("meesho", "live return sync");
  }

  /** Meesho labels live in the database — the print service reads them directly. */
  async fetchLabels(_ids: string[]): Promise<LabelResult[]> {
    throw new NotSupportedError("meesho", "label fetch");
  }

  async pushInventory(_updates: InventoryUpdate[]): Promise<InventoryPushResult[]> {
    throw new NotSupportedError("meesho", "inventory push");
  }
}

/* -------------------------------------------------------------------------- */
/* Order sheet import                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Meesho renames sheet columns fairly often and the same concept appears under
 * several headings across export types. Rather than pinning exact strings we
 * match on normalised aliases, so a column rename does not break the import.
 */
const COLUMN_ALIASES: Record<string, string[]> = {
  subOrderId: ["sub order no", "suborder no", "sub_order_no", "sub order id"],
  orderDate: ["order date", "order_date", "date"],
  status: ["reason for credit entry", "order status", "status", "sub order status"],
  sku: ["sku", "supplier sku", "sku id", "sku code"],
  productName: ["product name", "product_name", "item name"],
  size: ["size", "variation"],
  quantity: ["quantity", "qty"],
  price: [
    "supplier discounted price (incl gst and commision)",
    "supplier discounted price (incl gst and commission)",
    "supplier discounted price",
    "listing price (incl. gst)",
    "price",
  ],
  state: ["customer state", "state", "delivery state"],
  city: ["customer city", "city"],
  pincode: ["customer pincode", "pincode", "pin code"],
  awb: ["awb number", "awb", "tracking id", "tracking number"],
  courier: ["courier partner", "courier", "shipping partner"],
  dispatchBy: ["dispatch by date", "dispatch by", "ship by date"],
  packetId: ["packet id", "packet_id"],
};

function normalise(header: string) {
  return header.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Build header -> canonical-field map for whatever this particular export used. */
function mapHeaders(headers: string[]): Record<string, number> {
  const found: Record<string, number> = {};
  headers.forEach((h, i) => {
    const n = normalise(String(h ?? ""));
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      if (found[field] === undefined && aliases.includes(n)) found[field] = i;
    }
  });
  return found;
}

export interface MeeshoImportResult {
  orders: CanonicalOrder[];
  /** Headers we could not place — surfaced in the UI so a rename is visible. */
  unmappedColumns: string[];
  skippedRows: number;
}

/**
 * Parse a Meesho order export (XLSX or CSV) into canonical orders.
 *
 * One row is one *sub-order*, and a sub-order is what gets packed and labelled,
 * so each row becomes its own order rather than being grouped by parent order.
 */
export function parseMeeshoOrderSheet(file: Buffer): MeeshoImportResult {
  const wb = XLSX.read(file, { type: "buffer", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("The uploaded file has no sheets in it.");

  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
  if (rows.length < 2) throw new Error("The sheet has no data rows.");

  const headers = (rows[0] as unknown[]).map((h) => String(h ?? ""));
  const cols = mapHeaders(headers);

  if (cols.subOrderId === undefined) {
    throw new Error(
      `Could not find a "Sub Order No" column. Found: ${headers.filter(Boolean).join(", ")}`,
    );
  }

  const mappedIndices = new Set(Object.values(cols));
  const unmappedColumns = headers.filter((h, i) => h && !mappedIndices.has(i));

  const orders: CanonicalOrder[] = [];
  let skippedRows = 0;

  for (const raw of rows.slice(1)) {
    const row = raw as unknown[];
    const get = (field: string) =>
      cols[field] === undefined ? undefined : row[cols[field]];

    const subOrderId = String(get("subOrderId") ?? "").trim();
    if (!subOrderId) {
      skippedRows++;
      continue;
    }

    const sku = String(get("sku") ?? "").trim();
    const size = String(get("size") ?? "").trim();

    orders.push({
      externalOrderId: subOrderId,
      status: mapMeeshoStatus(String(get("status") ?? "")),
      orderedAt: toDate(get("orderDate")) ?? new Date(),
      buyerName: null, // Meesho masks buyer names in supplier exports.
      shipCity: str(get("city")),
      shipState: str(get("state")),
      shipPincode: str(get("pincode")),
      totalAmount: num(get("price")),
      isCod: false, // Meesho settles with the supplier directly; never seller-COD.
      dispatchBy: toDate(get("dispatchBy")) ?? null,
      items: [
        {
          externalSku: sku || "UNKNOWN",
          // Size is part of the identity of the thing to pick, so keep it visible.
          title: [str(get("productName")), size].filter(Boolean).join(" · ") || null,
          quantity: Number(get("quantity") ?? 1) || 1,
          unitPrice: num(get("price")),
        },
      ],
      shipment: {
        externalShipmentId: str(get("packetId")),
        courier: str(get("courier")),
        awb: str(get("awb")),
      },
      raw: Object.fromEntries(headers.map((h, i) => [h, row[i] ?? null])),
    });
  }

  return { orders, unmappedColumns, skippedRows };
}

function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s === "" || s.toLowerCase() === "nan" ? null : s;
}

function num(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n.toFixed(2) : null;
}

function toDate(v: unknown): Date | null {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Order matters here. "Ready to Ship" contains "ship", so the ready-to-pack
 * check has to run before the shipped one — otherwise every order waiting to be
 * packed is marked as already gone and disappears from the queue.
 */
function mapMeeshoStatus(s: string): OrderStatus {
  const n = s.trim().toLowerCase();
  if (n.includes("cancel")) return "cancelled";
  if (n.includes("rto")) return "rto";
  if (n.includes("return")) return "returned";
  if (n.includes("deliver")) return "delivered";
  if (n.includes("ready to ship") || n.includes("ready_to_ship")) return "ready_to_pack";
  if (n.includes("ship") || n.includes("dispatch")) return "shipped";
  return "new";
}

/* -------------------------------------------------------------------------- */
/* Label PDF splitting                                                        */
/* -------------------------------------------------------------------------- */

export interface SplitLabel {
  externalOrderId: string;
  pdf: Buffer;
}

export interface SplitLabelsResult {
  labels: SplitLabel[];
  /** Pages whose text matched no known sub-order id — usually tax invoices. */
  unmatchedPages: number[];
}

/**
 * Split Meesho's combined label PDF into one PDF per sub-order.
 *
 * Matching is done by searching each page's extracted text for a sub-order id
 * we already imported, rather than by guessing Meesho's id format or trusting
 * page order. That way a label sheet downloaded separately from the order sheet
 * still lines up, and a format change cannot silently mis-assign labels.
 */
export async function splitMeeshoLabels(
  file: Buffer,
  knownSubOrderIds: string[],
): Promise<SplitLabelsResult> {
  const pageTexts = await extractPageTexts(file);
  const source = await PDFDocument.load(file);

  // Longest ids first: some sub-order ids are prefixes of others, and a
  // shorter one would otherwise win on a page belonging to the longer.
  const ids = [...knownSubOrderIds].sort((a, b) => b.length - a.length);

  const labels: SplitLabel[] = [];
  const unmatchedPages: number[] = [];

  for (let i = 0; i < pageTexts.length; i++) {
    const haystack = pageTexts[i].replace(/\s+/g, "");
    const match = ids.find((id) => haystack.includes(id.replace(/\s+/g, "")));

    if (!match) {
      unmatchedPages.push(i + 1);
      continue;
    }

    const single = await PDFDocument.create();
    const [page] = await single.copyPages(source, [i]);
    single.addPage(page);
    labels.push({
      externalOrderId: match,
      pdf: Buffer.from(await single.save()),
    });
  }

  return { labels, unmatchedPages };
}

/**
 * Extract text per page with pdf.js. Loaded lazily and via the legacy build
 * because the modern ESM entry expects browser globals that do not exist in a
 * serverless Node runtime.
 */
async function extractPageTexts(file: Buffer): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(file),
    // No worker in Node, and no fetching of external font/cmap assets.
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  const texts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    texts.push(
      content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" "),
    );
    page.cleanup();
  }
  await doc.destroy();

  return texts;
}
