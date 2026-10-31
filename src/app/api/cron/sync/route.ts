import { NextResponse } from "next/server";

import { runLogixmitra } from "@/lib/logixmitra/ship";
import { syncAllAccounts } from "@/lib/sync";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Incremental sync endpoint.
 *
 * The ThinkPad calls this every 10 minutes while it serves the OMS
 * (infra/compose.yml, the sync's `oms-orders` job), with the `CRON_SECRET` as a
 * bearer token. On Vercel nothing calls it on a schedule (`vercel.json` has no
 * `crons` entry): there syncing is triggered by somebody opening the app
 * (`autoSyncOnOpen`, at most once every 30 minutes) and by the Sync now button.
 *
 * Accounts run side by side, and one already syncing is skipped. Each run
 * takes a bounded slice of work per channel and records how far it got, so a
 * busy morning simply spreads across several runs instead of timing out.
 * Nothing here is allowed to throw — a failed channel is reported in the
 * response and in the sync_runs table, and the schedule carries on.
 *
 * After the sync, paribelle.in's new orders go to Logixmitra and booked parcels
 * are tracked (lib/logixmitra/ship). Only here, on the ThinkPad's schedule, so
 * the cloud fallback never books a parcel too.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("authorization");

  if (secret && auth !== `Bearer ${secret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const startedAt = Date.now();
  const results = await syncAllAccounts();
  const logixmitra = await runLogixmitra();

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    results,
    logixmitra,
  });
}
