import { after, NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { getJob, isWorking, queueJob, runJob, type RunOptions } from "@/lib/reels/jobs";

export const runtime = "nodejs";
/**
 * The render runs after the response, inside this same invocation, so it gets
 * this route's time budget. A photo reel takes well under a minute; this is
 * the ceiling, not the expectation.
 */
export const maxDuration = 300;

/**
 * Make (or remake) the reel: `{ useAi, keep?, track?, layout?, repick? }`. Answers at once; the
 * screen polls `GET /api/reels/[id]` for progress.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return new NextResponse("Not signed in", { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return new NextResponse("Not found", { status: 404 });

  const job = await getJob(id);
  if (!job) return new NextResponse("Not found", { status: 404 });
  if (isWorking(job)) return NextResponse.json({ error: "This reel is already being made." }, { status: 409 });

  const body = (await request.json().catch(() => ({}))) as Partial<RunOptions>;
  const opts: RunOptions = {
    useAi: body.useAi !== false,
    keep: Array.isArray(body.keep) ? body.keep.filter((n) => Number.isInteger(n) && n >= 0) : undefined,
    track: body.track === "next" || (typeof body.track === "number" && Number.isInteger(body.track)) ? body.track : undefined,
    layout: body.layout === "landscape" ? "landscape" : "portrait",
    repick: body.repick === true,
  };

  await queueJob(id);
  after(() => runJob(id, opts));
  return NextResponse.json({ ok: true }, { status: 202 });
}
