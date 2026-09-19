"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Segmented } from "@/components/segmented";
import { CenteredSpinner, Empty, Spinner } from "@/components/ui";
import { friendlyItem } from "@/lib/friendly-item";
import type { LedgerRow, LedgerStatus, ProductLedgerRow } from "@/lib/finance-queries";
import { useDashboardCache } from "@/lib/stores/dashboard-cache";
import { ledgerKey, useLedgerCache, useLedgerNav } from "@/lib/stores/ledger-cache";
import { useOrdersCache } from "@/lib/stores/orders-cache";

import { OrderThumb } from "../orders/order-table";
import { getLedger, saveOrderNote, setProductCost, type LedgerData } from "./ledger-actions";
import type { Basis } from "./range";

/**
 * The ledger. Two views of the same money:
 *
 *  - Products: one row per product (every size and colour together) with its
 *    picture, what Amazon paid for it, and the one cost price we enter. It costs
 *    orders that have no cost yet; orders already costed keep theirs.
 *  - Orders: one row per order, read-only apart from a note, with cost and
 *    profit worked out from those product cost prices.
 *
 * Read through the ledger cache like every other screen, so coming back to it,
 * or to a date range already seen, does not go to the database again.
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

const amountColor = (n: number) => (n < 0 ? "var(--danger)" : undefined);
const profitColor = (n: number | null) => (n == null ? "var(--muted-2)" : n < 0 ? "var(--danger)" : "var(--ok)");

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

export function LedgerView({ basis }: { basis: Basis }) {
  const from = useLedgerNav((s) => s.from);
  const to = useLedgerNav((s) => s.to);
  const view = useLedgerNav((s) => s.view);
  const setNav = useLedgerNav((s) => s.set);
  const syncStamp = useOrdersCache((s) => s.syncStamp);

  const [data, setData] = useState<LedgerData | null>(() => useLedgerCache.getState().peek(ledgerKey(from, to, basis)));
  const [loading, setLoading] = useState(data === null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | LedgerStatus>("all");
  const [query, setQuery] = useState("");
  const [details, setDetails] = useState(false);
  const [exporting, setExporting] = useState<null | "csv" | "xlsx">(null);

  const key = ledgerKey(from, to, basis);

  useEffect(() => {
    let cancelled = false;
    const cache = useLedgerCache.getState();
    const cached = cache.peek(key);
    if (cached) setData(cached);
    else setLoading(true);

    cache
      .load(key, async () => {
        const res = await getLedger({ from, to, basis });
        if (!res.ok) throw new Error(res.error);
        return { products: res.products, orders: res.orders };
      })
      .then((fresh) => {
        if (cancelled) return;
        setData(fresh);
        setError(null);
        setLoading(false);
        // A stale entry answers at once while a refresh runs; pick that up too.
        useLedgerCache.getState().entries[key]?.inFlight?.then((latest) => !cancelled && setData(latest)).catch(() => {});
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not load the ledger.");
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, syncStamp]);

  /** A cost changed: every number that depends on it is stale, so re-read this range. */
  async function refetch() {
    useLedgerCache.getState().clear();
    useDashboardCache.getState().clear();
    const res = await getLedger({ from, to, basis });
    if (res.ok) {
      const fresh = { products: res.products, orders: res.orders };
      useLedgerCache.getState().put(key, fresh);
      setData(fresh);
    }
  }

  const products = data?.products ?? [];
  const orders = data?.orders ?? [];

  const q = query.trim().toLowerCase();

  const shownProducts = useMemo(
    () => products.filter((p) => !q || p.name.toLowerCase().includes(q) || p.skus.some((s) => s.toLowerCase().includes(q))),
    [products, q],
  );

  const shownOrders = useMemo(
    () =>
      orders.filter(
        (r) =>
          (filter === "all" || r.status === filter) &&
          (!q || r.externalOrderId.toLowerCase().includes(q) || r.item.toLowerCase().includes(q)),
      ),
    [orders, filter, q],
  );

  const productTotals = useMemo(() => {
    let net = 0;
    let cost = 0;
    let profit = 0;
    let missing = 0;
    for (const p of shownProducts) {
      net += p.net;
      if (p.units === 0) continue;
      if (p.cost == null) missing++;
      cost += p.costTotal;
      profit += p.profit ?? 0;
    }
    return { net, cost, profit, missing };
  }, [shownProducts]);

  const orderTotals = useMemo(() => {
    let net = 0;
    let cost = 0;
    let profit = 0;
    let missing = 0;
    for (const r of shownOrders) {
      net += r.net;
      if (r.net === 0) continue;
      if (r.cost == null) missing++;
      else {
        cost += r.cost;
        profit += r.net - r.cost;
      }
    }
    return { net, cost, profit, missing };
  }, [shownOrders]);

  function patchNote(orderId: number, note: string) {
    setData((prev) => (prev ? { ...prev, orders: prev.orders.map((r) => (r.orderId === orderId ? { ...r, note } : r)) } : prev));
    const cur = useLedgerCache.getState().peek(key);
    if (cur) useLedgerCache.getState().put(key, { ...cur, orders: cur.orders.map((r) => (r.orderId === orderId ? { ...r, note } : r)) });
  }

  async function exportAs(kind: "csv" | "xlsx") {
    setExporting(kind);
    try {
      const byProduct = view === "products";
      const header = byProduct
        ? ["Product", "SKUs", "Units", "Amazon net", "Cost per unit", "Profit"]
        : ["Order ID", "Order date", "Item", "Status", "Fees", "Postage", "Refunded", "Amazon net", "Cost", "Profit", "Note"];
      const body = byProduct
        ? shownProducts.map((p) => [p.name, p.skus.join(" "), p.units, p.net, p.cost ?? "", p.profit ?? ""])
        : shownOrders.map((r) => [
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
      const name = `paribelle-${byProduct ? "products" : "orders"}-${from}_to_${to}`;
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
        ws["!cols"] = header.map((_, i) => ({ wch: i === (byProduct ? 0 : 2) ? 46 : i === 0 ? 21 : 14 }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, byProduct ? "Products" : "Orders");
        XLSX.writeFile(wb, `${name}.xlsx`);
      }
    } finally {
      setExporting(null);
    }
  }

  const rowCount = view === "products" ? shownProducts.length : shownOrders.length;

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
            onChange={(e) => e.target.value && setNav({ from: e.target.value })}
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
            onChange={(e) => e.target.value && setNav({ to: e.target.value })}
          />
        </label>
        <input
          id="ledger-search"
          className="input min-w-[10rem] flex-1 sm:max-w-xs"
          placeholder={view === "products" ? "Search product or SKU" : "Search item or order"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {view === "orders" ? (
            <button className="btn text-xs" onClick={() => setDetails((d) => !d)}>
              {details ? "Hide details" : "Details"}
            </button>
          ) : null}
          <button className="btn text-xs" disabled={exporting !== null || rowCount === 0} onClick={() => exportAs("csv")}>
            {exporting === "csv" ? <Spinner size="1rem" /> : "Export CSV"}
          </button>
          <button
            className="btn btn-primary text-xs"
            disabled={exporting !== null || rowCount === 0}
            onClick={() => exportAs("xlsx")}
          >
            {exporting === "xlsx" ? <Spinner size="1rem" color="currentColor" /> : "Export Excel"}
          </button>
        </div>
      </div>

      {view === "orders" ? (
        <Segmented
          label="Order status"
          className="self-start"
          items={FILTERS.map((f) => ({
            key: f.key,
            label: f.label,
            count: f.key === "all" ? orders.length : orders.filter((r) => r.status === f.key).length,
          }))}
          value={filter}
          onChange={setFilter}
        />
      ) : null}

      {error ? <p className="rounded-md bg-rose-500/10 px-3 py-2 text-sm text-rose-600">{error}</p> : null}

      {loading && !data ? (
        <div className="panel">
          <CenteredSpinner />
        </div>
      ) : rowCount === 0 ? (
        <div className="panel">
          <Empty title={view === "products" ? "No products found" : "No orders in this range"} />
        </div>
      ) : view === "products" ? (
        <ProductsTable rows={shownProducts} totals={productTotals} onSaved={refetch} />
      ) : (
        <OrdersTable
          rows={shownOrders}
          totals={orderTotals}
          details={details}
          onNote={patchNote}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Products                                                                    */
/* -------------------------------------------------------------------------- */

interface Totals {
  net: number;
  cost: number;
  profit: number;
  missing: number;
}

function ProductInfo({ p }: { p: ProductLedgerRow }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 items-center gap-3">
      <OrderThumb src={p.imageUrl} alt={p.name} size="h-11 w-11" />
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium" title={p.name}>
          {p.name}
        </div>
        <button type="button" className="muted text-xs underline decoration-dotted" onClick={() => setOpen((v) => !v)}>
          {p.skus.length} SKU{p.skus.length === 1 ? "" : "s"}
        </button>
        {open ? (
          <div className="muted mt-1 flex max-w-[22rem] flex-wrap gap-x-2 gap-y-0.5 font-mono text-[10px]">
            {p.skus.map((s) => (
              <span key={s}>{s}</span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ProductsTable({
  rows,
  totals,
  onSaved,
}: {
  rows: ProductLedgerRow[];
  totals: Totals;
  onSaved: () => Promise<void>;
}) {
  return (
    <>
      <div className="panel hidden overflow-x-auto md:block">
        <table className="grid-table">
          <thead>
            <tr>
              <th>Product</th>
              <th className="text-right">Units</th>
              <th className="text-right">Amazon net</th>
              <th className="text-right">Cost per unit</th>
              <th className="text-right">Profit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.key}>
                <td className="max-w-[26rem]">
                  <ProductInfo p={p} />
                </td>
                <td className="text-right text-sm tabular-nums">{p.units}</td>
                <td className="text-right text-sm font-medium tabular-nums" style={{ color: amountColor(p.net) }}>
                  {rupees(p.net)}
                </td>
                <td className="text-right">
                  <CostInput product={p} onSaved={onSaved} />
                </td>
                <td className="text-right text-sm font-semibold tabular-nums" style={{ color: profitColor(p.profit) }}>
                  {p.profit == null ? "—" : rupees(p.profit)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ background: "var(--panel-2)" }}>
              <td colSpan={2} className="text-xs font-semibold">
                {rows.length} products
                {totals.missing > 0 ? <span className="muted font-normal"> · {totals.missing} without a cost yet</span> : null}
              </td>
              <td className="text-right text-sm font-semibold tabular-nums">{rupees(totals.net)}</td>
              <td className="text-right text-sm font-semibold tabular-nums">{rupees(totals.cost)}</td>
              <td className="text-right text-sm font-semibold tabular-nums" style={{ color: profitColor(totals.profit) }}>
                {rupees(totals.profit)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="space-y-3 md:hidden">
        {rows.map((p) => (
          <div key={p.key} className="panel space-y-2.5 p-3.5">
            <ProductInfo p={p} />
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div>
                <div className="muted text-[10px] uppercase tracking-wider">Amazon net</div>
                <div className="font-semibold tabular-nums" style={{ color: amountColor(p.net) }}>
                  {rupees(p.net)}
                </div>
                <div className="muted text-[10px]">{p.units} units</div>
              </div>
              <div>
                <div className="muted text-[10px] uppercase tracking-wider">Cost per unit</div>
                <CostInput product={p} onSaved={onSaved} />
              </div>
              <div>
                <div className="muted text-[10px] uppercase tracking-wider">Profit</div>
                <div className="font-semibold tabular-nums" style={{ color: profitColor(p.profit) }}>
                  {p.profit == null ? "—" : rupees(p.profit)}
                </div>
              </div>
            </div>
          </div>
        ))}
        <div className="panel space-y-1 p-3.5 text-sm" style={{ background: "var(--panel-2)" }}>
          <div className="flex justify-between">
            <span className="muted">{rows.length} products</span>
            <span className="font-semibold tabular-nums">{rupees(totals.net)}</span>
          </div>
          <div className="flex justify-between">
            <span className="muted">Cost</span>
            <span className="tabular-nums">{rupees(totals.cost)}</span>
          </div>
          <div className="flex justify-between">
            <span className="muted">Profit</span>
            <span className="font-semibold tabular-nums" style={{ color: profitColor(totals.profit) }}>
              {rupees(totals.profit)}
            </span>
          </div>
          {totals.missing > 0 ? <div className="muted text-xs">{totals.missing} products have no cost yet.</div> : null}
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Orders                                                                      */
/* -------------------------------------------------------------------------- */

function OrdersTable({
  rows,
  totals,
  details,
  onNote,
}: {
  rows: LedgerRow[];
  totals: Totals;
  details: boolean;
  onNote: (orderId: number, note: string) => void;
}) {
  const colSpan = details ? 6 : 3;
  return (
    <>
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
            {rows.map((r) => (
              <tr key={r.orderId}>
                <td className="whitespace-nowrap text-xs">
                  {new Date(r.orderedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
                </td>
                <td className="max-w-[18rem]">
                  <ItemCell title={r.item} count={r.itemCount} />
                  <div className="muted font-mono text-[10px]" title="Amazon order ID">
                    {r.externalOrderId}
                  </div>
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
                <td className="text-right text-sm tabular-nums">{r.cost == null ? <span className="muted">—</span> : rupees(r.cost)}</td>
                <td className="text-right text-sm font-semibold tabular-nums" style={{ color: profitColor(r.profit) }}>
                  {r.profit == null ? "—" : rupees(r.profit)}
                </td>
                <td>
                  <NoteInput row={r} onSaved={onNote} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ background: "var(--panel-2)" }}>
              <td colSpan={colSpan} className="text-xs font-semibold">
                {rows.length} order{rows.length === 1 ? "" : "s"}
                {totals.missing > 0 ? <span className="muted font-normal"> · {totals.missing} without a cost yet</span> : null}
              </td>
              <td className="text-right text-sm font-semibold tabular-nums">{rupees(totals.net)}</td>
              <td className="text-right text-sm font-semibold tabular-nums">{rupees(totals.cost)}</td>
              <td className="text-right text-sm font-semibold tabular-nums" style={{ color: profitColor(totals.profit) }}>
                {rupees(totals.profit)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="space-y-3 md:hidden">
        {rows.map((r) => (
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
                <div className="tabular-nums">{r.cost == null ? "—" : rupees(r.cost)}</div>
              </div>
              <div>
                <div className="muted text-[10px] uppercase tracking-wider">Profit</div>
                <div className="font-semibold tabular-nums" style={{ color: profitColor(r.profit) }}>
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
            <NoteInput row={r} onSaved={onNote} />
          </div>
        ))}
        <div className="panel space-y-1 p-3.5 text-sm" style={{ background: "var(--panel-2)" }}>
          <div className="flex justify-between"><span className="muted">{rows.length} orders</span><span className="font-semibold tabular-nums">{rupees(totals.net)}</span></div>
          <div className="flex justify-between"><span className="muted">Cost</span><span className="tabular-nums">{rupees(totals.cost)}</span></div>
          <div className="flex justify-between"><span className="muted">Profit</span><span className="font-semibold tabular-nums" style={{ color: profitColor(totals.profit) }}>{rupees(totals.profit)}</span></div>
          {totals.missing > 0 ? <div className="muted text-xs">{totals.missing} orders have no cost yet.</div> : null}
        </div>
      </div>
    </>
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

function CostInput({ product, onSaved }: { product: ProductLedgerRow; onSaved: () => Promise<void> }) {
  const { state, run } = useSaver();
  const [text, setText] = useState(product.cost == null ? "" : String(product.cost));
  useEffect(() => setText(product.cost == null ? "" : String(product.cost)), [product.cost]);

  return (
    <div className="flex items-center justify-end gap-1.5">
      {state === "saving" ? <Spinner size="0.9rem" /> : state === "saved" ? <span className="text-xs" style={{ color: "var(--ok)" }}>✓</span> : null}
      <input
        inputMode="decimal"
        aria-label={`Cost per unit of ${product.name}`}
        className="input w-24 text-right tabular-nums"
        placeholder="0.00"
        value={text}
        onChange={(e) => setText(e.target.value.replace(/[^0-9.]/g, ""))}
        onBlur={() => {
          const cost = text === "" ? null : Number(text);
          if (cost === product.cost || (cost !== null && !Number.isFinite(cost))) return;
          run(async () => {
            const res = await setProductCost({ key: product.key, cost });
            if (res.ok) await onSaved();
            return res;
          });
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
    </div>
  );
}

function NoteInput({ row, onSaved }: { row: LedgerRow; onSaved: (orderId: number, note: string) => void }) {
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
          onSaved(row.orderId, text);
          run(() => saveOrderNote({ orderId: row.orderId, note: text }));
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {state === "saving" ? <Spinner size="0.9rem" /> : state === "saved" ? <span className="text-xs" style={{ color: "var(--ok)" }}>✓</span> : null}
    </div>
  );
}
