import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { FeedbackError, saveFeedback } from "@/lib/reels/feedback";

export const runtime = "nodejs";

/** "Do you like this reel?": `{ version, liked }` for the render the person watched. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return new NextResponse("Not signed in", { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return new NextResponse("Not found", { status: 404 });

  const body = (await request.json().catch(() => null)) as { version?: unknown; liked?: unknown } | null;
  if (typeof body?.liked !== "boolean" || !Number.isInteger(body.version)) {
    return NextResponse.json({ error: "Say yes or no, for one version of the reel." }, { status: 400 });
  }

  try {
    await saveFeedback(id, body.version as number, body.liked, user.id);
  } catch (e) {
    if (e instanceof FeedbackError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
  return NextResponse.json({ liked: body.liked });
}
