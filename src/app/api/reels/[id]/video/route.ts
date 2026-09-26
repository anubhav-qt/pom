import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { videoSlice } from "@/lib/reels/jobs";
import { VIDEO_SLICE_BYTES } from "@/lib/reels/types";

export const runtime = "nodejs";

/**
 * The finished reel, in slices. A response never carries more than
 * VIDEO_SLICE_BYTES (Vercel caps a response at 4.5 MB), which suits a player:
 * it asks for byte ranges and keeps asking. `?silent=1` is the copy without
 * music; `?download=1` names the file for saving.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return new NextResponse("Not signed in", { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return new NextResponse("Not found", { status: 404 });

  const url = new URL(request.url);
  const silent = url.searchParams.get("silent") === "1";
  const range = /bytes=(\d+)-(\d*)/.exec(request.headers.get("range") ?? "");
  const start = range ? Number(range[1]) : 0;
  const wantEnd = range && range[2] ? Number(range[2]) : Infinity;
  const length = Math.max(1, Math.min(VIDEO_SLICE_BYTES, wantEnd - start + 1));

  const slice = await videoSlice(id, silent, start, length);
  if (!slice) return new NextResponse("Not found", { status: 404 });
  if (start >= slice.size) {
    return new NextResponse(null, { status: 416, headers: { "content-range": `bytes */${slice.size}` } });
  }

  const end = start + slice.chunk.length - 1;
  const whole = !range && slice.chunk.length === slice.size;
  const headers: Record<string, string> = {
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
    "content-length": String(slice.chunk.length),
    // The URL carries the render's version, so a cached slice is never stale.
    "cache-control": "private, max-age=86400",
  };
  if (!whole) headers["content-range"] = `bytes ${start}-${end}/${slice.size}`;
  if (url.searchParams.get("download") === "1") {
    headers["content-disposition"] = `attachment; filename="paribelle-reel-${id}${silent ? "-no-music" : ""}.mp4"`;
  }
  return new NextResponse(new Uint8Array(slice.chunk), { status: whole ? 200 : 206, headers });
}
