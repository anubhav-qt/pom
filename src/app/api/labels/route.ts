import { NextResponse } from "next/server";
import { z } from "zod";

import { currentUser } from "@/lib/auth";
import { buildLabelSheet } from "@/lib/labels";

// pdf-lib and the channel adapters need the Node runtime, not the edge one.
export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  orderIds: z.array(z.number().int().positive()).min(1).max(200),
  crop: z.boolean().optional(),
});

export async function POST(request: Request) {
  if (!(await currentUser())) {
    return new NextResponse("Not signed in", { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return new NextResponse("Select between 1 and 200 orders.", { status: 400 });
  }

  try {
    const { pdf, included, missing } = await buildLabelSheet({
      orderIds: parsed.data.orderIds,
      cropToLabel: parsed.data.crop ?? false,
    });

    if (included.length === 0) {
      return new NextResponse(
        missing[0]?.reason ?? "No labels could be produced for the selected orders.",
        { status: 422 },
      );
    }

    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="labels-${included.length}.pdf"`,
        // Read by the queue so the packer is told what was left out.
        "x-labels-missing": String(missing.length),
      },
    });
  } catch (err) {
    return new NextResponse(err instanceof Error ? err.message : "Label build failed", {
      status: 500,
    });
  }
}
