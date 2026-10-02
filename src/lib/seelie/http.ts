import "server-only";

import { NextResponse } from "next/server";

import { SeelieOfflineError } from "./config";
import { SeelieRunError } from "./engine";

/** Seelie's route handlers' shared bits: how a stream goes out, and how failures read. */

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  // Tells nginx/Caddy-style proxies not to buffer the stream.
  "x-accel-buffering": "no",
};

export function sse(stream: ReadableStream<Uint8Array>) {
  return new Response(stream, { headers: SSE_HEADERS });
}

export function failure(err: unknown) {
  if (err instanceof SeelieRunError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof SeelieOfflineError) return NextResponse.json({ error: err.message, offline: true }, { status: 503 });
  console.error("[seelie]", err);
  return NextResponse.json({ error: err instanceof Error ? err.message : "Something went wrong." }, { status: 500 });
}

export const unauthorized = () => NextResponse.json({ error: "Not signed in" }, { status: 401 });
