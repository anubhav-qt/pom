import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { getJob, isWorking, removePhoto, saveFile } from "@/lib/reels/jobs";
import { MAX_PHOTOS, MAX_VIDEO_BYTES, VIDEO_CHUNK_BYTES } from "@/lib/reels/types";

export const runtime = "nodejs";

/** Vercel refuses request bodies over 4.5 MB, so every file (or video chunk) comes on its own. */
const MAX_BODY = 4.4 * 1024 * 1024;

/**
 * One upload: `?kind=photo|thumb|video&idx=N&name=...` with the raw bytes as
 * the body. Photos arrive already resized by the browser; a video arrives in
 * numbered chunks and is joined back together when the job runs. Photos can
 * be added between renders too (the next render picks again), just not while
 * one is running.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return new NextResponse("Not signed in", { status: 401 });
  const id = Number((await params).id);
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind");
  const idx = Number(url.searchParams.get("idx"));
  const name = (url.searchParams.get("name") ?? "").slice(0, 200);

  if (!Number.isInteger(id) || id <= 0) return new NextResponse("Not found", { status: 404 });
  if (kind !== "photo" && kind !== "thumb" && kind !== "video") {
    return NextResponse.json({ error: "Unknown upload kind." }, { status: 400 });
  }
  const limit = kind === "video" ? Math.ceil(MAX_VIDEO_BYTES / VIDEO_CHUNK_BYTES) : MAX_PHOTOS;
  if (!Number.isInteger(idx) || idx < 0 || idx >= limit) {
    return NextResponse.json({ error: "Too many files for one reel." }, { status: 400 });
  }

  const job = await getJob(id);
  if (!job) return new NextResponse("Not found", { status: 404 });
  if (isWorking(job)) return NextResponse.json({ error: "Wait for this reel to finish first." }, { status: 409 });
  if (kind === "video" && job.status !== "uploading") {
    return NextResponse.json({ error: "This reel has already started." }, { status: 409 });
  }
  if ((job.kind === "video") !== (kind === "video")) {
    return NextResponse.json({ error: "A reel is made from photos or from one video, not both." }, { status: 400 });
  }

  const bytes = Buffer.from(await request.arrayBuffer());
  if (bytes.length === 0) return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  if (bytes.length > MAX_BODY) return NextResponse.json({ error: "That file is too large." }, { status: 413 });
  if (kind !== "video" && !(bytes[0] === 0xff && bytes[1] === 0xd8)) {
    return NextResponse.json({ error: "Photos must arrive as JPEG." }, { status: 400 });
  }

  await saveFile(id, kind, idx, name, bytes);
  return NextResponse.json({ ok: true });
}

/** Take a photo out: `?idx=N`. The next render picks from what is left. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return new NextResponse("Not signed in", { status: 401 });
  const id = Number((await params).id);
  const idx = Number(new URL(request.url).searchParams.get("idx"));
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(idx)) return new NextResponse("Not found", { status: 404 });

  const job = await getJob(id);
  if (!job) return new NextResponse("Not found", { status: 404 });
  if (isWorking(job)) return NextResponse.json({ error: "Wait for this reel to finish first." }, { status: 409 });
  await removePhoto(id, idx);
  return NextResponse.json({ ok: true });
}
