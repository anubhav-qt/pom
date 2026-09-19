"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { CenteredSpinner, Empty, Spinner } from "@/components/ui";
import { friendlyItem } from "@/lib/friendly-item";
import type { LedgerRow, LedgerStatus } from "@/lib/finance-queries";
import { cn } from "@/lib/utils";

import { getLedger, saveOrderFinance } from "./ledger-actions";
import type { Basis } from "./range";

/**
 * The order ledger. One row per order in the range, showing what Amazon
 * actually paid us after everything it took, the cost we enter, and the profit
 * that leaves. Cost and note are the only editable cells; everything else is
 * Amazon's figure and stays read-only so the sheet can always be rebuilt.
 */

const INR2 = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2 });
const rupees = (n: number) => INR2.format(n);

const STATUS_STYLE: Record<LedgerStatus, { label: string; color: string; bg: string }> = {
  delivered: { label: "Delivered", color: "var(--ok)", bg: "var(--ok-soft)" },
  shipped: { label: "Shipped", color: "var(--accent)", bg: "var(--accent-soft)" },
  returned: { label: "Returned", color: "var(--danger)", bg: "var(--danger-soft)" },
  rto: { label: "RTO", color: "var(--warn)", bg: "var(--warn-soft)" },
  cancelled: { label: "Cancelled", color: "var(--muted)", bg: "rgba(148,152,171,0.14)" },
  in_progress: { label: "In progress", color: "var(--muted)", bg: "rgba(148,152,171,0.14)" },
};

const FILTERS: { key: "all" | LedgerStatus; label: string }[] = [
  { key: "all", label: "All" },
  { key: "delivered", label: "Delivered" },
  { key: "returned", label: "Returned" },
  { key: "rto", label: "RTO" },
  { key: "cancelled", label: "Cancelled" },
  { key: "shipped", label: "Shipped" },
];

function isoDay(d: Date): string {
  // India time, so the default range matches the wall calendar.
  return new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

function ItemCell({ title, count }: { title: string; count: number }) {
  const it = friendlyItem(title);
  return (
    <div className="min-w-0">
      <div className="truncate text-[13px] font-medium" title={it.name}>
        {it.name}
        {count > 1 ? <span className="muted font-normal"> +{count - 1} more</span> : null}
      </div>
      {it.size || it.color ? (
        <div className="muted text-xs">{[it.size, it.color].filter(Boolean).join(" · ")}</div>
      ) : null}
    </div>
  );
}

function StatusPill({ status }: { status: LedgerStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium"
      style={{ background: s.bg, color: s.color }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: s.color }} />
      {s.label}
    </span>
  );
}

const amountColor = (n: number) => (n < 0 ? "var(--danger)" : undefined);

export function LedgerView({ basis }: { basis: Basis }) {
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | LedgerStatus>("all");
  const [query, setQuery] = useState("");
  const [details, setDetails] = useState(false);
  const [exporting, setExporting] = useState<null | "csv" | "xlsx">(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getLedger({ from, to, basis }).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setRows(res.rows);
        setError(null);
      } else setError(res.error);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [from, to, basis]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (filter === "all" || r.status === filter) &&
        (!q || r.externalOrderId.toLowerCase().includes(q) || r.item.toLowerCase().includes(q)),
    );
  }, [rows, filter, query]);

  const totals = useMemo(() => {
    let net = 0;
    let cost = 0;
    let profit = 0;
    let missing = 0;
    let held = 0;
    for (const r of shown) {
      net += r.net;
      held += r.held;
      if (r.net === 0) continue;
      if (r.cost == null) missing++;
      else {
        cost += r.cost;
        profit += r.net - r.cost;
      }
    }
    return { net, cost, profit, missing, held };
  }, [shown]);

  function patchRow(orderId: number, change: Partial<LedgerRow>) {
    setRows((prev) =>
      prev.map((r) => {
        if (r.orderId !== orderId) return r;
        const next = { ...r, ...change };
        next.profit = next.cost == null || next.net === 0 ? null : next.net - next.cost;
        return next;
      }),
    );
  }

  async function exportAs(kind: "csv" | "xlsx") {
    setExporting(kind);
    try {
      const header = [
        "Order ID", "Order date", "Item", "Status", "Fees", "Postage", "Refunded", "Amazon net", "Cost", "Profit", "Note",
      ];
      const body = shown.map((r) => [
        r.externalOrderId,
        r.orderedAt.slice(0, 10),
        r.item,
        STATUS_STYLE[r.status].label,
        r.fees,
        r.postage,
        r.refunded,
        r.net,
        r.cost ?? "",
        r.profit ?? "",
        r.note,
      ]);
      const name = `paribelle-ledger-${from}_to_${to}`;
      if (kind === "csv") {
        const esc = (v: unknown) => {
          const s = String(v ?? "");
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const csv = [header, ...body].map((r) => r.map(esc).join(",")).join("\r\n");
        const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `${name}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      } else {
        const XLSX = await import("xlsx");
        const ws = XLSX.utils.aoa_to_sheet([header, ...body]);
        ws["!cols"] = header.map((_, i) => ({ wch: i === 2 ? 46 : i === 0 ? 21 : 14 }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Ledger");
        XLSX.writeFile(wb, `${name}.xlsx`);
      }
    } finally {
      setExporting(null);
    }
  }

  const colSpan = details ? 10 : 7;
  const searchPlaceholder = "Search item or order";

  return (
    <div className="space-y-4">
      {/* --------------------------------------------------------- controls */}
      <div className="panel flex flex-wrap items-end gap-3 p-4">
        <label className="text-xs">
          <span className="muted mb-1 block font-medium">From</span>
          <input
            id="ledger-from"
            type="date"
            className="input"
            value={from}
            max={to}
            onChange={(e) => e.target.value && setFrom(e.target.value)}
          />
        </label>
        <label className="text-xs">
          <span className="muted mb-1 block font-medium">To</span>
          <input
            id="ledger-to"
            type="date"
            className="input"
            value={to}
            min={from}
            onChange={(e) => e.target.value && setTo(e.target.value)}
          />
        </label>
        <input
          id="ledger-search"
          className="input min-w-[10rem] flex-1 sm:max-w-xs"
          placeholder={searchPlaceholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button className="btn text-xs" onClick={() => setDetails((d) => !d)}>
            {details ? "Hide details" : "Details"}
          </button>
          <button className="btn text-xs" disabled={exporting !== null || shown.length === 0} onClick={() => exportAs("csv")}>
            {exporting === "csv" ? <Spinner size="1rem" /> : "Export CSV"}
          </button>
          <button
            className="btn btn-primary text-xs"
            disabled={exporting !== null || shown.length === 0}
            onClick={() => exportAs("xlsx")}
          >
            {exporting === "xlsx" ? <Spinner size="1rem" color="currentColor" /> : "Export Excel"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const n = f.key === "all" ? rows.length : rows.filter((r) => r.status === f.key).length;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn("rounded-full border px-3 py-1 text-xs font-medium transition-colors", filter !== f.key && "muted")}
              style={
                filter === f.key
                  ? { background: "var(--accent-soft)", borderColor: "var(--accent)", color: "var(--text)" }
                  : { background: "var(--panel)", borderColor: "var(--border)" }
              }
            >
              {f.label} <span className="tabular-nums">{n}</span>
            </button>
          );
        })}
      </div>

      {error ? <p className="rounded-md bg-rose-500/10 px-3 py-2 text-sm text-rose-600">{error}</p> : null}

      {loading ? (
        <div className="panel">
          <CenteredSpinner />
        </div>
      ) : shown.length === 0 ? (
        <div className="panel">
          <Empty title="No orders in this range" />
        </div>
      ) : (
        <>
          {/* -------------------------------------------- desktop / tablet table */}
          <div className="panel hidden overflow-x-auto md:block">
            <table className="grid-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Item</th>
                  <th>Status</th>
                  {details ? (
                    <>
                      <th className="text-right">Fees</th>
                      <th className="text-right">Postage</th>
                      <th className="text-right">Refunded</th>
                    </>
                  ) : null}
                  <th className="text-right">Amazon net</th>
                  <th className="text-right">Cost</th>
                  <th className="text-right">Profit</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.orderId}>
                    <td className="whitespace-nowrap text-xs">
                      {new Date(r.orderedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                    </td>
                    <td className="max-w-[18rem]">
                      <ItemCell title={r.item} count={r.itemCount} />
                      <div className="muted font-mono text-[10px]" title="Amazon order ID">{r.externalOrderId}</div>
                    </td>
                    <td>
                      <StatusPill status={r.status} />
                    </td>
                    {details ? (
                      <>
                        <td className="text-right text-xs tabular-nums" style={{ color: amountColor(r.fees) }}>{rupees(r.fees)}</td>
                        <td className="text-right text-xs tabular-nums" style={{ color: amountColor(r.postage) }}>{rupees(r.postage)}</td>
                        <td className="text-right text-xs tabular-nums" style={{ color: amountColor(r.refunded) }}>{rupees(r.refunded)}</td>
                      </>
                    ) : null}
                    <td className="text-right text-sm font-medium tabular-nums" style={{ color: amountColor(r.net) }}>
                      {rupees(r.net)}
                      {r.held !== 0 ? <div className="muted text-[11px] font-normal">{rupees(r.held)} held</div> : null}
                    </td>
                    <td className="text-right">
                      <CostInput row={r} onChange={patchRow} />
                    </td>
                    <td className="text-right text-sm font-semibold tabular-nums" style={{ color: r.profit == null ? "var(--muted-2)" : amountColor(r.profit) ?? "var(--ok)" }}>
                      {r.profit == null ? "—" : rupees(r.profit)}
                    </td>
                    <td>
                      <NoteInput row={r} onChange={patchRow} />
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: "var(--panel-2)" }}>
                  <td colSpan={colSpan - 4} className="text-xs font-semibold">
                    {shown.length} order{shown.length === 1 ? "" : "s"}
                    {totals.missing > 0 ? (
                      <span className="muted font-normal"> · {totals.missing} without a cost yet</span>
                    ) : null}
                  </td>
                  <td className="text-right text-sm font-semibold tabular-nums">{rupees(totals.net)}</td>
                  <td className="text-right text-sm font-semibold tabular-nums">{rupees(totals.cost)}</td>
                  <td className="text-right text-sm font-semibold tabular-nums" style={{ color: totals.profit < 0 ? "var(--danger)" : "var(--ok)" }}>
                    {rupees(totals.profit)}
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>

          {/* --------------------------------------------------- phone cards */}
          <div className="space-y-3 md:hidden">
            {shown.map((r) => (
              <div key={r.orderId} className="panel space-y-2.5 p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <ItemCell title={r.item} count={r.itemCount} />
                    <div className="muted mt-0.5 text-[11px]">
                      {new Date(r.orderedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                    </div>
                  </div>
                  <StatusPill status={r.status} />
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <div className="muted text-[10px] uppercase tracking-wider">Amazon net</div>
                    <div className="font-semibold tabular-nums" style={{ color: amountColor(r.net) }}>{rupees(r.net)}</div>
                    {r.held !== 0 ? <div className="muted text-[10px]">{rupees(r.held)} held</div> : null}
                  </div>
                  <div>
                    <div className="muted text-[10px] uppercase tracking-wider">Cost</div>
                    <CostInput row={r} onChange={patchRow} />
                  </div>
                  <div>
                    <div className="muted text-[10px] uppercase tracking-wider">Profit</div>
                    <div className="font-semibold tabular-nums" style={{ color: r.profit == null ? "var(--muted-2)" : amountColor(r.profit) ?? "var(--ok)" }}>
                      {r.profit == null ? "—" : rupees(r.profit)}
                    </div>
                  </div>
                </div>
                {details ? (
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 border-t pt-2 text-[11px]" style={{ borderColor: "var(--border)" }}>
                    <span className="muted">Fees</span><span className="text-right tabular-nums">{rupees(r.fees)}</span>
                    <span className="muted">Postage</span><span className="text-right tabular-nums">{rupees(r.postage)}</span>
                    <span className="muted">Refunded</span><span className="text-right tabular-nums">{rupees(r.refunded)}</span>
                  </div>
                ) : null}
                <NoteInput row={r} onChange={patchRow} />
              </div>
            ))}
            <div className="panel space-y-1 p-3.5 text-sm" style={{ background: "var(--panel-2)" }}>
              <div className="flex justify-between"><span className="muted">{shown.length} orders</span><span className="font-semibold tabular-nums">{rupees(totals.net)}</span></div>
              <div className="flex justify-between"><span className="muted">Cost entered</span><span className="tabular-nums">{rupees(totals.cost)}</span></div>
              <div className="flex justify-between"><span className="muted">Profit</span><span className="font-semibold tabular-nums" style={{ color: totals.profit < 0 ? "var(--danger)" : "var(--ok)" }}>{rupees(totals.profit)}</span></div>
              {totals.missing > 0 ? <div className="muted text-xs">{totals.missing} orders have no cost yet.</div> : null}
            </div>
          </div>
        </>
      )}

    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Editable cells                                                              */
/* -------------------------------------------------------------------------- */

type SaveState = "idle" | "saving" | "saved" | "error";

function useSaver() {
  const [state, setState] = useState<SaveState>("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  async function run(fn: () => Promise<{ ok: boolean }>) {
    setState("saving");
    try {
      const res = await fn();
      setState(res.ok ? "saved" : "error");
    } catch {
      setState("error");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1600);
  }
  return { state, run };
}

function CostInput({ row, onChange }: { row: LedgerRow; onChange: (id: number, c: Partial<LedgerRow>) => void }) {
  const { state, run } = useSaver();
  const [text, setText] = useState(row.cost == null ? "" : String(row.cost));
  useEffect(() => setText(row.cost == null ? "" : String(row.cost)), [row.cost]);

  return (
    <div className="flex items-center justify-end gap-1.5">
      {state === "saving" ? <Spinner size="0.9rem" /> : state === "saved" ? <span className="text-xs" style={{ color: "var(--ok)" }}>✓</span> : null}
      <input
        inputMode="decimal"
        aria-label={`Cost of order ${row.externalOrderId}`}
        className="input w-24 text-right tabular-nums"
        style={row.cost != null && !row.costSaved ? { color: "var(--muted)" } : undefined}
        placeholder="0.00"
        value={text}
        onChange={(e) => setText(e.target.value.replace(/[^0-9.]/g, ""))}
        onBlur={() => {
          const cost = text === "" ? null : Number(text);
          if (cost === row.cost || (cost !== null && !Number.isFinite(cost))) return;
          onChange(row.orderId, { cost, costSaved: cost !== null });
          run(() => saveOrderFinance({ orderId: row.orderId, cost, note: row.note }));
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </div>
  );
}

function NoteInput({ row, onChange }: { row: LedgerRow; onChange: (id: number, c: Partial<LedgerRow>) => void }) {
  const { state, run } = useSaver();
  const [text, setText] = useState(row.note);
  useEffect(() => setText(row.note), [row.note]);

  return (
    <div className="flex items-center gap-1.5">
      <input
        aria-label={`Note for order ${row.externalOrderId}`}
        className="input w-full min-w-[9rem]"
        placeholder="Add a note"
        maxLength={500}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text === row.note) return;
          onChange(row.orderId, { note: text });
          run(() => saveOrderFinance({ orderId: row.orderId, cost: row.costSaved ? row.cost : null, note: text }));
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {state === "saving" ? <Spinner size="0.9rem" /> : state === "saved" ? <span className="text-xs" style={{ color: "var(--ok)" }}>✓</span> : null}
    </div>
  );
}
