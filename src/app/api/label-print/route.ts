import { NextResponse } from "next/server";

import { db } from "@/db";
import { labelPrintRuns } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { NoLabelsError, buildLabelSheets } from "@/lib/label-print";
import { withBasePath } from "@/lib/base-path";

// pdf-lib and pdfjs need the Node runtime, not the edge one.
export const runtime = "nodejs";
export const maxDuration = 60;

/** Vercel rejects request bodies over 4.5 MB before we ever see them. */
const MAX_TOTAL_BYTES = 4.4 * 1024 * 1024;
const MAX_FILES = 20;

const isPdf = (b: Uint8Array) => b.length > 5 && String.fromCharCode(...b.slice(0, 5)) === "%PDF-";

/**
 * Upload PDFs (multipart field `files`, any number, any names) and get back one
 * four-up sheet. The result is stored, and `url` opens it in a new tab.
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return new NextResponse("Not signed in", { status: 401 });

  const form = await request.formData().catch(() => null);
  const uploads = (form?.getAll("files") ?? []).filter((f): f is File => f instanceof File);
  if (uploads.length === 0) return NextResponse.json({ error: "Add at least one PDF." }, { status: 400 });
  if (uploads.length > MAX_FILES) {
    return NextResponse.json({ error: `Add at most ${MAX_FILES} PDFs at a time.` }, { status: 400 });
  }
  if (uploads.reduce((n, f) => n + f.size, 0) > MAX_TOTAL_BYTES) {
    return NextResponse.json({ error: "These PDFs are too large to process in one go. Split them into two runs." }, { status: 413 });
  }

  const files = await Promise.all(
    uploads.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })),
  );
  const notPdf = files.find((f) => !isPdf(f.data));
  if (notPdf) return NextResponse.json({ error: `"${notPdf.name}" is not a PDF.` }, { status: 400 });

  try {
    const result = await buildLabelSheets(files, {
      stamp: form?.get("stamp") !== "0",
      cutGuides: form?.get("cutGuides") === "1",
    });

    const [run] = await db
      .insert(labelPrintRuns)
      .values({
        createdBy: user.id,
        pdf: Buffer.from(result.pdf),
        labelCount: result.labels.length,
        sheetCount: result.sheets,
        sources: result.files,
        labels: result.labels.map((l) => ({
          file: files[l.fileIndex].name,
          page: l.pageIndex + 1,
          platform: l.platform,
          orderId: l.orderId,
          products: l.products,
        })),
        duplicateOrderIds: result.duplicates,
        framesRemoved: result.framesRemoved,
        unstamped: result.unstamped,
      })
      .returning({ id: labelPrintRuns.id });

    return NextResponse.json({
      id: run.id,
      url: withBasePath(`/api/label-print/${run.id}`),
      labels: result.labels.length,
      sheets: result.sheets,
      files: result.files,
      duplicates: result.duplicates,
      framesRemoved: result.framesRemoved,
      unstamped: result.unstamped,
    });
  } catch (err) {
    if (err instanceof NoLabelsError) {
      return NextResponse.json({ error: err.message, files: err.files }, { status: 422 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not build the label sheet." },
      { status: 500 },
    );
  }
}
