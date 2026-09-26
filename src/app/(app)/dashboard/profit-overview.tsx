"use client";

import { useState } from "react";

import { Empty } from "@/components/ui";
import type { FlowLine, MonthRow, ProductRow, ProfitView } from "@/lib/profit";

import { rangeLabel } from "./range";
import type { DashboardView } from "./view-actions";

/**
 * Finance › Overview: the real profit on Amazon orders, one screen.
 *
 * Read top to bottom it answers, in order: did we make money (the strip), how
 * sales became profit (the statement and one kept order), where the cash is
 * right now, what returns do to it, and then the detail (months, products,
 * tax). Numbers come from `lib/profit.ts`; this file only lays them out.
 *
 * Colour is kept for meaning: sky for money in, slate for money out, amber for
 * money on hold, and green or red only on a profit figure, always with its sign.
 * The same markup prints to A4 through the PDF button (see globals.css).
 */

const IN = "var(--accent)";
const OUT = "var(--muted-2)";
const HELD = "var(--warn)";

const NUM = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

function inr(v: number, sign = false): string {
  const r = Math.round(v);
  const s = r < 0 ? "−" : sign && r > 0 ? "+" : "";
  return `${s}₹${NUM.format(Math.abs(r))}`;
}
const num = (v: number) => NUM.format(Math.round(v));
const pct = (v: number | null, digits = 0) => (v == null ? "–" : `${(v * 100).toFixed(digits)}%`);
const profitColor = (v: number) => (v < 0 ? "var(--danger)" : "var(--ok)");

function istDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
}

export function ProfitOverview({ view }: { view: DashboardView }) {
  const p = view.profit;

  if (view.lineCount === 0) {
    return (
      <div className="panel">
        <Empty title="No money data yet" hint="Press Sync now." />
      </div>
    );
  }

  const label = rangeLabel(view.range);

  return (
    <div className="print-sheet space-y-5 sm:space-y-[7px]">
      <PrintHeader label={label} generatedAt={view.generatedAt} />

      <Summary view={view} />

      {p.orders.placed === 0 ? (
        <div className="panel">
          <Empty title="No orders placed in this range" hint="Pick a longer range or another month." />
        </div>
      ) : (
        <>
          <div className="grid gap-5 sm:gap-[7px] lg:grid-cols-5 [&>*]:min-w-0">
            <Statement p={p} label={label} />
            <PerOrder p={p} />
          </div>

          <div className="grid gap-5 sm:gap-[7px] lg:grid-cols-2 print:grid-cols-2 [&>*]:min-w-0">
            <MoneyNow view={view} />
            <Returns p={p} />
          </div>

          {p.months.length > 1 ? <Months months={p.months} /> : null}

          <Products rows={p.products} small={p.smallProducts} ads={p.flowOut.find((l) => l.key === "ads")?.value ?? 0} />

          <div className="grid gap-5 sm:gap-[7px] lg:grid-cols-2 print:grid-cols-2 [&>*]:min-w-0">
            <Tax p={p} />
            <Notes p={p} />
          </div>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

function Panel({
  title,
  aside,
  className,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`panel break-inside-avoid p-5 ${className ?? ""}`}>
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside ? <div className="muted text-right text-[11.5px]">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="muted text-[11px] font-medium uppercase tracking-wider">{children}</div>;
}

function Dot({ color }: { color: string }) {
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />;
}

/** Shown only on paper: what the PDF is and when it was made. */
function PrintHeader({ label, generatedAt }: { label: string; generatedAt: string }) {
  const at = new Date(generatedAt).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
  return (
    <div className="print-only mb-2">
      <div className="flex items-baseline justify-between gap-4">
        <span className="text-[26px] leading-none" style={{ fontFamily: "var(--font-logo)", color: "#3a2a30" }}>
          PariBelle
        </span>
        <span className="muted text-[11px]">{at}</span>
      </div>
      <div className="mt-2 text-[15px] font-semibold">Amazon profit · {label}</div>
      <div className="muted text-[11.5px]">Orders placed in the period, with everything that happened to them since.</div>
    </div>
  );
}

/* ---------------------------------------------------------------- the strip */

function Summary({ view }: { view: DashboardView }) {
  const p = view.profit;
  const m = view.money;
  const o = p.orders;
  const after = p.pending ? Math.round((p.profit + p.pending.impact) / 1000) * 1000 : null;

  return (
    <section className="panel grid grid-cols-2 gap-px overflow-hidden lg:grid-cols-4" style={{ background: "var(--border)" }}>
      <Kpi label="Profit" value={inr(p.profit)} color={profitColor(p.profit)} big>
        <span>{pct(p.margin, 1)} of kept sales</span>
        <span>{p.perKept == null ? "–" : inr(p.perKept)} per kept order</span>
      </Kpi>
      <Kpi
        label="Once returns land"
        value={after == null ? inr(p.profit) : `≈ ${inr(after)}`}
        color={profitColor(after ?? p.profit)}
      >
        {p.pending ? (
          <>
            <span>{num(p.pending.expected)} more returns expected</span>
            <span>at the usual {pct(p.pending.usualRate)}</span>
          </>
        ) : (
          <span>No returns still due</span>
        )}
      </Kpi>
      <Kpi label="Return rate" value={pct(o.returnRate)}>
        <span>
          {num(o.returned)} of {num(o.kept + o.returned)} delivered
        </span>
        <span>RTO {pct(o.rtoRate)}</span>
      </Kpi>
      <Kpi label="Amazon owes you" value={inr(m.owed)} tag="Today">
        <span>{inr(m.nextPayout)} next payout</span>
        <span>{inr(m.held)} on hold</span>
      </Kpi>
    </section>
  );
}

function Kpi({
  label,
  value,
  color,
  big,
  tag,
  children,
}: {
  label: string;
  value: string;
  color?: string;
  big?: boolean;
  tag?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 px-4 py-4 sm:px-5" style={{ background: "var(--panel)" }}>
      <div className="flex items-center justify-between gap-2">
        <Label>{label}</Label>
        {tag ? (
          <span className="muted text-[10.5px] font-medium" style={{ color: "var(--muted-2)" }}>
            {tag}
          </span>
        ) : null}
      </div>
      <div
        className={`font-semibold leading-none tabular-nums ${big ? "text-[1.9rem]" : "text-[1.45rem]"}`}
        style={{ color: color ?? "var(--text)" }}
      >
        {value}
      </div>
      <div className="muted flex flex-col text-[12px] leading-snug">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------- sales to profit */

function Statement({ p, label }: { p: ProfitView; label: string }) {
  const max = Math.max(1, ...[...p.flowIn, ...p.flowOut].map((l) => Math.abs(l.value)), p.cogs);

  return (
    <Panel
      title="Sales to profit"
      aside={label === "All time" ? "Every order so far" : `Orders placed · ${label}`}
      className="lg:col-span-3"
    >
      <div className="flex flex-col">
        {p.flowIn.map((l) => (
          <FlowRow key={l.key} line={l} max={max} color={IN} />
        ))}
        <div className="my-1.5" />
        {p.flowOut.map((l) => (
          <FlowRow key={l.key} line={l} max={max} color={OUT} />
        ))}
        <TotalRow label="Amazon net" note="paid or owed to you" value={p.net} />
        <FlowRow line={{ key: "cogs", label: "Cost of goods kept", value: -p.cogs, note: "at your cost price" }} max={max} color={OUT} />
        <TotalRow label="Profit" value={p.profit} color={profitColor(p.profit)} strong />
      </div>
    </Panel>
  );
}

/** Label, bar, value; on a phone the bar drops under the row so it keeps its length. */
const ROW =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-[5px] sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_7rem] sm:gap-y-0";
const BAR = "order-last col-span-2 h-1.5 sm:order-none sm:col-span-1 sm:h-2";
const STEP_ROW =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-[5px] sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_4.5rem] sm:gap-y-0";

function FlowRow({ line, max, color }: { line: FlowLine; max: number; color: string }) {
  const w = Math.max(0.4, (Math.abs(line.value) / max) * 100);
  return (
    <div className={ROW}>
      <div className="min-w-0 truncate text-[13px]" title={line.note}>
        {line.label}
        {line.note ? <span className="muted hidden text-[11.5px] sm:inline"> · {line.note}</span> : null}
      </div>
      <div className={BAR} title={`${line.label}: ${inr(line.value)}`}>
        <div className="h-full rounded-r-[3px]" style={{ width: `${w}%`, background: color }} />
      </div>
      <div className="text-right text-[13px] tabular-nums">{inr(line.value)}</div>
    </div>
  );
}

function TotalRow({
  label,
  note,
  value,
  color,
  strong,
}: {
  label: string;
  note?: string;
  value: number;
  color?: string;
  strong?: boolean;
}) {
  return (
    <div
      className="mt-1.5 flex items-baseline justify-between gap-3 border-t pt-2.5 pb-1.5"
      style={{ borderColor: strong ? "var(--border-strong)" : "var(--border)" }}
    >
      <div className={strong ? "text-[14px] font-semibold" : "text-[13px] font-semibold"}>
        {label}
        {note ? <span className="muted text-[11.5px] font-normal"> · {note}</span> : null}
      </div>
      <div
        className={`tabular-nums ${strong ? "text-[17px] font-semibold" : "text-[13px] font-semibold"}`}
        style={{ color: color ?? "var(--text)" }}
      >
        {inr(value)}
      </div>
    </div>
  );
}

/* --------------------------------------------------------- one kept order */

function PerOrder({ p }: { p: ProfitView }) {
  const b = p.perOrder;
  if (!b) {
    return (
      <Panel title="One kept order" className="lg:col-span-2">
        <p className="muted text-[13px]">No kept orders in this range yet.</p>
      </Panel>
    );
  }

  // A waterfall: each step floats from where the last one ended.
  let run = 0;
  const steps = b.rows.map((r) => {
    const from = run;
    run += r.value;
    return { ...r, lo: Math.min(from, run), hi: Math.max(from, run) };
  });
  const lo = Math.min(0, ...steps.map((s) => s.lo), b.profit);
  const hi = Math.max(1, ...steps.map((s) => s.hi));
  const x = (v: number) => ((v - lo) / (hi - lo)) * 100;
  const u = p.unit;

  return (
    <Panel title="One kept order" aside={`Averaged over ${num(b.keptOrders)} kept orders`} className="lg:col-span-2">
      <div className="flex flex-col">
        {steps.map((s, i) => (
          <div key={s.key} className={STEP_ROW}>
            <div className="min-w-0 truncate text-[13px]">{s.label}</div>
            <div className={`relative ${BAR}`} title={`${s.label}: ${inr(s.value, i > 0)}`}>
              <div
                className="absolute inset-y-0 rounded-[2px]"
                style={{ left: `${x(s.lo)}%`, width: `${Math.max(1, x(s.hi) - x(s.lo))}%`, background: i === 0 ? IN : OUT }}
              />
            </div>
            <div className="text-right text-[13px] tabular-nums">{inr(s.value, i > 0)}</div>
          </div>
        ))}
        <div className={`mt-1.5 border-t pt-2.5 ${STEP_ROW}`} style={{ borderColor: "var(--border-strong)" }}>
          <div className="text-[14px] font-semibold">Profit</div>
          <div className={`relative ${BAR}`}>
            <div
              className="absolute inset-y-0 rounded-[2px]"
              style={{
                left: `${x(Math.min(0, b.profit))}%`,
                width: `${Math.max(1, Math.abs(x(b.profit) - x(0)))}%`,
                background: profitColor(b.profit),
              }}
            />
          </div>
          <div className="text-right text-[15px] font-semibold tabular-nums" style={{ color: profitColor(b.profit) }}>
            {inr(b.profit)}
          </div>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 border-t pt-4" style={{ borderColor: "var(--border)" }}>
        <Fact label="Kept order, over its cost" value={u.keptEarns} />
        <Fact label="Average return" value={u.returnCosts} />
        <Fact label="Average RTO" value={u.rtoCosts} />
        <Fact label="Ads per shipped order" value={u.adsPerShipped} />
      </div>
    </Panel>
  );
}

function Fact({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="min-w-0">
      <div className="text-[15px] font-semibold tabular-nums">{value == null ? "–" : inr(value, true)}</div>
      <div className="muted text-[11.5px] leading-snug">{label}</div>
    </div>
  );
}

/* ------------------------------------------------------- money right now */

function MoneyNow({ view }: { view: DashboardView }) {
  const m = view.money;
  const parts = [
    { key: "paid", label: "Paid to your bank", value: m.paid, color: OUT, note: m.lastPayoutAt ? `last on ${istDay(m.lastPayoutAt)}` : undefined },
    { key: "next", label: "Next payout", value: m.nextPayout, color: IN, note: "released, not yet sent" },
    { key: "held", label: "On hold", value: m.held, color: HELD, note: "until recent orders are delivered" },
  ];
  const total = parts.reduce((s, x) => s + Math.max(0, x.value), 0) || 1;

  return (
    <Panel title="Money with Amazon" aside="Today, all orders">
      <div className="flex h-2.5 gap-[2px] overflow-hidden" role="img" aria-label={parts.map((x) => `${x.label} ${inr(x.value)}`).join(", ")}>
        {parts.map((x) => (
          <div
            key={x.key}
            title={`${x.label}: ${inr(x.value)}`}
            style={{ width: `${(Math.max(0, x.value) / total) * 100}%`, background: x.color }}
          />
        ))}
      </div>

      <div className="mt-4 flex flex-col gap-2">
        {parts.map((x) => (
          <div key={x.key} className="flex items-baseline justify-between gap-3 text-[13px]">
            <div className="flex min-w-0 items-center gap-2">
              <Dot color={x.color} />
              <span className="whitespace-nowrap">{x.label}</span>
              {x.note ? <span className="muted hidden min-w-0 truncate text-[11.5px] sm:inline">· {x.note}</span> : null}
            </div>
            <span className="tabular-nums">{inr(x.value)}</span>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-col gap-2 border-t pt-3.5 text-[13px]" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-baseline justify-between gap-3">
          <span>
            Your cost in orders on hold <span className="muted text-[11.5px]">· {num(m.heldOrders)} orders</span>
          </span>
          <span className="font-semibold tabular-nums">{inr(m.heldCost)}</span>
        </div>
        {m.notShippedOrders > 0 ? (
          <div className="flex items-baseline justify-between gap-3">
            <span>
              Not shipped yet <span className="muted text-[11.5px]">· {num(m.notShippedOrders)} orders</span>
            </span>
            <span className="tabular-nums">{inr(m.notShippedCost)}</span>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

/* ------------------------------------------------------------------ returns */

function Returns({ p }: { p: ProfitView }) {
  const o = p.orders;
  const r = p.returns;
  const checked = r.back > 0 ? r.confirmed / r.back : 0;

  return (
    <Panel title="Returns">
      <div className="grid grid-cols-3 gap-3">
        <Rate label="Returned" value={pct(o.returnRate)} note={`${num(o.returned)} of ${num(o.kept + o.returned)} delivered`} />
        <Rate label="RTO" value={pct(o.rtoRate)} note={`${num(o.rto)} undelivered`} />
        <Rate label="Cancelled" value={pct(o.cancelRate)} note={`${num(o.cancelled)} of ${num(o.placed)} placed`} />
      </div>

      <div className="mt-5 border-t pt-4" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-baseline justify-between gap-3 text-[13px]">
          <span>Checked in on the scanner</span>
          <span className="tabular-nums">
            {num(r.confirmed)} <span className="muted">of {num(r.back)}</span>
          </span>
        </div>
        <div className="mt-2 h-2" style={{ background: "var(--panel-2)" }}>
          <div className="h-full" style={{ width: `${checked * 100}%`, background: IN }} />
        </div>
        <p className="muted mt-3 text-[12px] leading-snug">
          Profit counts every return as back in stock. If the {num(r.back - r.confirmed)} not checked in never came back:
        </p>
        <div className="mt-1 flex items-baseline justify-between gap-3 text-[13px]">
          <span>Profit, worst case</span>
          <span className="font-semibold tabular-nums" style={{ color: profitColor(r.worst) }}>
            {inr(r.worst)}
          </span>
        </div>
        {r.safeT !== 0 ? (
          <div className="mt-2 flex items-baseline justify-between gap-3 text-[13px]">
            <span>
              SAFE-T claims paid <span className="muted text-[11.5px]">· {num(r.safeTOrders)} orders</span>
            </span>
            <span className="tabular-nums">{inr(r.safeT)}</span>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function Rate({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[1.3rem] font-semibold leading-none tabular-nums">{value}</div>
      <div className="mt-1.5 text-[12px] font-medium">{label}</div>
      <div className="muted text-[11.5px] leading-snug">{note}</div>
    </div>
  );
}

/* ------------------------------------------------------------------- months */

function Months({ months }: { months: MonthRow[] }) {
  const max = Math.max(1, ...months.map((m) => Math.abs(m.profit)));
  const anyOpen = months.some((m) => m.open);
  return (
    <Panel title="By month" aside={anyOpen ? "Open: returns still coming in" : "By the month the order was placed"}>
      <div className="-mx-5 overflow-x-auto px-5">
        <table className="w-full min-w-[40rem] text-[13px] tabular-nums print:min-w-0">
          <thead>
            <tr className="muted text-[11px] uppercase tracking-wider">
              <Th left>Month</Th>
              <Th>Orders</Th>
              <Th>Returned</Th>
              <Th>Sales</Th>
              <Th>Amazon net</Th>
              <Th>Cost of goods</Th>
              <Th>Profit</Th>
              <th className="w-[18%] pb-2 print:hidden" aria-hidden />
            </tr>
          </thead>
          <tbody>
            {[...months].reverse().map((m) => (
              <tr key={m.month} className="border-t" style={{ borderColor: "var(--border)" }}>
                <Td left>
                  {rangeLabel(m.month as `${number}-${number}`)}
                  {m.open ? (
                    <span className="ml-2 px-1.5 py-px text-[10.5px] font-medium" style={{ background: "var(--warn-soft)", color: "#9a5b12" }}>
                      Open
                    </span>
                  ) : null}
                </Td>
                <Td>{num(m.placed)}</Td>
                <Td>{pct(m.returnRate)}</Td>
                <Td>{inr(m.sales)}</Td>
                <Td>{inr(m.net)}</Td>
                <Td>{inr(-m.cogs)}</Td>
                <Td strong color={profitColor(m.profit)}>
                  {inr(m.profit)}
                </Td>
                <td className="py-2 pl-4 print:hidden">
                  <SignedBar value={m.profit} max={max} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** A bar either side of a centre line: losses left, profit right. */
function SignedBar({ value, max }: { value: number; max: number }) {
  const w = (Math.abs(value) / max) * 50;
  return (
    <div className="relative h-2" title={inr(value)}>
      <div className="absolute inset-y-[-3px] left-1/2 w-px" style={{ background: "var(--border-strong)" }} />
      <div
        className="absolute inset-y-0"
        style={{
          left: value < 0 ? `${50 - w}%` : "50%",
          width: `${Math.max(0.5, w)}%`,
          background: profitColor(value),
        }}
      />
    </div>
  );
}

function Th({ children, left }: { children: React.ReactNode; left?: boolean }) {
  return (
    <th
      className={`whitespace-nowrap pb-2 font-medium print:whitespace-normal ${left ? "text-left" : "text-right"} [&:not(:first-child)]:pl-4`}
    >
      {children}
    </th>
  );
}

function Td({ children, left, strong, color }: { children: React.ReactNode; left?: boolean; strong?: boolean; color?: string }) {
  return (
    <td
      className={`py-2 ${left ? "text-left" : "text-right"} whitespace-nowrap [&:not(:first-child)]:pl-4 ${strong ? "font-semibold" : ""}`}
      style={color ? { color } : undefined}
    >
      {children}
    </td>
  );
}

/* ----------------------------------------------------------------- products */

/** The best earners and every product losing money; the rest behind "Show all" (always printed). */
const TOP_PRODUCTS = 10;

function Products({ rows, small, ads }: { rows: ProductRow[]; small: ProfitView["smallProducts"]; ads: number }) {
  const [all, setAll] = useState(false);
  if (rows.length === 0 && !small) return null;
  const max = Math.max(1, ...rows.filter((r) => !r.noCost).map((r) => Math.abs(r.profit)));
  const shown = (r: ProductRow, i: number) => all || i < TOP_PRODUCTS || r.noCost || r.profit < 0;
  const hidden = rows.filter((r, i) => !shown(r, i)).length;
  return (
    <Panel title="Products" aside={`Before ads (${inr(ads)}) · all sizes and colours`}>
      <div className="-mx-5 overflow-x-auto px-5">
        <table className="w-full min-w-[44rem] text-[13px] tabular-nums print:min-w-0">
          <thead>
            <tr className="muted text-[11px] uppercase tracking-wider">
              <Th left>Product</Th>
              <Th>Shipped</Th>
              <Th>Returned</Th>
              <Th>Amazon net</Th>
              <Th>Cost of goods</Th>
              <Th>Profit</Th>
              <th className="w-[14%] pb-2 print:hidden" aria-hidden />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={r.key}
                className={`border-t ${shown(r, i) ? "" : "hidden print:table-row"}`}
                style={{ borderColor: "var(--border)" }}
              >
                <td className="py-2 pr-2 text-left">
                  <div className="flex max-w-[26rem] items-center gap-2 print:max-w-[12rem]">
                    <span className="min-w-0 truncate" title={r.name}>
                      {r.name}
                    </span>
                    {r.unmapped ? (
                      <span className="shrink-0 px-1.5 py-px text-[10.5px] font-medium" style={{ background: "var(--warn-soft)", color: "#9a5b12" }}>
                        Not mapped
                      </span>
                    ) : null}
                  </div>
                </td>
                <Td>{num(r.shipped)}</Td>
                <Td>{pct(r.returnRate)}</Td>
                <Td>{inr(r.net)}</Td>
                <Td>{r.noCost ? <span className="muted">No cost</span> : inr(-r.cogs)}</Td>
                <Td strong color={r.noCost ? undefined : profitColor(r.profit)}>
                  {r.noCost ? "–" : inr(r.profit)}
                </Td>
                <td className="py-2 pl-4 print:hidden">{r.noCost ? null : <SignedBar value={r.profit} max={max} />}</td>
              </tr>
            ))}
            {small ? (
              <tr className="muted border-t" style={{ borderColor: "var(--border-strong)" }}>
                <td className="py-2 text-left">{num(small.count)} smaller products</td>
                <Td>{num(small.shipped)}</Td>
                <Td>–</Td>
                <Td>{inr(small.net)}</Td>
                <Td>{inr(-small.cogs)}</Td>
                <Td>{inr(small.profit)}</Td>
                <td className="print:hidden" />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {hidden > 0 || all ? (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          className="no-print mt-3 text-[12.5px] font-medium"
          style={{ color: "#0b7fb0" }}
        >
          {all ? "Show fewer" : `Show all ${num(rows.length)} products`}
        </button>
      ) : null}
    </Panel>
  );
}

/* ---------------------------------------------------------------------- tax */

function Tax({ p }: { p: ProfitView }) {
  const t = p.tax;
  return (
    <Panel title="GST and TCS" aside="Estimate, check with your CA">
      <div className="flex flex-col gap-2 text-[13px]">
        <Kv label="GST collected, less refunds" value={inr(-t.outputGst)} />
        <Kv label="GST credit on ads" value={inr(t.adsGst, true)} />
        <Kv label="GST credit in fees and postage, at 18%" value={inr(t.feeGst, true)} />
        <div className="border-t pt-2" style={{ borderColor: "var(--border)" }}>
          <Kv label={t.left >= 0 ? "GST credit left over" : "GST still to pay"} value={inr(t.left, true)} strong />
        </div>
        <Kv label="TCS and TDS withheld, claimable" value={inr(t.tcs)} />
      </div>
    </Panel>
  );
}

function Kv({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={strong ? "font-semibold" : undefined}>{label}</span>
      <span className={`tabular-nums ${strong ? "font-semibold" : ""}`}>{value}</span>
    </div>
  );
}

/* -------------------------------------------------------------------- notes */

function Notes({ p }: { p: ProfitView }) {
  const mc = p.missingCost;
  const notes = [
    mc.orders > 0
      ? `${num(mc.orders)} shipped orders have no cost${mc.unmapped ? ` (${num(mc.unmapped)} with a SKU not mapped to a product)` : ""}, so ${inr(mc.net)} of Amazon net has no cost against it.`
      : null,
    "Cost of goods is your cost price, which already includes packaging and overheads.",
    "Returned goods count as back in stock at cost.",
    "GST is treated as a wash: the credits on fees and ads offset what customers paid.",
    "Stock that hasn't sold isn't valued here.",
  ].filter((x): x is string => x !== null);

  return (
    <Panel title="How it's counted">
      <ul className="muted flex list-disc flex-col gap-1.5 pl-4 text-[12.5px] leading-snug">
        {notes.map((n, i) => (
          <li key={i} style={i === 0 && mc.orders > 0 ? { color: "var(--text)" } : undefined}>
            {n}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
