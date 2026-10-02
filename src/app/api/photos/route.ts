import { stat } from "node:fs/promises";

import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { CLOUDINARY_URL, localCopyFile } from "@/lib/seelie/media/catalogue";
import { serveFile } from "@/lib/seelie/media/serve";

export const runtime = "nodejs";

/**
 * A catalogue photo Seelie published (src: its Cloudinary URL): this server's own copy
 * when it has one (the ThinkPad), else a redirect to Cloudinary (the fallback).
 */
export async function GET(request: Request) {
  if (!(await currentUser())) return new NextResponse("Not signed in", { status: 401 });
  const src = new URL(request.url).searchParams.get("src") ?? "";
  if (!CLOUDINARY_URL.test(src)) return new NextResponse("Not a catalogue photo", { status: 400 });
  const file = localCopyFile(src);
  if (await stat(file).then((s) => s.isFile(), () => false)) return serveFile(request, file, { type: "image/jpeg" });
  return NextResponse.redirect(src, 302);
}
