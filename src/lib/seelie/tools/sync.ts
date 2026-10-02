import "server-only";

import { Type } from "@paribelle/pi-ai";
import { desc, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { channelAccounts, syncRuns } from "@/db/schema";
import { isChannelEnabled } from "@/config/features";
import { syncFinance, financeRowCount } from "@/lib/finance";
import { backfillAccount, reconcileAccount, syncAccount } from "@/lib/sync";

import { defineTool, ToolError } from "./types";
import { accountsFor, ist, istDay, nextDay, StringEnum } from "./util";

export const syncStatus = defineTool({
  name: "sync_status",
  label: "Sync status",
  description:
    "The connected marketplace accounts (id, channel, label, active, how far orders and returns are synced, money lines held) and the latest sync runs with their counts and errors.",
  parameters: Type.Object({ runs: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, description: "Recent runs to list (default 10)." })) }),
  kind: "read",
  summary: () => "Accounts and recent syncs",
  async execute(a) {
    const accounts = await db
      .select({
        id: channelAccounts.id,
        channel: channelAccounts.channel,
        label: channelAccounts.label,
        active: channelAccounts.active,
        ordersThrough: channelAccounts.ordersSyncedThrough,
        returnsThrough: channelAccounts.returnsSyncedThrough,
      })
      .from(channelAccounts);
    const runs = await db
      .select({
        id: syncRuns.id,
        accountId: syncRuns.channelAccountId,
        kind: syncRuns.kind,
        status: syncRuns.status,
        started: syncRuns.startedAt,
        finished: syncRuns.finishedAt,
        seen: syncRuns.itemsSeen,
        written: syncRuns.itemsWritten,
        error: syncRuns.error,
      })
      .from(syncRuns)
      .orderBy(desc(syncRuns.startedAt))
      .limit(a.runs ?? 10);
    return {
      data: {
        accounts: await Promise.all(
          accounts.map(async (acc) => ({
            ...acc,
            shownInApp: isChannelEnabled(acc.channel),
            ordersThrough: ist(acc.ordersThrough),
            returnsThrough: ist(acc.returnsThrough),
            moneyLines: await financeRowCount(acc.id),
          })),
        ),
        runs: runs.map((r) => ({ ...r, started: ist(r.started), finished: ist(r.finished), error: r.error?.slice(0, 300) ?? null })),
      },
    };
  },
});

const SYNC_KINDS = ["orders", "returns", "finance", "reconcile", "backfill"] as const;

export const syncMarketplace = defineTool({
  name: "sync_marketplace",
  label: "Sync from marketplace",
  description: [
    "Pull fresh data from the marketplace into the OMS (reads the marketplace, writes only the OMS).",
    "orders: new and changed orders since the last sync (what Sync now does); returns: customer returns; finance: payments, fees and refunds;",
    "reconcile: re-read order statuses from `since` (YYYY-MM-DD) and fix any that drifted (e.g. delivered, RTO);",
    "backfill: load full order history between `since` and `until` from Amazon's reports (slow: minutes per month).",
    "Omit accountId for every active account.",
  ].join(" "),
  parameters: Type.Object({
    kinds: Type.Array(StringEnum(SYNC_KINDS), { minItems: 1 }),
    accountId: Type.Optional(Type.Integer()),
    since: Type.Optional(Type.String({ description: "reconcile/backfill: YYYY-MM-DD" })),
    until: Type.Optional(Type.String({ description: "backfill: YYYY-MM-DD (default today)" })),
  }),
  kind: "write",
  summary: (a) => `Sync ${a.kinds.join(", ")}${a.since ? ` since ${a.since}` : ""}${a.until ? ` until ${a.until}` : ""}`,
  async execute(a, ctx) {
    const accounts = await accountsFor(a.accountId);
    if ((a.kinds.includes("reconcile") || a.kinds.includes("backfill")) && !a.since) throw new ToolError("reconcile and backfill need `since`.");
    const results: Record<string, Record<string, unknown>> = {};
    for (const account of accounts) {
      const key = `${account.label} (${account.channel} #${account.id})`;
      const out: Record<string, unknown> = {};
      results[key] = out;
      for (const kind of a.kinds) {
        if (ctx.signal.aborted) throw new ToolError("Stopped.");
        try {
          if (kind === "orders") {
            ctx.progress(`${account.label}: reading new orders…`);
            const res = await syncAccount(account, "orders", 100, {
              onProgress: ({ seen, total }) => ctx.progress(`${account.label}: orders ${seen} of ${total}`),
            });
            out.orders = res.skipped ? res.reason : { seen: res.seen, written: res.written, through: ist(res.syncedThrough), more: res.hasMore, needsBackfill: res.truncated };
          } else if (kind === "returns") {
            ctx.progress(`${account.label}: reading returns…`);
            let seen = 0;
            let written = 0;
            for (let i = 0; i < 6; i++) {
              const res = await syncAccount(account, "returns");
              if (res.skipped) {
                out.returns = res.reason;
                break;
              }
              seen += res.seen;
              written += res.written;
              out.returns = { seen, written, through: ist(res.syncedThrough) };
              if (res.syncedThrough.getTime() > Date.now() - 3_600_000) break;
              const [fresh] = await db.select().from(channelAccounts).where(eq(channelAccounts.id, account.id));
              Object.assign(account, fresh);
            }
          } else if (kind === "finance") {
            ctx.progress(`${account.label}: reading payments…`);
            out.finance = await syncFinance(account);
          } else if (kind === "reconcile") {
            ctx.progress(`${account.label}: re-reading statuses since ${a.since}…`);
            const res = await reconcileAccount(account, {
              since: istDay(a.since!, "since"),
              onProgress: ({ seen, total }) => ctx.progress(`${account.label}: checked ${seen} of ${total}`),
            });
            out.reconcile = res.skipped ? res.reason : { seen: res.seen, corrected: res.written, more: res.hasMore };
          } else if (kind === "backfill") {
            const res = await backfillAccount(account, {
              start: istDay(a.since!, "since"),
              end: a.until ? nextDay(istDay(a.until, "until")) : undefined,
              onProgress: (p) => ctx.progress(`${account.label}: ${p.window} — ${p.ordersSeen} orders so far${p.error ? ` (window failed: ${p.error})` : ""}`),
            });
            out.backfill = res;
          }
        } catch (err) {
          out[kind] = { error: err instanceof Error ? err.message.slice(0, 500) : String(err) };
        }
        // The account row moved on (synced-through cursors); later kinds read the new one.
        const [fresh] = await db.select().from(channelAccounts).where(eq(channelAccounts.id, account.id));
        if (fresh) Object.assign(account, fresh);
      }
    }
    return { data: results };
  },
});

export const marketplaceAccounts = defineTool({
  name: "marketplace_accounts",
  label: "Marketplace accounts",
  description:
    "Switch a connected marketplace account on or off in the OMS (an inactive account isn't synced). Connecting a new account or changing its keys is done by the owner in Settings.",
  parameters: Type.Object({ accountId: Type.Integer(), active: Type.Boolean() }),
  kind: "write",
  ownerOnly: true,
  summary: (a) => `${a.active ? "Switch on" : "Switch off"} account ${a.accountId}`,
  async execute(a) {
    const rows = await db
      .update(channelAccounts)
      .set({ active: a.active })
      .where(eq(channelAccounts.id, a.accountId))
      .returning({ label: channelAccounts.label });
    if (rows.length === 0) throw new ToolError(`No account ${a.accountId}.`);
    return { text: `${rows[0].label} is ${a.active ? "on" : "off"}.` };
  },
});

/** Kept for the prompt: how fresh the data is. */
export async function lastOrdersSync() {
  const [row] = await db
    .select({ at: sql<Date | null>`MAX(${syncRuns.finishedAt})` })
    .from(syncRuns)
    .where(sql`${syncRuns.kind} = 'orders' AND ${syncRuns.status} = 'ok'`);
  return row?.at ? new Date(row.at) : null;
}
