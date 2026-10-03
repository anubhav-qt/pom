import { createWriteStream } from "node:fs";
import { readdir, rm, stat, truncate } from "node:fs/promises";
import path from "node:path";

import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { assetSummary, extOf, kindOfMime, mediaFolder, MediaError, saveAsset } from "@/lib/seelie/media/files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** The largest clip Seelie takes. */
const MAX_BYTES = 300 * 1024 * 1024;
/** One request's share: under Cloudflare's 100 MB request cap, with room. */
const MAX_CHUNK = 64 * 1024 * 1024;
const STALE_MS = 24 * 60 * 60 * 1000;

const BY_EXT: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska",
  m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  srt: "application/x-subrip", ass: "text/x-ssa",
  pdf: "application/pdf",
};

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/**
 * Upload a clip (or a sound, image or subtitles) for Seelie, in pieces so a phone's
 * 300 MB video gets through the tunnel's request cap: each request carries the bytes
 * from `x-offset` on, and the last one turns the file into an asset.
 *
 *   headers: content-type (the file's), x-upload (a uuid the browser made), x-offset,
 *            x-total (the file's size), x-name (encodeURIComponent of its name)
 *   → { received } while more is to come; { asset } once it's in; 409 { received }
 *     when the offset isn't where the server is (send from `received`).
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return bad("Not signed in", 401);

  const h = request.headers;
  const upload = h.get("x-upload") ?? "";
  const offset = Number(h.get("x-offset"));
  const total = Number(h.get("x-total"));
  let name = "clip";
  try {
    name = decodeURIComponent(h.get("x-name") ?? "clip").replace(/[\/\u0000-\u001f]/g, " ").trim().slice(0, 160) || "clip";
  } catch {
    // A name that isn't valid URI encoding: keep the default.
  }
  if (!/^[0-9a-f-]{36}$/i.test(upload)) return bad("x-upload must be a uuid.");
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(total) || total <= 0) return bad("x-offset and x-total must be byte counts.");
  if (total > MAX_BYTES) return bad(`That file is ${Math.round(total / 1024 / 1024)} MB; the limit is ${MAX_BYTES / 1024 / 1024} MB.`, 413);

  let mime = (h.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!kindOfMime(mime) || !extOf(mime)) mime = BY_EXT[name.split(".").pop()?.toLowerCase() ?? ""] ?? "";
  if (!mime) return bad(`${name} isn't a clip, sound, image, subtitles or PDF Seelie can use.`, 415);

  const dir = await mediaFolder("cache", "uploads");
  const part = path.join(dir, `${user.id}-${upload.toLowerCase()}.part`);
  if (offset === 0) {
    // Pieces nobody finished.
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const p = path.join(dir, f);
      const s = await stat(p).catch(() => null);
      if (s && Date.now() - s.mtimeMs > STALE_MS) await rm(p, { force: true });
    }
  } else {
    const have = (await stat(part).catch(() => null))?.size ?? 0;
    if (have !== offset) return NextResponse.json({ error: "Out of step", received: have }, { status: 409 });
  }
  if (!request.body) return bad("No bytes came with this piece.");

  const out = createWriteStream(part, { flags: offset === 0 ? "w" : "a" });
  let got = 0;
  try {
    const reader = request.body.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      got += r.value.length;
      if (got > MAX_CHUNK || offset + got > total) {
        await reader.cancel().catch(() => {});
        throw new Error(got > MAX_CHUNK ? "Send pieces of at most 64 MB." : "More bytes came than x-total said.");
      }
      if (!out.write(r.value)) await new Promise<void>((ok) => out.once("drain", () => ok()));
    }
  } catch (err) {
    // A piece that broke off is cut back off, so the browser can send it again.
    if (!out.closed) {
      await new Promise<void>((ok) => {
        out.once("close", () => ok());
        out.destroy();
      });
    }
    if (offset === 0) await rm(part, { force: true });
    else await truncate(part, offset).catch(() => rm(part, { force: true }));
    return bad(err instanceof Error ? err.message : "The upload broke off.", 400);
  }
  await new Promise<void>((ok, fail) => out.end((err?: Error | null) => (err ? fail(err) : ok())));

  const received = offset + got;
  if (received < total) return NextResponse.json({ received });
  try {
    const row = await saveAsset({ fromFile: part, mime, name, source: "upload", chatId: null, userId: user.id });
    return NextResponse.json({ asset: { id: row.id, mime: row.mime, ...assetSummary(row) } });
  } catch (err) {
    await rm(part, { force: true });
    if (err instanceof MediaError) return bad(err.message, 422);
    console.error("[seelie] upload", err);
    return bad("The file couldn't be saved.", 500);
  }
}
