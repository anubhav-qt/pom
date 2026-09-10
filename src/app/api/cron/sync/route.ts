import { NextResponse } from "next/server";

import { syncAllAccounts } from "@/lib/sync";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Incremental sync endpoint.
 *
 * Nothing calls this on a schedule. `vercel.json` has no `crons` entry: syncing
 * is triggered by somebody opening the app (`autoSyncOnOpen`, at most once
 * every 30 minutes) and by the Sync now button.
 *
 * The route stays because it is the one way to drive a sync from outside the
 * browser, with the `CRON_SECRET` as a bearer token. Re-adding a schedule is a
 * one-line change to `vercel.json`.
 *
 * Each run takes a bounded slice of work per channel and records how far it
 * got, so a busy morning simply spreads across several runs instead of timing
 * out. Nothing here is allowed to throw — a failed channel is reported in the
 * response and in the sync_runs table, and the schedule carries on.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");

  if (secret && auth !== `Bearer ${secret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const startedAt = Date.now();
  const results = await syncAllAccounts();

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    results,
  });
}
