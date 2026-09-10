import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { redirect } from "next/navigation";

import { AppHeader } from "@/components/app-header";
import { ChatWidget } from "@/components/assistant/chat-widget";
import { ScreenSwitcher } from "@/components/screen-switcher";
import { ENABLED_CHANNELS } from "@/config/features";
import { db } from "@/db";
import { channelAccounts, orderFulfilment, orders, syncRuns } from "@/db/schema";
import { destroySession, requireFreshPassword, requireUser } from "@/lib/auth";

import { autoSyncOnOpen, syncNow } from "./settings/actions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireFreshPassword(user);

  const [account] = await db
    .select({ id: channelAccounts.id })
    .from(channelAccounts)
    .where(
      and(
        inArray(channelAccounts.channel, [...ENABLED_CHANNELS]),
        eq(channelAccounts.active, true),
      ),
    )
    .orderBy(channelAccounts.id)
    .limit(1);

  const [lastRun] = await db
    .select({ startedAt: syncRuns.startedAt, finishedAt: syncRuns.finishedAt })
    .from(syncRuns)
    .innerJoin(channelAccounts, eq(channelAccounts.id, syncRuns.channelAccountId))
    .where(inArray(channelAccounts.channel, [...ENABLED_CHANNELS]))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);

  const [orderCounts] = await db
    .select({
      // Excludes anything we have already manifested: the channel still calls
      // it open, but it has left the building.
      toShip: sql<number>`COUNT(*) FILTER (WHERE (${orders.status} IN ('new','ready_to_pack','packed') OR (${orders.status} = 'shipped' AND ${orders.easyshipStatus} = 'PendingPickUp')) AND COALESCE(${orderFulfilment.state}, 'to_pack') <> 'manifested')::int`,
      shipped: sql<number>`COUNT(*) FILTER (WHERE ${orders.status} = 'shipped' AND COALESCE(${orders.easyshipStatus}, '') <> 'PendingPickUp')::int`,
      cancelledRto: sql<number>`COUNT(*) FILTER (WHERE ${orders.status} IN ('cancelled','rto','returned'))::int`,
    })
    .from(orders)
    .leftJoin(orderFulfilment, eq(orderFulfilment.orderId, orders.id))
    .where(inArray(orders.channel, [...ENABLED_CHANNELS]));

  async function signOut() {
    "use server";
    await destroySession();
    redirect("/login");
  }

  return (
    <div className="min-h-screen">
      <AppHeader
        userName={user.name}
        lastSyncAt={(lastRun?.finishedAt ?? lastRun?.startedAt)?.toISOString() ?? null}
        primaryAccountId={account?.id ?? null}
        counts={{
          toShip: Number(orderCounts?.toShip ?? 0),
          shipped: Number(orderCounts?.shipped ?? 0),
          cancelledRto: Number(orderCounts?.cancelledRto ?? 0),
        }}
        onSignOut={signOut}
        onSyncNow={syncNow}
        onAutoSync={autoSyncOnOpen}
      />

      <main className="mx-auto max-w-7xl px-4 pb-8 pt-6 sm:px-6">
        <ScreenSwitcher>{children}</ScreenSwitcher>
      </main>

      <ChatWidget />
    </div>
  );
}
