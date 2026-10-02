import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { stopRun } from "@/lib/seelie/engine";
import { failure, unauthorized } from "@/lib/seelie/http";

export const runtime = "nodejs";

/** Stop a reply (in whichever process is running it). */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();
  try {
    await stopRun(user, (await params).id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return failure(err);
  }
}
