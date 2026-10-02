import { NextResponse } from "next/server";

import { videoFile } from "@/lib/seelie/media/files";
import { getVideo, versionsOf } from "@/lib/seelie/media/library";
import { readPublicToken } from "@/lib/seelie/media/public";
import { serveFile } from "@/lib/seelie/media/serve";

export const runtime = "nodejs";

/**
 * A library video by a signed, expiring link (media/public.ts), for services that
 * fetch it themselves, like Instagram's. No sign-in: the token is the permission.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const named = readPublicToken((await params).token);
  if (!named) return new NextResponse("This link has expired.", { status: 404 });
  const video = await getVideo(named.id);
  const v = video ? versionsOf(video).find((x) => x.version === named.version) : null;
  if (!v || v.pruned) return new NextResponse("Not found", { status: 404 });
  const res = await serveFile(request, videoFile(named.id, named.version), { type: "video/mp4" });
  res.headers.set("cache-control", "no-store");
  return res;
}
