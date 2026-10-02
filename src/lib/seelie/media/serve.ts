import "server-only";

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import { NextResponse } from "next/server";

/**
 * A media file as an HTTP response, with byte ranges so players can seek. These files
 * live on the ThinkPad's disk and are served from there (no Vercel size cap applies).
 * The URLs carry a version, so a cached response is never stale.
 */
export async function serveFile(request: Request, file: string, opts: { type: string; downloadName?: string | null }) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return new NextResponse("Not found", { status: 404 });
  const size = info.size;

  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range")?.trim() ?? "");
  let start = 0;
  let end = size - 1;
  if (range) {
    if (range[1] === "" && range[2] !== "") {
      start = Math.max(0, size - Number(range[2]));
    } else {
      start = Number(range[1]);
      if (range[2] !== "") end = Math.min(end, Number(range[2]));
    }
    if (start >= size || start > end) {
      return new NextResponse(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    }
  }

  const headers: Record<string, string> = {
    "content-type": opts.type,
    "accept-ranges": "bytes",
    "content-length": String(end - start + 1),
    "cache-control": "private, max-age=86400",
  };
  if (range) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  if (opts.downloadName) headers["content-disposition"] = `attachment; filename="${opts.downloadName.replace(/[^\w.-]+/g, "-")}"`;
  const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>;
  return new NextResponse(body, { status: range ? 206 : 200, headers });
}
