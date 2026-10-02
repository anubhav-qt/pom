import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { extOf, getAsset, mediaPath } from "@/lib/seelie/media/files";
import { serveFile } from "@/lib/seelie/media/serve";
import { thumbnail, THUMB_EDGES } from "@/lib/seelie/media/thumbs";

export const runtime = "nodejs";

/** A clip, image or sound in Seelie's media; `?download=1` to save it, `?w=480|1280` for an image's small JPEG. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return new NextResponse("Not signed in", { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return new NextResponse("Not found", { status: 404 });
  const asset = await getAsset(id);
  if (!asset) return new NextResponse("Not found", { status: 404 });
  const query = new URL(request.url).searchParams;

  const edge = THUMB_EDGES.find((e) => String(e) === query.get("w"));
  if (edge && asset.kind === "image") {
    const file = await thumbnail(asset, edge).catch(() => null);
    if (file) return serveFile(request, file, { type: "image/jpeg" });
  }

  const ext = extOf(asset.mime);
  const name = ext && !/\.[a-z0-9]{2,4}$/i.test(asset.name) ? `${asset.name}.${ext}` : asset.name;
  return serveFile(request, mediaPath(asset.file), {
    type: asset.mime,
    downloadName: query.get("download") === "1" ? name : null,
  });
}
