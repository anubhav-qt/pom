import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { db } from "@/db";
import { labelPrintRuns } from "@/db/schema";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";

/** A finished sheet, shown inline so it opens in the browser's own PDF viewer. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return new NextResponse("Not signed in", { status: 401 });

  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return new NextResponse("Not found", { status: 404 });

  const [run] = await db
    .select({ pdf: labelPrintRuns.pdf, createdAt: labelPrintRuns.createdAt })
    .from(labelPrintRuns)
    .where(eq(labelPrintRuns.id, id))
    .limit(1);
  if (!run) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(new Uint8Array(run.pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `inline; filename="labels-${id}.pdf"`,
      // Customer addresses are on these: never cache them anywhere shared.
      "cache-control": "private, max-age=3600",
    },
  });
}
