import { NextResponse } from "next/server";

import { currentUser } from "@/lib/auth";
import { seelieConfig } from "@/lib/seelie/config";
import { GeminiError } from "@/lib/seelie/gemini";
import { MAX_VOICE_BYTES, transcribe } from "@/lib/seelie/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

/**
 * Voice input: a spoken message (16 kHz mono WAV, the body) written out as text.
 *
 *   headers: content-type audio/wav
 *   → { text } ("" when nothing was said)
 */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return bad("Not signed in", 401);
  if (!seelieConfig()) return bad("Seelie is offline here: it runs on the ThinkPad.", 503);
  if ((request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase() !== "audio/wav") return bad("Send the recording as audio/wav.", 415);

  const wav = Buffer.from(await request.arrayBuffer());
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return bad("That isn't a WAV recording.");
  if (wav.length > MAX_VOICE_BYTES) return bad("That recording is too long.", 413);

  try {
    const text = await transcribe(wav, { signal: request.signal });
    return NextResponse.json({ text });
  } catch (err) {
    if (request.signal.aborted) return bad("Cancelled", 499);
    const status = err instanceof GeminiError && err.status === 429 ? 429 : 502;
    const message = status === 429 ? "The Gemini account's limit is used up for now." : "Gemini couldn't write that out.";
    console.warn("[seelie] voice:", err instanceof Error ? err.message : err);
    return bad(message, status);
  }
}
