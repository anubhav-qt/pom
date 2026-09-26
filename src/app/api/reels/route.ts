import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { createJob, songLibrary } from "@/lib/reels/jobs";

export const runtime = "nodejs";

/** The songs a reel can use, for the picker before anything is uploaded. */
export async function GET() {
  if (!(await currentUser())) return new NextResponse("Not signed in", { status: 401 });
  return NextResponse.json({ library: await songLibrary() }, { headers: { "cache-control": "no-store" } });
}

/** Start a reel: `{ kind: "photos" | "video" }`. The files follow, one request each. */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return new NextResponse("Not signed in", { status: 401 });

  const body = (await request.json().catch(() => null)) as { kind?: string } | null;
  if (body?.kind !== "photos" && body?.kind !== "video") {
    return NextResponse.json({ error: "Say whether this reel is from photos or a video." }, { status: 400 });
  }
  const id = await createJob(body.kind, user.id);
  return NextResponse.json({ id });
}
