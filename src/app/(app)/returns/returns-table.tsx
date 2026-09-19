"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Empty, Spinner, Stat } from "@/components/ui";
import { friendlyItem } from "@/lib/friendly-item";
import { withBasePath } from "@/lib/base-path";
import { cn, dayLabel, money } from "@/lib/utils";

import { LabelBars } from "../dashboard/finance-charts";
import { CancellationsPanel } from "../orders/cancellations-panel";
import type { CancellationRecord } from "../orders/queries";
import { ScanModal } from "../orders/scan/scan-modal";
import { closeOldReturns, closeReturnWithoutParcel, receiveReturn, reopenReturn } from "./actions";
import type { ReasonCount, ReturnDeskRow, ReturnsKpis, ReturnStage } from "./queries";

/**
 * The Returns desk.
 *
 * Two lists, one job each. "Customer returns" is what Amazon's Returns report
 * says customers sent back. "RTO & cancelled" is the existing check-in list for
 * parcels that never reached the customer. Every open return ends in a
 * decision (reshelved, damaged, written off, claim raised) rather than a tick.
 */

type Tab = "returns" | "rto";
type Filter = "todo" | "overdue" | "old" | "done";

const OUTCOME_LABEL: Record<string, string> = {
  reshelved: "Back in stock",
  damaged: "Damaged",
  written_off: "Written off",
  claim_raised: "Claim raised",
  closed: "Closed",
};

const STAGE: Record<ReturnStage, { label: string; color: string; bg: string }> = {
  transit: { label: "On its way", color: "var(--accent)", bg: "var(--accent-soft)" },
  arrived: { label: "Arrived", color: "var(--warn)", bg: "var(--warn-soft)" },
  overdue: { label: "Not received", color: "var(--danger)", bg: "var(--danger-soft)" },
  old: { label: "Older", color: "var(--muted)", bg: "rgba(148,152,171,0.14)" },
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

export function ReturnsDesk({
  rows,
  kpis,
  reasons,
  cancellations,
  cancelCounts,
  initialTab,
  resolvedCancel,
}: {
  rows: ReturnDeskRow[];
  kpis: ReturnsKpis;
  reasons: ReasonCount[];
  cancellations: CancellationRecord[];
  cancelCounts: { pending: number; completed: number };
  initialTab: Tab;
  resolvedCancel: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [filter, setFilter] = useState<Filter>("todo");
  const [scanning, setScanning] = useState(false);
  const [bulkPending, startBulk] = useTransition();

  function selectTab(next: Tab) {
    setTab(next);
    const q = new URLSearchParams(window.location.search);
    if (next === "rto") q.set("tab", "rto");
    else q.delete("tab");
    const s = q.toString();
    window.history.replaceState(null, "", withBasePath(s ? `/returns?${s}` : "/returns"));
  }

  const counts: Record<Filter, number> = {
    todo: rows.filter((r) => r.stage === "transit" || r.stage === "arrived" || r.stage === "overdue").length,
    overdue: rows.filter((r) => r.stage === "overdue").length,
    old: rows.filter((r) => r.stage === "old").length,
    done: rows.filter((r) => r.stage === "done").length,
  };

  const shown = rows.filter((r) =>
    filter === "todo" ? r.stage === "transit" || r.stage === "arrived" || r.stage === "overdue" : r.stage === filter,
  );

  const totalReasons = reasons.reduce((a, r) => a + r.count, 0);
  const sizeCount = reasons.filter((r) => SIZE_REASONS.has(r.reason)).reduce((a, r) => a + r.count, 0);

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <div
              className="inline-flex items-center gap-0.5 rounded-full border p-1"
              style={{ borderColor: "var(--border)", background: "var(--panel)" }}
            >
              {(
                [
                  { key: "returns", label: `Customer returns · ${counts.todo}` },
                  { key: "rto", label: `RTO & cancelled · ${cancelCounts.pending}` },
                ] as { key: Tab; label: string }[]
              ).map((t) => (
                <button
                  key={t.key}
                  onClick={() => selectTab(t.key)}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                    tab === t.key ? "text-white" : "muted hover:text-[var(--text)]",
                  )}
                  style={tab === t.key ? { background: "linear-gradient(135deg, var(--accent), var(--accent-2))" } : undefined}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <button className="btn btn-primary ml-auto text-xs" onClick={() => setScanning(true)}>
              Scan a return
            </button>
          </div>

          {tab === "returns" ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {(
                  [
                    ["todo", "To do"],
                    ["overdue", "Not received"],
                    ["old", "Older"],
                    ["done", "Done"],
                  ] as [Filter, string][]
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setFilter(key)}
                    className={cn("rounded-full border px-3 py-1 text-xs font-medium transition-colors", filter !== key && "muted")}
                    style={
                      filter === key
                        ? { background: "var(--accent-soft)", borderColor: "var(--accent)", color: "var(--text)" }
                        : { background: "var(--panel)", borderColor: "var(--border)" }
                    }
                  >
                    {label} <span className="tabular-nums">{counts[key]}</span>
                  </button>
                ))}
                {filter === "old" && counts.old > 0 ? (
                  <button
                    className="btn ml-auto text-xs"
                    disabled={bulkPending}
                    onClick={() => {
                      if (!window.confirm(`Close all ${counts.old} older returns? Stock is not changed.`)) return;
                      startBulk(async () => {
                        await closeOldReturns();
                        router.refresh();
                      });
                    }}
                  >
                    {bulkPending ? <Spinner size="1rem" /> : "Close all"}
                  </button>
                ) : null}
              </div>

              {shown.length === 0 ? (
                <div className="panel">
                  <Empty title={filter === "todo" ? "All caught up" : "Nothing here"} />
                </div>
              ) : (
                <div className="space-y-3">
                  {shown.map((r) => (
                    <ReturnCard key={r.id} row={r} onChanged={() => router.refresh()} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <CancellationsPanel
              records={cancellations}
              counts={cancelCounts}
              resolved={resolvedCancel}
              onResolvedChange={(next) => router.replace(`/returns?tab=rto${next ? "&resolved=1" : ""}`)}
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

      {scanning ? (
        <ScanModal
          station="inbound"
          onClose={() => setScanning(false)}
          onDone={() => {
            setScanning(false);
            router.refresh();
          }}
        />
      ) : null}
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
        <div className="min-w-0">
          <div className="truncate text-sm font-medium" title={it.name}>
            {it.name}
          </div>
          <div className="muted text-xs">
            {[it.size, it.color].filter(Boolean).join(" · ")}
            {row.requestedAt ? `${it.size || it.color ? " · " : ""}${dayLabel(new Date(row.requestedAt))}` : ""}
          </div>
        </div>
        <StagePill row={row} />
      </div>

      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <span>{row.reason}</span>
        {row.refundAmount ? <span className="font-medium tabular-nums">{money(row.refundAmount)} refunded</span> : null}
        {row.labelPaidBy === "Seller" && row.labelCost ? (
          <span className="muted tabular-nums text-xs">{money(row.labelCost)} label</span>
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
