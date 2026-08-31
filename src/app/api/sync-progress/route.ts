import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { getSyncProgress } from "@/lib/sync";

export const runtime = "nodejs";

/** Polled every ~600ms by the Settings page while a manual sync is running. */
export async function GET(request: Request) {
  if (!(await currentUser())) {
    return new NextResponse("Not signed in", { status: 401 });
  }

  const runId = Number(new URL(request.url).searchParams.get("runId"));
  if (!Number.isInteger(runId) || runId <= 0) {
    return new NextResponse("Missing or invalid runId", { status: 400 });
  }

  const progress = await getSyncProgress(runId);
  if (!progress) return new NextResponse("Run not found", { status: 404 });

  return NextResponse.json(progress);
}
