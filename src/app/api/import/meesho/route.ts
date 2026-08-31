import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";

import { parseMeeshoOrderSheet, splitMeeshoLabels } from "@/channels";
import { db } from "@/db";
import { channelAccounts, orders, shipments } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { ingestOrders } from "@/lib/sync";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Import a Meesho order sheet and (optionally) the matching combined label PDF.
 *
 * Both files come straight out of the Meesho supplier panel with no editing.
 * The sheet is authoritative for order data; labels are matched to orders by
 * searching each PDF page for a sub-order id, so the two files do not have to
 * be downloaded together or in the same order.
 */
export async function POST(request: Request) {
  if (!(await currentUser())) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const form = await request.formData();
  const accountId = Number(form.get("accountId"));
  const sheet = form.get("sheet");
  const labels = form.get("labels");

  const [account] = await db
    .select()
    .from(channelAccounts)
    .where(and(eq(channelAccounts.id, accountId), eq(channelAccounts.channel, "meesho")))
    .limit(1);

  if (!account) {
    return NextResponse.json({ error: "Pick a Meesho account first." }, { status: 400 });
  }

  const summary: Record<string, unknown> = {};

  /* ------------------------------------------------------------- orders -- */

  let subOrderIds: string[] = [];

  if (sheet instanceof File && sheet.size > 0) {
    try {
      const parsed = parseMeeshoOrderSheet(Buffer.from(await sheet.arrayBuffer()));
      const ingested = await ingestOrders(account, parsed.orders);

      subOrderIds = parsed.orders.map((o) => o.externalOrderId);
      summary.orders = {
        parsed: parsed.orders.length,
        written: ingested.written,
        skippedRows: parsed.skippedRows,
        unmappedSkus: ingested.unmappedSkus,
        // Surfaced so a Meesho column rename is visible immediately rather than
        // showing up as quietly missing data.
        unrecognisedColumns: parsed.unmappedColumns,
      };
    } catch (err) {
      return NextResponse.json(
        { error: `Order sheet: ${err instanceof Error ? err.message : String(err)}` },
        { status: 422 },
      );
    }
  }

  /* ------------------------------------------------------------- labels -- */

  if (labels instanceof File && labels.size > 0) {
    try {
      // Match against everything currently open on this account, not only the
      // rows in this upload — labels are often downloaded separately.
      if (subOrderIds.length === 0) {
        const open = await db
          .select({ externalOrderId: orders.externalOrderId })
          .from(orders)
          .where(
            and(
              eq(orders.channelAccountId, account.id),
              inArray(orders.status, ["new", "ready_to_pack", "packed"]),
            ),
          );
        subOrderIds = open.map((o) => o.externalOrderId);
      }

      const { labels: split, unmatchedPages } = await splitMeeshoLabels(
        Buffer.from(await labels.arrayBuffer()),
        subOrderIds,
      );

      let attached = 0;
      for (const label of split) {
        const [order] = await db
          .select({ id: orders.id })
          .from(orders)
          .where(
            and(
              eq(orders.channelAccountId, account.id),
              eq(orders.externalOrderId, label.externalOrderId),
            ),
          )
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
            .set({ labelPdf: label.pdf, labelFetchedAt: new Date() })
            .where(eq(shipments.id, existing.id));
        } else {
          await db.insert(shipments).values({
            orderId: order.id,
            labelPdf: label.pdf,
            labelFetchedAt: new Date(),
          });
        }

        // A label in hand means the parcel can be made up.
        await db
          .update(orders)
          .set({ status: "ready_to_pack", updatedAt: new Date() })
          .where(and(eq(orders.id, order.id), eq(orders.status, "new")));

        attached++;
      }

      summary.labels = {
        pagesMatched: split.length,
        attached,
        unmatchedPages,
      };
    } catch (err) {
      return NextResponse.json(
        { error: `Label PDF: ${err instanceof Error ? err.message : String(err)}`, summary },
        { status: 422 },
      );
    }
  }

  if (Object.keys(summary).length === 0) {
    return NextResponse.json({ error: "Upload an order sheet, a label PDF, or both." }, { status: 400 });
  }

  return NextResponse.json({ ok: true, summary });
}
