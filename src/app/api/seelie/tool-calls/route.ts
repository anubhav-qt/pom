import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { decideToolCall } from "@/lib/seelie/engine";
import { failure, unauthorized } from "@/lib/seelie/http";
import type { ApprovalEdits } from "@/lib/seelie/types";

export const runtime = "nodejs";

/** What the card may change before a yes; anything else in `edits` is dropped. */
function editsFrom(v: unknown): ApprovalEdits | null {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  const out: ApprovalEdits = {};
  if (typeof e.caption === "string") out.caption = e.caption.slice(0, 2200);
  if (typeof e.shareToFeed === "boolean") out.shareToFeed = e.shareToFeed;
  if (typeof e.budget === "number" && Number.isFinite(e.budget)) out.budget = e.budget;
  if (typeof e.days === "number" && Number.isInteger(e.days)) out.days = e.days;
  if (Array.isArray(e.lookIds)) out.lookIds = e.lookIds.filter((x): x is string => typeof x === "string").slice(0, 12);
  return Object.keys(out).length ? out : null;
}

/** Approve or deny a change: `{ runId, callId, approve, edits? }` (edits: what the owner changed on the card). */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const body = (await request.json().catch(() => null)) as { runId?: unknown; callId?: unknown; approve?: unknown; edits?: unknown } | null;
  if (typeof body?.runId !== "string" || typeof body.callId !== "string" || typeof body.approve !== "boolean") {
    return NextResponse.json({ error: "Send { runId, callId, approve }." }, { status: 400 });
  }
  try {
    const res = await decideToolCall(user, { runId: body.runId, callId: body.callId, approve: body.approve, edits: editsFrom(body.edits) });
    return NextResponse.json(res);
  } catch (err) {
    return failure(err);
  }
}
