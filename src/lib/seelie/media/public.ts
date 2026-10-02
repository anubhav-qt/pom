import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { copyFile, readdir, rm, stat, writeFile } from "node:fs/promises";

import { withBasePath } from "@/lib/base-path";

import { mediaFolder, mediaPath } from "./files";

/**
 * Short-lived public links to a library video or a file made for one post, for services
 * that fetch the file themselves (Instagram's and Meta's APIs take a URL, not bytes).
 * The token is the video and version (or the file's name) and the expiry, signed with
 * AUTH_SECRET; nothing is stored. Files made for a post sit in public/ for a day.
 *
 * The link goes through the public address (paribelle.in/pom, which the edge Worker
 * forwards to the ThinkPad, where the files are).
 */

const DEFAULT_TTL_SECONDS = 60 * 60;

function key() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return createHmac("sha256", "seelie-public").update(secret).digest();
}

const sign = (payload: string) => createHmac("sha256", key()).update(payload).digest("base64url");

/** Where the OMS is reachable from the internet, without a trailing slash. */
export function publicOrigin() {
  return (process.env.SEELIE_PUBLIC_URL?.trim() || "https://www.paribelle.in").replace(/\/+$/, "");
}

export function publicVideoUrl(id: number, version: number, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const payload = Buffer.from(JSON.stringify({ v: id, n: version, e: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  return `${publicOrigin()}${withBasePath(`/api/seelie/public/${payload}.${sign(payload)}.mp4`)}`;
}

const STAGED_NAME = /^[A-Za-z0-9_-]{12,40}\.(jpg|mp4)$/;
/** How long a file made for a post is kept. */
const STAGED_KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Put a file where a public link can reach it (a JPEG for a photo post, say) and return
 * the link. Files older than a day are cleared on the way.
 */
export async function stagePublic(input: { bytes?: Buffer; fromFile?: string; ext: "jpg" | "mp4" }, ttlSeconds = DEFAULT_TTL_SECONDS) {
  const dir = await mediaFolder("public");
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const file = mediaPath("public", name);
    const old = await stat(file).then((s) => Date.now() - s.mtimeMs > STAGED_KEEP_MS).catch(() => false);
    if (old) await rm(file, { force: true });
  }
  const name = `${randomBytes(12).toString("base64url")}.${input.ext}`;
  if (input.bytes) await writeFile(mediaPath("public", name), input.bytes);
  else if (input.fromFile) await copyFile(input.fromFile, mediaPath("public", name));
  else throw new Error("Nothing to stage.");
  const payload = Buffer.from(JSON.stringify({ f: name, e: Math.floor(Date.now() / 1000) + ttlSeconds })).toString("base64url");
  return `${publicOrigin()}${withBasePath(`/api/seelie/public/${payload}.${sign(payload)}.${input.ext}`)}`;
}

export type PublicTarget = { kind: "video"; id: number; version: number } | { kind: "file"; file: string; type: string };

/** What a token names, or null when it's forged, malformed or expired. */
export function readPublicToken(token: string): PublicTarget | null {
  const m = /^([A-Za-z0-9_-]{8,200})\.([A-Za-z0-9_-]{43})(?:\.(?:mp4|jpg))?$/.exec(token);
  if (!m) return null;
  const want = Buffer.from(sign(m[1]));
  const got = Buffer.from(m[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")) as { v?: number; n?: number; f?: string; e: number };
    if (!Number.isFinite(p.e) || p.e * 1000 < Date.now()) return null;
    if (typeof p.f === "string") {
      if (!STAGED_NAME.test(p.f)) return null;
      return { kind: "file", file: mediaPath("public", p.f), type: p.f.endsWith(".jpg") ? "image/jpeg" : "video/mp4" };
    }
    if (!Number.isInteger(p.v) || !Number.isInteger(p.n)) return null;
    return { kind: "video", id: p.v!, version: p.n! };
  } catch {
    return null;
  }
}
