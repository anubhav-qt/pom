import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { videoFile } from "@/lib/seelie/media/files";
import { getVideo, versionsOf } from "@/lib/seelie/media/library";
import { serveFile } from "@/lib/seelie/media/serve";

export const runtime = "nodejs";

/**
 * A library video: `?v=<version>` (default the latest), `&part=poster` for its poster,
 * `&download=1` to save it.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await currentUser())) return new NextResponse("Not signed in", { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return new NextResponse("Not found", { status: 404 });
  const video = await getVideo(id);
  if (!video?.version) return new NextResponse("Not found", { status: 404 });

  const url = new URL(request.url);
  const version = Number(url.searchParams.get("v") ?? video.version);
  const v = versionsOf(video).find((x) => x.version === version);
  if (!v || v.pruned) return new NextResponse("Not found", { status: 404 });

  if (url.searchParams.get("part") === "poster") return serveFile(request, videoFile(id, version, "poster"), { type: "image/jpeg" });
  const slug = video.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "video";
  return serveFile(request, videoFile(id, version), {
    type: "video/mp4",
    downloadName: url.searchParams.get("download") === "1" ? `paribelle-${slug}-v${version}.mp4` : null,
  });
}
