import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { ParibelleActionError, paribelleLabelFor } from "@/lib/paribelle";

// pdf-lib needs the Node runtime.
export const runtime = "nodejs";

/** A paribelle.in order's shipping label, opened from the order's popup. */
export async function GET(_request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  if (!(await currentUser())) return new NextResponse("Not signed in", { status: 401 });
  const orderId = Number((await params).orderId);
  if (!Number.isInteger(orderId) || orderId <= 0) return new NextResponse("No such order.", { status: 400 });

  try {
    const { orderNumber, pdf } = await paribelleLabelFor(orderId);
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="label-${orderNumber}.pdf"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    const status = err instanceof ParibelleActionError ? 422 : 502;
    return new NextResponse(err instanceof Error ? err.message : "The label couldn't be made.", { status });
  }
}
