"use client";

import { useState } from "react";

import { Empty, STATUS_TONE } from "@/components/ui";
import { ImageLightbox } from "@/components/image-lightbox";
import type { OrderStatus } from "@/db/schema";
import { useOrdersNav } from "@/lib/stores/orders-cache";
import { cn, timeLeft } from "@/lib/utils";

import { CollectionDetailModal } from "./collection-detail-modal";
import type { PickRow } from "./queries";
import type { CollectionCategory } from "./view-actions";

/**
 * Per-category copy. Only `toShip` is the live open queue — dispatch
 * deadlines and "to pick" framing don't mean anything once an order has
 * shipped, delivered, or been cancelled, so every other category gets
 * neutral wording instead of Ship-specific language.
 */
const CATEGORY_COPY: Record<
  CollectionCategory,
  { empty: string; emptyHint: string; unitWord: string; showDeadline: boolean }
> = {
  toShip: {
    empty: "Nothing to ship",
    emptyHint: "Open orders roll up here by product as channels sync.",
    unitWord: "to pick",
    showDeadline: true,
  },
  shipped: {
    empty: "Nothing shipped yet",
    emptyHint: "Shipped orders roll up here by product.",
    unitWord: "shipped",
    showDeadline: false,
  },
  delivered: {
    empty: "Nothing delivered yet",
    emptyHint: "Delivered orders roll up here by product.",
    unitWord: "delivered",
    showDeadline: false,
  },
  cancellations: {
    empty: "Nothing cancelled or returned",
    emptyHint: "Cancelled and RTO orders roll up here by product.",
    unitWord: "units",
    showDeadline: false,
  },
  all: {
    empty: "No orders yet",
    emptyHint: "Every order rolls up here by product as channels sync.",
    unitWord: "units",
    showDeadline: false,
  },
};

/**
 * The collection view: every order line for the active category, rolled up
 * by product. Sorted by how many units are involved, so the busiest products
 * lead. A card opens the product's orders.
 */
export function PickList({ rows, category }: { rows: PickRow[]; category: CollectionCategory }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const copy = CATEGORY_COPY[category];

  if (rows.length === 0) {
    return <Empty title={copy.empty} hint={copy.emptyHint} />;
  }

  const totalUnits = rows.reduce((a, r) => a + r.unitsNeeded, 0);
  const totalOrders = new Set(rows.flatMap((r) => r.orderIds)).size;
  const lateSkus = copy.showDeadline ? rows.filter((r) => r.lateCount > 0).length : 0;
  const openRow = rows.find((r) => r.key === openKey) ?? null;

  return (
    <div className="space-y-4">
      <div className={cn("grid grid-cols-2 gap-3", copy.showDeadline ? "sm:grid-cols-4" : "sm:grid-cols-3")}>
        <MiniStat label="Products" value={rows.length} />
        <MiniStat label="Units total" value={totalUnits} />
        <MiniStat label="Orders covered" value={totalOrders} />
        {copy.showDeadline ? (
          <MiniStat label="Products with a late order" value={lateSkus} tone={lateSkus > 0 ? "danger" : undefined} />
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((r) => (
          <PickCard
            key={r.key}
            row={r}
            category={category}
            onOpen={() => setOpenKey(r.key)}
            onOpenImage={(src, alt) => setLightbox({ src, alt })}
          />
        ))}
      </div>

      {openRow ? <CollectionDetailModal row={openRow} onClose={() => setOpenKey(null)} /> : null}

      {lightbox ? (
        <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />
      ) : null}
    </div>
  );
}

/**
 * "All orders"' own Collection root: not a SKU rollup (there is no single
 * meaningful grouping across every status at once) but a tap-through
 * breakdown by real `orders.status` counts — tapping one drills into that
 * status's own SKU rollup, reusing the same `view=collection` + `status`
 * params every other category already navigates with.
 */
export function AllOrdersTiles({
  tiles,
}: {
  tiles: { status: OrderStatus; label: string; count: number }[];
}) {
  const go = useOrdersNav((s) => s.go);
  const visible = tiles.filter((t) => t.count > 0);

  if (visible.length === 0) {
    return <Empty title="No orders yet" hint="Every order rolls up here by product as channels sync." />;
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {visible.map((t) => {
        const tone = STATUS_TONE[t.status];
        return (
          <button
            key={t.status}
            type="button"
            onClick={() => go({ view: "collection", status: t.status })}
            className="panel flex flex-col gap-2 p-3.5 text-left transition-colors hover:bg-[var(--accent-soft)]"
          >
            <span className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: tone.dot }} aria-hidden />
              <span className="text-[13px] font-medium">{t.label}</span>
            </span>
            <span className="text-2xl font-bold leading-none tabular-nums">{t.count}</span>
          </button>
        );
      })}
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

function PickCard({
  row,
  category,
  onOpen,
  onOpenImage,
}: {
  row: PickRow;
  category: CollectionCategory;
  onOpen: () => void;
  onOpenImage: (src: string, alt: string) => void;
}) {
  const copy = CATEGORY_COPY[category];
  const deadline = copy.showDeadline
    ? timeLeft(row.earliestDispatchBy ? new Date(row.earliestDispatchBy) : null)
    : null;
  const shownOrders = row.orderIds.slice(0, 4);
  const more = row.orderIds.length - shownOrders.length;
  const alt = row.title ?? row.sku;
  // Cancelled & RTO's rollup comes from cancellation records, which never
  // carry `productId` — every row reads `mapped: false` there regardless of
  // whether the SKU is actually mapped, so the badge would be misleading.
  const showUnmappedBadge = category !== "cancellations" && !row.mapped;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="panel flex flex-col gap-3 p-3.5 text-left transition-colors hover:bg-[var(--accent-soft)]"
    >
      <div className="flex gap-3.5">
        <span
          onClick={(e) => {
            if (!row.imageUrl) return;
            e.stopPropagation();
            onOpenImage(row.imageUrl, alt);
          }}
        >
          <Thumb src={row.imageUrl} alt={alt} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          {/* NAME is the headline. */}
          <div className="line-clamp-2 text-[13.5px] font-semibold leading-snug">
            {row.title ?? <span className="muted italic">Unnamed product</span>}
          </div>
          <div className="muted mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="font-mono">{row.sku}</span>
            {showUnmappedBadge ? (
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
              {copy.unitWord} · {row.orderCount} order{row.orderCount === 1 ? "" : "s"}
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
