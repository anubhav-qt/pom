"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { db } from "@/db";
import { channelAccounts, type Channel } from "@/db/schema";
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
  const result = await startManualOrderSync(accountId);
  if (result.ok) revalidatePath("/settings");
  return result;
}
