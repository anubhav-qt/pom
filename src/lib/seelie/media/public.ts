import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { withBasePath } from "@/lib/base-path";

/**
 * Short-lived public links to a library video, for services that fetch the file
 * themselves (Instagram's API takes a video URL, not bytes). The token is the video,
 * version and expiry, signed with AUTH_SECRET; nothing is stored.
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

/** The video and version a token names, or null when it's forged, malformed or expired. */
export function readPublicToken(token: string): { id: number; version: number } | null {
  const m = /^([A-Za-z0-9_-]{8,200})\.([A-Za-z0-9_-]{43})(?:\.mp4)?$/.exec(token);
  if (!m) return null;
  const want = Buffer.from(sign(m[1]));
  const got = Buffer.from(m[2]);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const p = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")) as { v: number; n: number; e: number };
    if (!Number.isInteger(p.v) || !Number.isInteger(p.n) || p.e * 1000 < Date.now()) return null;
    return { id: p.v, version: p.n };
  } catch {
    return null;
  }
}
