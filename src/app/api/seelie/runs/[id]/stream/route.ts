import { currentUser } from "@/lib/auth";
import { followRun } from "@/lib/seelie/engine";
import { failure, sse, unauthorized } from "@/lib/seelie/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Follow a reply: everything after transcript message `after`, then live until it ends. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthorized();
  try {
    const after = Number(new URL(request.url).searchParams.get("after") ?? 0);
    return sse(await followRun(user, (await params).id, Number.isFinite(after) ? after : 0));
  } catch (err) {
    return failure(err);
  }
}
