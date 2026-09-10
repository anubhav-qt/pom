"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { ChannelTag, Empty, StatusBadge } from "@/components/ui";
import { FEATURES } from "@/config/features";
import type { Channel, FulfilmentState, OrderStatus } from "@/db/schema";
import { withBasePath } from "@/lib/base-path";
import { cn, dayLabel, money, timeLeft } from "@/lib/utils";

import { createManifest, markPacked, revertToNew } from "./actions";
import { OrderDetailModal } from "./order-detail-modal";

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

export function OrderTable({ rows }: { rows: OrderRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [cropLabels, setCropLabels] = useState(true);
  const [openOrderId, setOpenOrderId] = useState<number | null>(null);

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
    });
  }

  return (
    <div className="space-y-3">
      {/* Status filtering and search live in the header (band 2) now. */}

      {/* ------------------------------------------------------ bulk actions */}
      {FEATURES.labelPrinting ? (
        <div className="no-print panel flex flex-wrap items-center gap-2 p-2">
          <span className="muted px-1 text-sm tabular-nums">{selected.size} selected</span>

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
      <div className="panel overflow-x-auto">
        {rows.length === 0 ? (
          <Empty
            title="Nothing waiting"
            hint="New orders appear here automatically as channels sync."
          />
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                {/* Selection only exists to feed the bulk actions above. */}
                {FEATURES.labelPrinting ? (
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
                // A dispatch deadline only means something for an order still
                // waiting to go out — once it has shipped, been cancelled, or
                // come back as a return, "3 days late" is just noise left over
                // from before the order was actioned.
                //
                // Both halves are needed: the channel decides whether the order
                // is still live, and our own state decides whether it is still
                // on the bench. Amazon calls an Easy Ship order `Unshipped`
                // until the courier scans it, so without the second check a
                // parcel we packed this morning would keep counting down.
                const stillAwaitingDispatch =
                  ["new", "ready_to_pack", "packed"].includes(row.status) &&
                  row.fulfilmentState === "to_pack";
                const deadline = stillAwaitingDispatch
                  ? timeLeft(row.dispatchBy ? new Date(row.dispatchBy) : null)
                  : null;
                const hasUnmapped = row.items.some((i) => !i.mapped);

                return (
                  <tr
                    key={row.id}
                    onClick={() => setOpenOrderId(row.id)}
                    className="cursor-pointer"
                  >
                    {FEATURES.labelPrinting ? (
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
                      <StatusBadge status={row.status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {openOrderId !== null ? (
        <OrderDetailModal orderId={openOrderId} onClose={() => setOpenOrderId(null)} />
      ) : null}
    </div>
  );
}

function OrderThumb({ src, alt }: { src: string | null; alt: string }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={src}
        alt={alt}
        className="h-11 w-11 rounded-lg border object-cover"
        style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}
      />
    );
  }
  return (
    <div
      className="flex h-11 w-11 items-center justify-center rounded-lg border"
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
