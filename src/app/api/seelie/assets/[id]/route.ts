import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { getAsset, mediaPath } from "@/lib/seelie/media/files";
import { serveFile } from "@/lib/seelie/media/serve";

export const runtime = "nodejs";

/** A clip, image or sound in Seelie's media; `?download=1` to save it. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return new NextResponse("Not signed in", { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return new NextResponse("Not found", { status: 404 });
  const asset = await getAsset(id);
  if (!asset) return new NextResponse("Not found", { status: 404 });
  return serveFile(request, mediaPath(asset.file), {
    type: asset.mime,
    downloadName: new URL(request.url).searchParams.get("download") === "1" ? asset.name : null,
  });
}
