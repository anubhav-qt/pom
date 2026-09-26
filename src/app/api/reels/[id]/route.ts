import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { jobView } from "@/lib/reels/jobs";

export const runtime = "nodejs";

/** Where a reel is up to. The screen polls this while it works. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return new NextResponse("Not signed in", { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return new NextResponse("Not found", { status: 404 });

  const view = await jobView(id);
  if (!view) return new NextResponse("Not found", { status: 404 });
  return NextResponse.json(view, { headers: { "cache-control": "no-store" } });
}
