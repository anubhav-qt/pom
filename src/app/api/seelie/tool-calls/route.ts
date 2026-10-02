import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { decideToolCall } from "@/lib/seelie/engine";
import { failure, unauthorized } from "@/lib/seelie/http";

export const runtime = "nodejs";

/** Approve or deny a change: `{ runId, callId, approve, alwaysThisChat? }`. */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const body = (await request.json().catch(() => null)) as
    | { runId?: unknown; callId?: unknown; approve?: unknown; alwaysThisChat?: unknown }
    | null;
  if (typeof body?.runId !== "string" || typeof body.callId !== "string" || typeof body.approve !== "boolean") {
    return NextResponse.json({ error: "Send { runId, callId, approve }." }, { status: 400 });
  }
  try {
    const res = await decideToolCall(user, {
      runId: body.runId,
      callId: body.callId,
      approve: body.approve,
      alwaysThisChat: body.alwaysThisChat === true,
    });
    return NextResponse.json(res);
  } catch (err) {
    return failure(err);
  }
}
