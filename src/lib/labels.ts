import { PDFDocument } from "pdf-lib";
import { eq, inArray } from "drizzle-orm";

import { adapterFor } from "@/channels";
import { db } from "@/db";
import { channelAccounts, orders, shipments } from "@/db/schema";

export interface BuildLabelsOptions {
  orderIds: number[];
  /**
   * Trim each page down to the shipping label itself, dropping the tax-invoice
   * section Meesho and Flipkart print underneath. Saves roughly half the
   * thermal roll, which is the single biggest running cost at the packing bench.
   */
  cropToLabel?: boolean;
}

export interface BuildLabelsResult {
  pdf: Buffer;
  included: number[];
  /** Orders we could not produce a label for, with the reason shown to the user. */
  missing: { orderId: number; externalOrderId: string; reason: string }[];
}

/**
 * Produce one print-ready PDF for a set of orders across any mix of channels.
 *
 * Page order follows `orderIds` exactly. That matters: the picklist is printed
 * in the same order, so the packer works down two stacks that line up instead
 * of hunting for a matching label on every parcel.
 */
export async function buildLabelSheet({
  orderIds,
  cropToLabel = false,
}: BuildLabelsOptions): Promise<BuildLabelsResult> {
  if (orderIds.length === 0) {
    const empty = await PDFDocument.create();
    return { pdf: Buffer.from(await empty.save()), included: [], missing: [] };
  }

  const rows = await db
    .select({
      orderId: orders.id,
      externalOrderId: orders.externalOrderId,
      channel: orders.channel,
      accountId: orders.channelAccountId,
      labelPdf: shipments.labelPdf,
    })
    .from(orders)
    .leftJoin(shipments, eq(shipments.orderId, orders.id))
    .where(inArray(orders.id, orderIds));

  const byId = new Map(rows.map((r) => [r.orderId, r]));
  const missing: BuildLabelsResult["missing"] = [];

  // Pull labels from the live channels in bulk, one call per account rather
  // than one per order.
  const needFetch = new Map<number, string[]>();
  for (const r of rows) {
    if (r.labelPdf) continue;
    const list = needFetch.get(r.accountId) ?? [];
    list.push(r.externalOrderId);
    needFetch.set(r.accountId, list);
  }

  const fetched = new Map<string, Buffer>();
  for (const [accountId, externalIds] of needFetch) {
    const [account] = await db
      .select()
      .from(channelAccounts)
      .where(eq(channelAccounts.id, accountId))
      .limit(1);
    if (!account) continue;

    const adapter = adapterFor(account);
    if (!adapter.supportsLabelFetch) continue;

    try {
      for (const label of await adapter.fetchLabels(externalIds)) {
        fetched.set(`${accountId}:${label.externalOrderId}`, label.pdf);
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      for (const externalOrderId of externalIds) {
        const row = rows.find(
          (r) => r.accountId === accountId && r.externalOrderId === externalOrderId,
        );
        if (row) missing.push({ orderId: row.orderId, externalOrderId, reason });
      }
    }
  }

  const merged = await PDFDocument.create();
  const included: number[] = [];

  for (const orderId of orderIds) {
    const row = byId.get(orderId);
    if (!row) continue;
    if (missing.some((m) => m.orderId === orderId)) continue;

    const bytes =
      (row.labelPdf ? Buffer.from(row.labelPdf) : undefined) ??
      fetched.get(`${row.accountId}:${row.externalOrderId}`);

    if (!bytes) {
      missing.push({
        orderId,
        externalOrderId: row.externalOrderId,
        reason:
          row.channel === "meesho"
            ? "No label imported — upload the Meesho label PDF for this batch"
            : "Channel returned no label (has the shipment been created?)",
      });
      continue;
    }

    try {
      const src = await PDFDocument.load(bytes);
      const pages = await merged.copyPages(src, src.getPageIndices());
      for (const page of pages) {
        if (cropToLabel) cropToLabelArea(page);
        merged.addPage(page);
      }
      included.push(orderId);
    } catch (err) {
      missing.push({
        orderId,
        externalOrderId: row.externalOrderId,
        reason: `Label PDF is unreadable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { pdf: Buffer.from(await merged.save()), included, missing };
}

/**
 * Marketplace labels put the shipping label on the upper portion of the page
 * and the tax invoice below. Rather than physically re-drawing the page we move
 * the crop box, which every printer honours and which is lossless — if the
 * fraction is ever wrong the original content is still there.
 */
const LABEL_FRACTION = 0.52;

function cropToLabelArea(page: import("pdf-lib").PDFPage) {
  const { width, height } = page.getSize();
  const keep = height * LABEL_FRACTION;
  page.setCropBox(0, height - keep, width, keep);
}
