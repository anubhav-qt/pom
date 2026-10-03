import { currentUser } from "@/lib/auth";
import { followRun, startRun } from "@/lib/seelie/engine";
import { failure, sse, unauthorized } from "@/lib/seelie/http";
import type { StartRunInput } from "@/lib/seelie/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The reply streams for as long as the function lives (300s is the Hobby cap); the run itself doesn't depend on it, and `GET runs/[id]/stream` picks it up again.
export const maxDuration = 300;

/** Send a message: starts Seelie's reply and streams it (`GET runs/[id]/stream` picks it up again). */
export async function POST(request: Request) {
  const user = await currentUser();
  if (!user) return unauthorized();
  try {
    const body = (await request.json().catch(() => null)) as StartRunInput | null;
    if (!body || typeof body !== "object") return failure(new Error("Send { text, images?, assets?, chatId?, model?, thinking? }."));
    const { runId } = await startRun(user, {
      chatId: typeof body.chatId === "string" ? body.chatId : null,
      text: typeof body.text === "string" ? body.text : "",
      images: Array.isArray(body.images) ? body.images : [],
      assets: Array.isArray(body.assets) ? body.assets.filter((id): id is number => typeof id === "number") : [],
      model: typeof body.model === "string" ? body.model : undefined,
      thinking: typeof body.thinking === "string" ? body.thinking : undefined,
      autoApprove: body.autoApprove === true,
    });
    return sse(await followRun(user, runId, 0));
  } catch (err) {
    return failure(err);
  }
}
