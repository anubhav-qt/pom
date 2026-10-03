import { NextResponse } from "next/server";

import { SeelieOfflineError } from "@/lib/seelie/config";
import { nextStep, PICK_MODES, PickError, type PickMode, type PickRequest, type PickTurn } from "@/lib/pick/engine";
import { takeStep, visitorOf } from "@/lib/pick/limits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** A phone photo, downscaled by the shop before it's sent, fits well under this. */
const MAX_BODY_BYTES = 6_000_000;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** The journey as the shopper's browser sent it, cut to sizes no honest one goes past. */
function parse(body: unknown): PickRequest | string {
  if (!body || typeof body !== "object") return "Send { mode, turns }.";
  const b = body as Record<string, unknown>;
  if (!PICK_MODES.includes(b.mode as PickMode)) return `mode is one of ${PICK_MODES.join(", ")}.`;
  if (!Array.isArray(b.turns) || b.turns.length > 6) return "turns is a list of at most 6.";
  const turns: PickTurn[] = [];
  for (const t of b.turns as Record<string, unknown>[]) {
    if (!t || typeof t !== "object" || !Array.isArray(t.options)) return "Each turn has a question and its options.";
    turns.push({
      question: str(t.question, 200),
      options: (t.options as Record<string, unknown>[]).slice(0, 8).map((o) => ({ id: str(o?.id, 8), label: str(o?.label, 60) })),
      picked: Array.isArray(t.picked) ? t.picked.slice(0, 8).map((p) => str(p, 8)) : [],
      text: str(t.text, 300) || undefined,
    });
  }
  let photo: PickRequest["photo"] = null;
  if (b.photo && typeof b.photo === "object") {
    const p = b.photo as Record<string, unknown>;
    if (!PHOTO_TYPES.includes(String(p.mimeType)) || typeof p.data !== "string" || !/^[A-Za-z0-9+/=]+$/.test(p.data.slice(0, 200))) {
      return "photo is { mimeType, data } with a JPEG, PNG or WebP as base64.";
    }
    photo = { mimeType: String(p.mimeType), data: p.data };
  }
  return { mode: b.mode as PickMode, turns, photo, photoNotes: str(b.photoNotes, 500) || null };
}

/**
 * Find Your Pick's one step: the journey so far in, Seelie's next question or its
 * picks out. Open to anyone (it's paribelle.in's, reached at paribelle.in/pom/api/pick),
 * so it reads nothing private, changes nothing, and is rate limited (lib/pick/limits).
 */
export async function POST(request: Request) {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "That photo is too big. Try a smaller one." }, { status: 413 });
  }
  const parsed = parse(await request.json().catch(() => null));
  if (typeof parsed === "string") return NextResponse.json({ error: parsed }, { status: 400 });

  const slot = takeStep(visitorOf(request));
  if (!("release" in slot)) {
    return NextResponse.json(
      { error: slot.error },
      { status: slot.status, headers: slot.retryAfter ? { "retry-after": String(slot.retryAfter) } : undefined },
    );
  }
  try {
    const res = await nextStep(parsed, request.signal);
    return NextResponse.json(res, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof PickError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof SeelieOfflineError) return NextResponse.json({ error: "Find Your Pick is taking a break. The shop is open as usual." }, { status: 503 });
    if (request.signal.aborted) return new NextResponse(null, { status: 499 });
    console.error("[pick]", err);
    return NextResponse.json({ error: "Something went wrong finding your pick. Try again in a moment." }, { status: 500 });
  } finally {
    slot.release();
  }
}
