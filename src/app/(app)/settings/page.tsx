import { desc, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { channelAccounts, syncRuns } from "@/db/schema";
import { ENABLED_CHANNELS } from "@/config/features";
import { requireUser } from "@/lib/auth";

import { ChannelAccounts, MeeshoImport, SyncLog } from "./settings-client";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requireUser();

  const accounts = await db
    .select()
    .from(channelAccounts)
    .where(inArray(channelAccounts.channel, [...ENABLED_CHANNELS]))
    .orderBy(channelAccounts.channel, channelAccounts.id);

  const runs = await db
    .select({
      id: syncRuns.id,
      kind: syncRuns.kind,
      status: syncRuns.status,
      startedAt: syncRuns.startedAt,
      finishedAt: syncRuns.finishedAt,
      itemsWritten: syncRuns.itemsWritten,
      error: syncRuns.error,
      accountLabel: channelAccounts.label,
      channel: channelAccounts.channel,
    })
    .from(syncRuns)
    .innerJoin(channelAccounts, eq(channelAccounts.id, syncRuns.channelAccountId))
    // History from a parked channel is not actionable and only adds noise to
    // the one screen you look at when something is broken.
    .where(inArray(channelAccounts.channel, [...ENABLED_CHANNELS]))
    .orderBy(desc(syncRuns.startedAt))
    .limit(25);

  return (
    <div className="space-y-8">
      <ChannelAccounts
        isOwner={user.role === "owner"}
        accounts={accounts.map((a) => ({
          id: a.id,
          channel: a.channel,
          label: a.label,
          active: a.active,
          ordersSyncedThrough: a.ordersSyncedThrough?.toISOString() ?? null,
          credentialKeys: Object.keys(a.credentials ?? {}),
          sandbox: a.credentials?.sandbox === "true",
        }))}
      />

      <MeeshoImport
        accounts={accounts
          .filter((a) => a.channel === "meesho")
          .map((a) => ({ id: a.id, label: a.label }))}
      />

      <SyncLog
        runs={runs.map((r) => ({
          id: r.id,
          kind: r.kind,
          status: r.status,
          startedAt: r.startedAt.toISOString(),
          itemsWritten: r.itemsWritten,
          error: r.error,
          accountLabel: r.accountLabel,
          channel: r.channel,
        }))}
      />
    </div>
  );
}
