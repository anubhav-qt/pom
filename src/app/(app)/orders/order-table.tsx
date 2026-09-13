"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { ChannelTag, Empty, StatusBadge } from "@/components/ui";
import { FEATURES } from "@/config/features";
import { ImageLightbox } from "@/components/image-lightbox";
import type { Channel, FulfilmentState, OrderStatus } from "@/db/schema";
import { withBasePath } from "@/lib/base-path";
import { cn, dayLabel, money, timeLeft } from "@/lib/utils";

import { createManifest, dismissShipped24h, markPacked, revertToNew } from "./actions";
import { OrderDetailModal } from "./order-detail-modal";
import { ScanModal } from "./scan/scan-modal";

export interface OrderRow {
  id: number;
  channel: Channel;
  externalOrderId: string;
  status: OrderStatus;
  orderedAt: string;
  dispatchBy: string | null;
  buyerName: string | null;
  shipCity: string | null;
  shipState: string | null;
  totalAmount: string | null;
  isCod: boolean;
  /** Our own bench state, not the marketplace's. */
  fulfilmentState: FulfilmentState;
  isPending: boolean;
  items: {
    sku: string;
    title: string | null;
    quantity: number;
    mapped: boolean;
    imageUrl?: string | null;
  }[];
}

export function OrderTable({
  rows,
  activeTab,
  onChanged,
}: {
  rows: OrderRow[];
  /** Which queue tab these rows came from, if any — drives the Packed-only bulk-ship fallback. */
  activeTab?: "unshipped" | "packed" | "shipped24h";
  /** Called after a bulk action commits, so the caller can refetch its cache. */
  onChanged?: () => void;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [cropLabels, setCropLabels] = useState(true);
  const [openOrderId, setOpenOrderId] = useState<number | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  // Packed-tab only: scanning an AWB from the row icon maps it straight to
  // that order, instead of going through the outbound-bench flow.
  const [mapTarget, setMapTarget] = useState<{ orderId: number; externalOrderId: string } | null>(
    null,
  );

  // A packed order normally leaves this tab when its label gets scanned at
  // the outbound bench (that scan is what actually calls `createManifest`).
  // Forget to scan one and it sits here forever — nothing else ever flips
  // its state. This is the manual escape hatch, independent of the
  // print-labels feature flag, since it isn't about labels at all.
  const canBulkShip = activeTab === "packed";
  const canDismiss = activeTab === "shipped24h";
  const showSelection = FEATURES.labelPrinting || canBulkShip || canDismiss;

  const allSelected = rows.length > 0 && selected.size === rows.length;
  const selectedIds = useMemo(() => [...selected], [selected]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * Labels are fetched as a blob and opened in a new tab rather than navigated
   * to, so the queue keeps its selection while the print dialog is open.
   */
  async function printLabels() {
    if (selectedIds.length === 0) return;
    setMessage(null);

    const res = await fetch(withBasePath("/api/labels"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderIds: selectedIds, crop: cropLabels }),
    });

    if (!res.ok) {
      setMessage(await res.text());
      return;
    }

    const skipped = Number(res.headers.get("x-labels-missing") ?? 0);
    if (skipped > 0) {
      setMessage(
        `${skipped} order${skipped === 1 ? "" : "s"} had no label available — check Settings › Sync log.`,
      );
    }

    const url = URL.createObjectURL(await res.blob());
    window.open(url, "_blank");
    // Give the new tab time to load before releasing the object URL.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function run(fn: () => Promise<{ ok: boolean; error?: string; count?: number }>) {
    startTransition(async () => {
      const res = await fn();
      setMessage(res.ok ? null : (res.error ?? "Something went wrong."));
      if (res.ok) setSelected(new Set());
      router.refresh();
      onChanged?.();
    });
  }

  return (
    <div className="space-y-3">
      {/* Status filtering and search live in the header (band 2) now. */}

      {/* ------------------------------------------------------ bulk actions */}
      {showSelection && rows.length > 0 ? (
        <div className="no-print panel flex flex-wrap items-center gap-2 p-2">
          <span className="muted px-1 text-sm tabular-nums">{selected.size} selected</span>

          {FEATURES.labelPrinting ? (
            <>
              <button className="btn btn-primary" disabled={selected.size === 0} onClick={printLabels}>
                Print labels
              </button>

              <label className="muted flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={cropLabels}
                  onChange={(e) => setCropLabels(e.target.checked)}
                />
                Crop off invoice
              </label>

              <button
                className="btn"
                disabled={selected.size === 0 || pending}
                onClick={() => run(() => markPacked(selectedIds))}
              >
                Mark packed
              </button>

              <button
                className="btn"
                disabled={selected.size === 0 || pending}
                onClick={() => run(() => createManifest(selectedIds))}
              >
                Create manifest
              </button>

              <button
                className="btn ml-auto"
                disabled={selected.size === 0 || pending}
                onClick={() => run(() => revertToNew(selectedIds))}
              >
                Undo
              </button>
            </>
          ) : null}

          {/* Forgot to scan a packed order at the bench? This is the fallback —
              same underlying transition (packed → manifested) a scan would have
              made, without needing a label to scan. */}
          {canBulkShip && !FEATURES.labelPrinting ? (
            <button
              className="btn btn-primary ml-auto"
              disabled={selected.size === 0 || pending}
              onClick={() => run(() => createManifest(selectedIds))}
              title="For orders you packed but never scanned — moves them straight to Shipped."
            >
              Mark shipped
            </button>
          ) : null}

          {/* Clears reviewed parcels off this 24h list by hand — a local
              acknowledgement, not a status change. The order is untouched
              everywhere else. */}
          {canDismiss ? (
            <button
              className="btn btn-primary ml-auto"
              disabled={selected.size === 0 || pending}
              onClick={() => run(() => dismissShipped24h(selectedIds))}
              title="Remove from this list — the order itself is not changed."
            >
              Dismiss
            </button>
          ) : null}
        </div>
      ) : null}

      {message ? (
        <p
          className="no-print rounded-md px-3 py-2 text-sm"
          style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
        >
          {message}
        </p>
      ) : null}

      {/* -------------------------------------------------------------- table */}
      {rows.length === 0 ? (
        <div className="panel">
          <Empty
            title="Nothing waiting"
            hint="New orders appear here automatically as channels sync."
          />
        </div>
      ) : (
        <>
          {/* Cards below sm, the dense grid from sm up — same data, same
              actions, just no room on a phone for seven columns. */}
          <div className="flex flex-col gap-2.5 sm:hidden">
            {rows.map((row) => (
              <OrderCard
                key={row.id}
                row={row}
                selectable={showSelection}
                selected={selected.has(row.id)}
                onToggleSelect={() => toggle(row.id)}
                onOpen={() => setOpenOrderId(row.id)}
                onOpenImage={(src, alt) => setLightbox({ src, alt })}
                onScanAwb={
                  canBulkShip
                    ? () => setMapTarget({ orderId: row.id, externalOrderId: row.externalOrderId })
                    : undefined
                }
              />
            ))}
          </div>

          <div className="panel hidden overflow-x-auto sm:block">
          <table className="grid-table">
            <thead>
              <tr>
                {/* Selection only exists to feed the bulk actions above. */}
                {showSelection ? (
                  <th className="w-8">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={(e) =>
                        setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                      }
                      aria-label="Select all"
                    />
                  </th>
                ) : null}
                <th className="w-14">Item</th>
                <th>Order</th>
                <th>Items</th>
                <th>Ship to</th>
                <th className="text-right">Value</th>
                <th>Deadline</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const { deadline, hasUnmapped } = orderMeta(row);

                return (
                  <tr
                    key={row.id}
                    onClick={() => setOpenOrderId(row.id)}
                    className="cursor-pointer"
                  >
                    {showSelection ? (
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected.has(row.id)}
                          onChange={() => toggle(row.id)}
                          aria-label={`Select ${row.externalOrderId}`}
                        />
                      </td>
                    ) : null}

                    <td>
                      <div className="relative w-11">
                        <OrderThumb
                          src={row.items.find((i) => i.imageUrl)?.imageUrl ?? null}
                          alt={row.items[0]?.title ?? row.externalOrderId}
                        />
                        {row.items.length > 1 ? (
                          <span
                            className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white"
                            style={{ background: "var(--accent)" }}
                            title={`${row.items.length} different items in this order`}
                          >
                            +{row.items.length - 1}
                          </span>
                        ) : null}
                      </div>
                    </td>

                    <td>
                      <div className="flex items-center gap-2">
                        <ChannelTag channel={row.channel} />
                        {row.isPending ? (
                          <span
                            className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold tracking-wide"
                            style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
                            title="Amazon pending order"
                          >
                            pending
                          </span>
                        ) : null}
                        {row.isCod ? (
                          <span
                            className="rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide"
                            style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
                          >
                            COD
                          </span>
                        ) : null}
                      </div>
                      <div className="font-mono text-xs">{row.externalOrderId}</div>
                      <div className="muted text-xs">{dayLabel(new Date(row.orderedAt))}</div>
                    </td>

                    <td className="max-w-sm">
                      <div className="space-y-1.5">
                        {row.items.map((item, i) => (
                          <div key={i}>
                            <div className="line-clamp-2 text-[13px] font-medium leading-snug">
                              {item.title ?? (
                                <span className="muted italic">Unnamed item</span>
                              )}
                            </div>
                            <div className="muted mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                              <span className="tabular-nums">{item.quantity}×</span>
                              <span className="font-mono">{item.sku}</span>
                              {!item.mapped ? (
                                <span
                                  className="rounded-full px-1.5 py-0.5 text-[9px] font-semibold tracking-wide"
                                  style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
                                  title="This channel SKU is not mapped to a product — it will not be stock-controlled"
                                >
                                  unmapped
                                </span>
                              ) : null}
                            </div>
                          </div>
                        ))}
                      </div>
                      {hasUnmapped && FEATURES.inventoryManagement ? (
                        <a
                          href="/inventory"
                          onClick={(e) => e.stopPropagation()}
                          className="text-xs underline"
                          style={{ color: "var(--danger)" }}
                        >
                          Map SKUs
                        </a>
                      ) : null}
                    </td>

                    <td className="text-xs">
                      {row.buyerName ? <div>{row.buyerName}</div> : null}
                      <div className="muted">
                        {[row.shipCity, row.shipState].filter(Boolean).join(", ") || "-"}
                      </div>
                    </td>

                    <td className="text-right tabular-nums">{money(row.totalAmount)}</td>

                    <td>
                      {deadline ? (
                        <span
                          className="text-xs font-medium"
                          style={deadline.late ? { color: "var(--danger)" } : { color: "var(--muted)" }}
                        >
                          {deadline.text}
                        </span>
                      ) : (
                        <span className="muted text-xs">-</span>
                      )}
                    </td>

                    <td>
                      <div className="flex items-center gap-1.5">
                        <StatusBadge status={row.status} />
                        {canBulkShip ? (
                          <button
                            type="button"
                            className="btn px-2 py-1"
                            onClick={(e) => {
                              e.stopPropagation();
                              setMapTarget({ orderId: row.id, externalOrderId: row.externalOrderId });
                            }}
                            aria-label={`Scan AWB for ${row.externalOrderId}`}
                            title="Scan AWB"
                          >
                            <BarcodeIcon />
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </>
      )}

      {openOrderId !== null ? (
        <OrderDetailModal orderId={openOrderId} onClose={() => setOpenOrderId(null)} />
      ) : null}

      {lightbox ? (
        <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />
      ) : null}

      {mapTarget ? (
        <ScanModal
          station="outbound"
          mapTo={mapTarget}
          onClose={() => setMapTarget(null)}
          onDone={() => {
            router.refresh();
            onChanged?.();
          }}
        />
      ) : null}
    </div>
  );
}

/** Same barcode glyph as the scanner's manual-entry field, reused on the
 * per-row "scan AWB" affordance so both read as the same action. */
export function BarcodeIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M3 5v14" />
      <path d="M8 5v14" />
      <path d="M12 5v14" />
      <path d="M17 5v14" />
      <path d="M21 5v14" />
    </svg>
  );
}

/** Shared between the table row and the mobile card — same rule either way. */
function orderMeta(row: OrderRow) {
  // A dispatch deadline only means something for an order still waiting to go
  // out — once it has shipped, been cancelled, or come back as a return,
  // "3 days late" is just noise left over from before the order was actioned.
  //
  // Both halves are needed: the channel decides whether the order is still
  // live, and our own state decides whether it is still on the bench. Amazon
  // calls an Easy Ship order `Unshipped` until the courier scans it, so
  // without the second check a parcel we packed this morning would keep
  // counting down.
  const stillAwaitingDispatch =
    ["new", "ready_to_pack", "packed"].includes(row.status) && row.fulfilmentState === "to_pack";
  const deadline = stillAwaitingDispatch
    ? timeLeft(row.dispatchBy ? new Date(row.dispatchBy) : null)
    : null;
  const hasUnmapped = row.items.some((i) => !i.mapped);
  return { deadline, hasUnmapped };
}

/**
 * Mobile stand-in for a table row. Tapping the thumbnail opens just the image
 * (a quick look at the product); tapping anywhere else on the card opens the
 * same order detail sheet a row click would.
 */
export function OrderCard({
  row,
  onOpen,
  onOpenImage,
  selectable,
  selected,
  onToggleSelect,
  onScanAwb,
}: {
  row: OrderRow;
  onOpen: () => void;
  onOpenImage: (src: string, alt: string) => void;
  /** Packed-tab (or label-printing) bulk selection — a checkbox floats over the card. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  /** Packed tab only: floats a scan-AWB icon over the card, mapping directly to this order. */
  onScanAwb?: () => void;
}) {
  const { deadline, hasUnmapped } = orderMeta(row);
  const thumbSrc = row.items.find((i) => i.imageUrl)?.imageUrl ?? null;
  const thumbAlt = row.items[0]?.title ?? row.externalOrderId;

  return (
    <div className="relative">
      {selectable ? (
        <input
          type="checkbox"
          checked={selected ?? false}
          onChange={onToggleSelect}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${row.externalOrderId}`}
          className="absolute left-3 top-3 z-10 h-4 w-4"
        />
      ) : null}
      {onScanAwb ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onScanAwb();
          }}
          aria-label={`Scan AWB for ${row.externalOrderId}`}
          title="Scan AWB"
          className="btn absolute right-3 top-3 z-10 px-2 py-1"
        >
          <BarcodeIcon />
        </button>
      ) : null}
      <button
        type="button"
        onClick={onOpen}
        className="panel flex w-full gap-3 p-3 text-left active:scale-[0.99]"
        style={{ transition: "transform 0.1s var(--ease-premium)", paddingLeft: selectable ? "2.25rem" : undefined }}
      >
      <span
        className="relative w-14 shrink-0"
        onClick={(e) => {
          if (!thumbSrc) return;
          e.stopPropagation();
          onOpenImage(thumbSrc, thumbAlt);
        }}
      >
        <OrderThumb src={thumbSrc} alt={thumbAlt} size="h-14 w-14" />
        {row.items.length > 1 ? (
          <span
            className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white"
            style={{ background: "var(--accent)" }}
          >
            +{row.items.length - 1}
          </span>
        ) : null}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <ChannelTag channel={row.channel} />
          {row.isCod ? (
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide"
              style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
            >
              COD
            </span>
          ) : null}
          <StatusBadge status={row.status} />
        </div>

        <div className="line-clamp-1 text-[13px] font-medium leading-snug">
          {row.items[0]?.title ?? <span className="muted italic">Unnamed item</span>}
          {row.items.length > 1 ? ` +${row.items.length - 1} more` : ""}
        </div>

        <div className="font-mono text-xs" style={{ color: "var(--muted)" }}>
          {row.externalOrderId}
        </div>

        <div className="muted flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span>{[row.shipCity, row.shipState].filter(Boolean).join(", ") || "—"}</span>
          <span>·</span>
          <span className="tabular-nums">{money(row.totalAmount)}</span>
          {hasUnmapped ? (
            <span className="font-semibold" style={{ color: "var(--danger)" }}>
              Unmapped SKU
            </span>
          ) : null}
        </div>

        {deadline ? (
          <span
            className="text-xs font-medium"
            style={deadline.late ? { color: "var(--danger)" } : { color: "var(--muted)" }}
          >
            {deadline.text}
          </span>
        ) : null}
      </div>
      </button>
    </div>
  );
}

export function OrderThumb({
  src,
  alt,
  size = "h-11 w-11",
}: {
  src: string | null;
  alt: string;
  size?: string;
}) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={src}
        alt={alt}
        className={cn(size, "rounded-lg border object-cover")}
        style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}
      />
    );
  }
  return (
    <div
      className={cn(size, "flex items-center justify-center rounded-lg border")}
      style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="var(--muted-2)" strokeWidth="1.5">
        <path
          d="M4 8l4-4h8l4 4M4 8v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8M4 8h16M9 12h6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
