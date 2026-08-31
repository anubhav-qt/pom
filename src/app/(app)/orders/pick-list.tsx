"use client";

import { useState } from "react";

import { Empty } from "@/components/ui";
import { timeLeft } from "@/lib/utils";

import { CollectionDetailModal } from "./collection-detail-modal";
import type { PickRow } from "./queries";

/**
 * The collection view: every open order line rolled up by product. Sorted by
 * how many units need pulling, so the shelf run works top-to-bottom. A card
 * opens the product's orders.
 */
export function PickList({ rows }: { rows: PickRow[] }) {
  const [openKey, setOpenKey] = useState<string | null>(null);

  if (rows.length === 0) {
    return <Empty title="Nothing to ship" hint="Open orders roll up here by product as channels sync." />;
  }

  const totalUnits = rows.reduce((a, r) => a + r.unitsNeeded, 0);
  const totalOrders = new Set(rows.flatMap((r) => r.orderIds)).size;
  const lateSkus = rows.filter((r) => r.lateCount > 0).length;
  const openRow = rows.find((r) => r.key === openKey) ?? null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MiniStat label="Products to pick" value={rows.length} />
        <MiniStat label="Units total" value={totalUnits} />
        <MiniStat label="Orders covered" value={totalOrders} />
        <MiniStat label="Products with a late order" value={lateSkus} tone={lateSkus > 0 ? "danger" : undefined} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((r) => (
          <PickCard key={r.key} row={r} onOpen={() => setOpenKey(r.key)} />
        ))}
      </div>

      {openRow ? <CollectionDetailModal row={openRow} onClose={() => setOpenKey(null)} /> : null}
    </div>
  );
}

function MiniStat({ label, value, tone }: { label: string; value: number; tone?: "danger" }) {
  return (
    <div className="panel px-4 py-3">
      <div className="muted text-[11px] font-medium uppercase tracking-wider">{label}</div>
      <div
        className="mt-1 text-xl font-semibold tabular-nums"
        style={{ color: tone === "danger" ? "var(--danger)" : "var(--text)" }}
      >
        {value}
      </div>
    </div>
  );
}

function PickCard({ row, onOpen }: { row: PickRow; onOpen: () => void }) {
  const deadline = timeLeft(row.earliestDispatchBy ? new Date(row.earliestDispatchBy) : null);
  const shownOrders = row.orderIds.slice(0, 4);
  const more = row.orderIds.length - shownOrders.length;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="panel flex flex-col gap-3 p-3.5 text-left transition-colors hover:bg-[var(--accent-soft)]"
    >
      <div className="flex gap-3.5">
        <Thumb src={row.imageUrl} alt={row.title ?? row.sku} />
        <div className="flex min-w-0 flex-1 flex-col">
          {/* NAME is the headline. */}
          <div className="line-clamp-2 text-[13.5px] font-semibold leading-snug">
            {row.title ?? <span className="muted italic">Unnamed product</span>}
          </div>
          <div className="muted mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="font-mono">{row.sku}</span>
            {!row.mapped ? (
              <span
                className="rounded-full px-1.5 py-0.5 text-[9px] font-bold tracking-wide"
                style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
              >
                unmapped SKU
              </span>
            ) : null}
          </div>

          {/* The one number that matters on a shelf run. */}
          <div className="mt-auto flex items-baseline gap-1.5 pt-2">
            <span className="text-2xl font-bold leading-none tabular-nums" style={{ color: "var(--accent)" }}>
              {row.unitsNeeded}
            </span>
            <span className="muted text-[11px]">
              to pick · {row.orderCount} order{row.orderCount === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      </div>

      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-2 text-[11px]"
        style={{ borderColor: "var(--border)" }}
      >
        <span className="muted">
          Bin <span style={{ color: "var(--text)" }}>{row.binLocation ?? "—"}</span>
        </span>
        {deadline ? (
          <span className="font-medium" style={{ color: deadline.late ? "var(--danger)" : "var(--muted)" }}>
            {deadline.late ? `oldest ${deadline.text}` : `${deadline.text} on the soonest`}
          </span>
        ) : null}
        {row.lateCount > 0 ? (
          <span className="font-semibold" style={{ color: "var(--danger)" }}>
            {row.lateCount} past deadline
          </span>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1">
        {shownOrders.map((id) => (
          <span
            key={id}
            className="rounded-md px-1.5 py-0.5 font-mono text-[10px]"
            style={{ background: "var(--panel-2)", color: "var(--muted)" }}
          >
            {id}
          </span>
        ))}
        {more > 0 ? <span className="muted text-[10px]">+{more} more</span> : null}
      </div>
    </button>
  );
}

function Thumb({ src, alt }: { src: string | null; alt: string }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={src}
        alt={alt}
        className="h-[72px] w-[72px] shrink-0 rounded-lg border object-cover"
        style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}
      />
    );
  }
  return (
    <div
      className="flex h-[72px] w-[72px] shrink-0 items-center justify-center rounded-lg border"
      style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="var(--muted-2)" strokeWidth="1.5">
        <path d="M4 8l4-4h8l4 4M4 8v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8M4 8h16M9 12h6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
