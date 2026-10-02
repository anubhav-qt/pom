import { NextResponse } from "next/server";

import { runDueRoutines } from "@/lib/seelie/routines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Seelie's routines: starts the ones due.
 *
 * The ThinkPad's sync service calls this every minute while it serves the OMS
 * (infra/compose.yml, the `seelie-routines` job), with the `CRON_SECRET` as a bearer
 * token. On Vercel nothing calls it: Seelie is offline there. The runs it starts go on
 * after it answers, like a reply started from the screen.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const results = await runDueRoutines();
  return NextResponse.json({ ok: true, results });
}
