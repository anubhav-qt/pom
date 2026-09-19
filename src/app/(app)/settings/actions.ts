"use server";

import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { channelAccounts, syncRuns, type Channel } from "@/db/schema";
import { requireOwner, requireUser } from "@/lib/auth";
import { startManualOrderSync } from "@/lib/sync";

export async function addChannelAccount(input: {
  channel: Channel;
  label: string;
  credentials: Record<string, string>;
}) {
  await requireOwner();

  // Drop blank fields so an unset optional credential does not overwrite a
  // real one with an empty string later.
  const credentials = Object.fromEntries(
    Object.entries(input.credentials).filter(([, v]) => v.trim() !== ""),
  );

  await db.insert(channelAccounts).values({
    channel: input.channel,
    label: input.label.trim() || input.channel,
    credentials,
  });

  revalidatePath("/settings");
  return { ok: true as const };
}

export async function setAccountActive(id: number, active: boolean) {
  await requireOwner();
  await db.update(channelAccounts).set({ active }).where(eq(channelAccounts.id, id));
  revalidatePath("/settings");
  return { ok: true as const };
}

export async function deleteChannelAccount(id: number) {
  await requireOwner();
  // Cascades to orders, listings and sync history for this account.
  await db.delete(channelAccounts).where(eq(channelAccounts.id, id));
  revalidatePath("/settings");
  return { ok: true as const };
}

/**
 * Manual "sync now". Returns almost immediately with a run id — it does not
 * wait for the sync to finish. The actual work continues in the background;
 * the client polls /api/sync-progress with the returned id to show real
 * progress instead of a spinner that means nothing.
 */
export async function syncNow(accountId: number) {
  await requireUser();
  // No revalidate here: the caller refreshes once when the run finishes, and
  // revalidating on start would reload the page a second time, too early.
  return startManualOrderSync(accountId);
}

/**
 * How long a sync stays fresh enough that opening the app should not start
 * another one.
 */
const AUTO_SYNC_STALE_MS = 30 * 60 * 1000;

/**
 * Start a sync because somebody opened the app, but only if the data is
 * actually stale.
 *
 * This replaces the Vercel cron. The gate is deliberately server-side rather
 * than a flag in the browser: two tabs, two people, or a reload would each
 * think they were the first and fire their own sync, and three overlapping
 * syncs against a 0.5 req/sec endpoint is worse than none. Asking the database
 * when the last run finished is the only answer that all of them agree on.
 *
 * A run that is still going also counts as fresh, so a slow sync cannot be
 * stampeded by everyone arriving at once.
 */
export async function autoSyncOnOpen(accountId: number) {
  await requireUser();

  const [last] = await db
    .select({
      id: syncRuns.id,
      startedAt: syncRuns.startedAt,
      finishedAt: syncRuns.finishedAt,
      status: syncRuns.status,
    })
    .from(syncRuns)
    .where(and(eq(syncRuns.channelAccountId, accountId), eq(syncRuns.kind, "orders")))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);

  if (last) {
    if (last.status === "running") {
      /**
       * A run is already in flight, started by an earlier open or another tab.
       * We did not start it, so `ok` stays false, but we hand back its id
       * anyway: the caller still needs to watch it to know when to refresh.
       * Without the id the run finishes unobserved and the screen goes on
       * showing pre-sync orders until something else refetches.
       */
      return { ok: false as const, skipped: "running" as const, runId: last.id };
    }
    const finishedAt = last.finishedAt ?? last.startedAt;
    const age = Date.now() - finishedAt.getTime();
    if (age < AUTO_SYNC_STALE_MS) {
      return { ok: false as const, skipped: "fresh" as const, ageMs: age };
    }
  }

  const result = await startManualOrderSync(accountId);
  return result.ok
    ? { ok: true as const, runId: result.runId }
    : { ok: false as const, skipped: "error" as const, error: result.error };
}
