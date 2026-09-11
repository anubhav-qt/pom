import { NextResponse } from "next/server";
import { z } from "zod";

import { currentUser } from "@/lib/auth";
import { runAssistant, type ChatTurn } from "@/lib/assistant/agent";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  question: z.string().min(1).max(500),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() }))
    .max(12)
    .optional(),
});

export async function POST(request: Request) {
  // This tool can look up real revenue and order data in plain language —
  // gated exactly like every other page in the app, not left open because
  // it "just answers questions".
  if (!(await currentUser())) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Ask a shorter question (under 500 characters)." }, { status: 400 });
  }

  try {
    const result = await runAssistant(
      (parsed.data.history ?? []) as ChatTurn[],
      parsed.data.question,
    );
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "The assistant hit an error." },
      { status: 500 },
    );
  }
}
