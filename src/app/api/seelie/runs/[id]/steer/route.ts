import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { steerRun } from "@/lib/seelie/engine";
import { failure, unauthorized } from "@/lib/seelie/http";
import type { ImageInput } from "@/lib/seelie/types";

export const runtime = "nodejs";

/**
 * Tell Seelie something while it works: `{ text, images? }`. 409 when another process holds
 * the reply (or it's ending): the screen keeps the message and sends it once the reply ends.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const body = (await request.json().catch(() => null)) as { text?: unknown; images?: unknown } | null;
  if (typeof body?.text !== "string") return NextResponse.json({ error: "Send { text }." }, { status: 400 });
  const images = Array.isArray(body.images)
    ? body.images.filter((i): i is ImageInput => !!i && typeof i === "object" && typeof (i as ImageInput).data === "string" && typeof (i as ImageInput).mimeType === "string")
    : [];
  try {
    return NextResponse.json(await steerRun(user, (await params).id, { text: body.text, images }));
  } catch (err) {
    return failure(err);
  }
}
