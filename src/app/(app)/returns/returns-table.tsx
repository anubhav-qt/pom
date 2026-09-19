"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { RailCrumb } from "@/components/rail-crumb";
import { Empty, LoadingOverlay, Spinner, Stat, StatStrip } from "@/components/ui";
import { friendlyItem } from "@/lib/friendly-item";
import { OrderThumb } from "../orders/order-table";
import { withBasePath } from "@/lib/base-path";
import { returnsKey, useReturnsCache, useReturnsNav, type ReturnsFilter, type ReturnsTab } from "@/lib/stores/returns-cache";
import { useOrdersCache } from "@/lib/stores/orders-cache";
import { dayLabel, money } from "@/lib/utils";

import { LabelBars } from "../dashboard/finance-charts";
import { CancellationsPanel } from "../orders/cancellations-panel";
import { closeReturnWithoutParcel, receiveReturn, reopenReturn } from "./actions";
import type { ReturnDeskRow, ReturnStage } from "./queries";
import { getReturnsView, type ReturnsView } from "./view-actions";

/**
 * The Returns desk.
 *
 * Two lists, one job each. "Customer returns" is what Amazon's Returns report
 * says customers sent back. "RTO & cancelled" is the existing check-in list for
 * parcels that never reached the customer. Every open return ends in a
 * decision (reshelved, damaged, written off, claim raised) rather than a tick.
 */

type Tab = ReturnsTab;
type Filter = ReturnsFilter;

const OUTCOME_LABEL: Record<string, string> = {
  reshelved: "Back in stock",
  damaged: "Damaged",
  written_off: "Written off",
  claim_raised: "Claim raised",
  closed: "Returned per Amazon",
};

const STAGE: Record<ReturnStage, { label: string; color: string; bg: string }> = {
  transit: { label: "On its way", color: "var(--accent)", bg: "var(--accent-soft)" },
  arrived: { label: "Arrived", color: "var(--warn)", bg: "var(--warn-soft)" },
  overdue: { label: "Not received", color: "var(--danger)", bg: "var(--danger-soft)" },
  done: { label: "Done", color: "var(--ok)", bg: "var(--ok-soft)" },
};

function StagePill({ row }: { row: ReturnDeskRow }) {
  const s = STAGE[row.stage];
  const label = row.stage === "done" ? (OUTCOME_LABEL[row.outcome ?? ""] ?? "Done") : s.label;
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium"
      style={{ background: s.bg, color: s.color }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: s.color }} />
      {label}
    </span>
  );
}

const SIZE_REASONS = new Set(["Poor fit", "Too small", "Too large"]);

export function ReturnsDesk({ initialView, initialTab }: { initialView: ReturnsView; initialTab: Tab }) {
  const resolvedCancel = useReturnsNav((s) => s.resolved);
  const tab = useReturnsNav((s) => s.tab);
  const filter = useReturnsNav((s) => s.filter);
  const query = useReturnsNav((s) => s.query);
  const syncStamp = useOrdersCache((s) => s.syncStamp);
  const [view, setView] = useState<ReturnsView>(initialView);
  const [loading, setLoading] = useState(false);

  // Seed synchronously so the server's first payload counts as already fetched.
  const seeded = useRef(false);
  if (!seeded.current) {
    seeded.current = true;
    useReturnsCache.getState().put(returnsKey(initialView.resolved), initialView);
    // The URL only decides the tab on a fresh load; after that the store holds it.
    useReturnsNav.setState({ resolved: initialView.resolved, tab: initialTab });
  }

  useEffect(() => {
    let cancelled = false;
    const cache = useReturnsCache.getState();
    const key = returnsKey(resolvedCancel);

    const cached = cache.peek(key);
    if (cached) setView(cached);
    else setLoading(true);

    cache
      .load(key, () => getReturnsView(resolvedCancel))
      .then((fresh) => {
        if (cancelled) return;
        setView(fresh);
        setLoading(false);
        useReturnsCache.getState().entries[key]?.inFlight?.then((latest) => !cancelled && setView(latest)).catch(() => {});
      })
      .catch(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [resolvedCancel, syncStamp]);

  /** Something changed here: drop what was cached and read this list again. */
  function refresh() {
    useReturnsCache.getState().clear();
    setLoading(true);
    useReturnsCache
      .getState()
      .load(returnsKey(resolvedCancel), () => getReturnsView(resolvedCancel))
      .then((fresh) => {
        setView(fresh);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  const { rows, kpis, reasons, cancellations, cancelCounts } = view;

  function selectTab(next: Tab) {
    useReturnsNav.getState().setTab(next);
    const q = new URLSearchParams(window.location.search);
    if (next === "rto") q.set("tab", "rto");
    else q.delete("tab");
    const s = q.toString();
    window.history.replaceState(null, "", withBasePath(s ? `/returns?${s}` : "/returns"));
  }

  function setResolvedCancel(next: boolean) {
    useReturnsNav.getState().setResolved(next);
    window.history.replaceState(null, "", withBasePath(`/returns?tab=rto${next ? "&resolved=1" : ""}`));
  }

  const counts: Record<Filter, number> = {
    todo: rows.filter((r) => r.stage === "transit" || r.stage === "arrived" || r.stage === "overdue").length,
    overdue: rows.filter((r) => r.stage === "overdue").length,
    done: rows.filter((r) => r.stage === "done").length,
  };

  const q = query.trim().toLowerCase();
  const matches = (...fields: (string | null | undefined)[]) => !q || fields.some((v) => v?.toLowerCase().includes(q));

  const shown = rows.filter(
    (r) =>
      (filter === "todo" ? r.stage === "transit" || r.stage === "arrived" || r.stage === "overdue" : r.stage === filter) &&
      matches(r.item, r.reason, r.externalOrderId, r.awb),
  );
  const shownCancellations = cancellations.filter((c) =>
    matches(c.externalOrderId, ...c.items.map((i) => i.title), ...c.items.map((i) => i.sku)),
  );

  const totalReasons = reasons.reduce((a, r) => a + r.count, 0);
  const sizeCount = reasons.filter((r) => SIZE_REASONS.has(r.reason)).reduce((a, r) => a + r.count, 0);

  return (
    <div className="relative space-y-5 pb-16 sm:-mt-6 sm:space-y-[7px] sm:pb-0">
      <RailCrumb
        primary={{
          activeId: tab,
          activeLabel: tab === "returns" ? "Customer returns" : "RTO & cancelled",
          options: [
            { id: "returns", label: "Customer returns", count: counts.todo },
            { id: "rto", label: "RTO & cancelled", count: cancelCounts.pending },
          ],
          onSelect: (id) => selectTab(id as Tab),
        }}
        sub={
          tab === "returns"
            ? {
                activeId: filter,
                activeLabel: { todo: "To do", overdue: "Not received", done: "Done" }[filter],
                options: [
                  { id: "todo", label: "To do", count: counts.todo },
                  { id: "overdue", label: "Not received", count: counts.overdue },
                  { id: "done", label: "Done", count: counts.done },
                ],
                onSelect: (id) => useReturnsNav.getState().setFilter(id as Filter),
              }
            : {
                activeId: resolvedCancel ? "completed" : "pending",
                activeLabel: resolvedCancel ? "Completed" : "Pending",
                options: [
                  { id: "pending", label: "Pending", count: cancelCounts.pending },
                  { id: "completed", label: "Completed", count: cancelCounts.completed },
                ],
                onSelect: (id) => setResolvedCancel(id === "completed"),
              }
        }
      />

      <StatStrip
        items={[
          { label: "To check in", value: kpis.toDo, tone: kpis.arrived > 0 ? "warn" : undefined },
          { label: "May be owed", value: kpis.overdue > 0 ? money(kpis.overdueRefund) : "—", tone: kpis.overdue > 0 ? "danger" : undefined },
          { label: "Refunded, 30 days", value: money(kpis.refunded30) },
          { label: "Amazon paid back", value: money(kpis.reimbursed30), tone: "ok" },
        ]}
      />
      <div className="hidden grid-cols-2 gap-3 sm:grid sm:gap-[7px] lg:grid-cols-4">
        <Stat label="To check in" value={kpis.toDo} tone={kpis.arrived > 0 ? "warn" : undefined} />
        <Stat
          label="May be owed"
          value={kpis.overdue > 0 ? money(kpis.overdueRefund) : "—"}
          tone={kpis.overdue > 0 ? "danger" : undefined}
          hint={kpis.overdue > 0 ? `${kpis.overdue} not received` : undefined}
        />
        <Stat label="Refunded, 30 days" value={money(kpis.refunded30)} hint={`${kpis.returns30} returns`} />
        <Stat label="Amazon paid back" value={money(kpis.reimbursed30)} tone="ok" hint="30 days" />
      </div>

      <div className="grid gap-5 sm:gap-[7px] lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-5 sm:space-y-[7px]">
          {tab === "returns" ? (
            <>
              {shown.length === 0 ? (
                <div className="panel">
                  <Empty title={filter === "todo" ? "All caught up" : "Nothing here"} />
                </div>
              ) : (
                <div className="space-y-3">
                  {shown.map((r) => (
                    <ReturnCard key={r.id} row={r} onChanged={refresh} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <CancellationsPanel
              records={shownCancellations}
              counts={cancelCounts}
              resolved={resolvedCancel}
              onResolvedChange={setResolvedCancel}
              onChanged={refresh}
            />
          )}
        </div>

        <aside className="min-w-0">
          <div className="panel p-5">
            <h2 className="text-sm font-semibold">Why customers return</h2>
            {totalReasons > 0 ? (
              <p className="muted mb-4 text-xs">{Math.round((sizeCount / totalReasons) * 100)}% are about size</p>
            ) : (
              <div className="mb-4" />
            )}
            <LabelBars
              items={reasons.map((r) => ({
                key: r.reason,
                label: r.reason,
                value: r.count,
                note: totalReasons > 0 ? `${Math.round((r.count / totalReasons) * 100)}%` : undefined,
              }))}
              color="var(--accent)"
            />
          </div>
        </aside>
      </div>

      {loading ? <LoadingOverlay /> : null}
    </div>
  );
}

function ReturnCard({ row, onChanged }: { row: ReturnDeskRow; onChanged: () => void }) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState<"checkin" | "writeoff" | "claim" | null>(null);
  const [restock, setRestock] = useState(true);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const it = friendlyItem(row.item);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Something went wrong.");
      else {
        setError(null);
        setOpen(null);
        setNote("");
      }
      onChanged();
    });
  }

  const open_ = row.stage !== "done";

  return (
    <div className="panel space-y-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <OrderThumb src={row.imageUrl} alt={it.name} size="h-11 w-11 shrink-0" />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium" title={it.name}>
              {it.name}
            </div>
            <div className="muted text-xs">
              {[it.size, it.color].filter(Boolean).join(" · ")}
              {row.requestedAt ? `${it.size || it.color ? " · " : ""}${dayLabel(new Date(row.requestedAt))}` : ""}
            </div>
          </div>
        </div>
        <StagePill row={row} />
      </div>

      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <span>{row.reason}</span>
        {row.refundAmount ? <span className="font-medium tabular-nums">{money(row.refundAmount)} refunded</span> : null}
        {row.orderNet != null && row.refundAmount ? (
          <span
            className="tabular-nums text-xs font-medium"
            style={{ color: row.orderNet < 0 ? "var(--danger)" : "var(--ok)" }}
            title="What Amazon paid minus everything it took for this order"
          >
            Net {row.orderNet < 0 ? "−" : ""}
            {money(Math.abs(row.orderNet))}
          </span>
        ) : null}
        {row.stage === "overdue" ? (
          <span className="text-xs" style={{ color: "var(--danger)" }}>
            {row.ageDays} days, not received
          </span>
        ) : null}
      </div>

      {row.externalOrderId ? (
        <div className="muted font-mono text-[10px]" title="Amazon order ID">
          {row.externalOrderId}
        </div>
      ) : null}

      {error ? <p className="rounded-md bg-rose-500/10 px-3 py-2 text-xs text-rose-600">{error}</p> : null}

      {!open_ ? (
        row.outcome === "written_off" || row.outcome === "claim_raised" ? (
          <button className="btn text-xs" disabled={pending} onClick={() => run(() => reopenReturn(row.id))}>
            {pending ? <Spinner size="1rem" /> : "Reopen"}
          </button>
        ) : null
      ) : (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <button className="btn btn-primary text-xs" onClick={() => setOpen(open === "checkin" ? null : "checkin")}>
              Check in
            </button>
            <button className="btn text-xs" onClick={() => setOpen(open === "claim" ? null : "claim")}>
              Claim raised
            </button>
            <button className="btn text-xs" onClick={() => setOpen(open === "writeoff" ? null : "writeoff")}>
              Write off
            </button>
          </div>

          {open ? (
            <form
              className="flex flex-wrap items-center gap-2 rounded-lg p-2.5"
              style={{ background: "var(--bg)" }}
              onSubmit={(e) => {
                e.preventDefault();
                if (open === "checkin") run(() => receiveReturn({ returnId: row.id, restock, conditionNote: note }));
                else
                  run(() =>
                    closeReturnWithoutParcel({
                      returnId: row.id,
                      outcome: open === "claim" ? "claim_raised" : "written_off",
                      note,
                    }),
                  );
              }}
            >
              {open === "checkin" ? (
                <label className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" checked={restock} onChange={(e) => setRestock(e.target.checked)} />
                  Put back in stock
                </label>
              ) : null}
              <input
                aria-label="Note"
                className="input min-w-[10rem] flex-1"
                placeholder="Note (optional)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
              <button className="btn btn-primary" disabled={pending}>
                {pending ? <Spinner size="1rem" color="currentColor" /> : "Confirm"}
              </button>
            </form>
          ) : null}
        </div>
      )}
    </div>
  );
}
