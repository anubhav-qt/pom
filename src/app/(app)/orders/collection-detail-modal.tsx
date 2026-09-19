"use client";

import { CenteredSpinner } from "@/components/ui";
import { ItemTitle } from "@/components/item-title";
import { useEffect, useState } from "react";

import { ImageLightbox } from "@/components/image-lightbox";
import { Modal } from "@/components/modal";
import { dayLabel, money, timeLeft } from "@/lib/utils";

import { getCollectionOrders, type CollectionOrderRow } from "./actions";
import { OrderDetailModal } from "./order-detail-modal";
import type { PickRow } from "./queries";

/**
 * Opened from a card in the collection view: the product, and every open order
 * that needs a unit of it. Each order row drills into the full order modal.
 */
export function CollectionDetailModal({ row, onClose }: { row: PickRow; onClose: () => void }) {
  const [orders, setOrders] = useState<CollectionOrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openOrderId, setOpenOrderId] = useState<number | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getCollectionOrders(row.externalSku)
      .then((rows) => !cancelled && setOrders(rows))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [row.externalSku]);

  return (
    <>
      <Modal title="Collection" onClose={onClose} width="44rem">
        <div className="space-y-5">
          {/* product header */}
          <div className="flex gap-4">
            <button
              type="button"
              onClick={() => {
                if (row.imageUrl) setLightbox({ src: row.imageUrl, alt: row.title ?? row.sku });
              }}
              className="shrink-0"
              style={{ cursor: row.imageUrl ? "zoom-in" : "default" }}
              disabled={!row.imageUrl}
            >
              <Thumb src={row.imageUrl} alt={row.title ?? row.sku} />
            </button>
            <div className="min-w-0 flex-1">
              <ItemTitle title={row.title} empty="Unnamed product" nameClassName="text-[15px] font-semibold leading-snug" />
              <div className="muted mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className="font-mono">{row.sku}</span>
                {row.asin ? <span className="font-mono">ASIN {row.asin}</span> : null}
                {!row.mapped ? (
                  <span
                    className="rounded-full px-1.5 py-0.5 text-[9.5px] font-bold tracking-wide"
                    style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
                  >
                    UNMAPPED SKU
                  </span>
                ) : null}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                <Metric label="To pick" value={`${row.unitsNeeded} unit${row.unitsNeeded === 1 ? "" : "s"}`} strong />
                <Metric label="Orders" value={String(row.orderCount)} />
                <Metric label="Bin" value={row.binLocation ?? "—"} />
                {row.lateCount > 0 ? (
                  <Metric label="Past deadline" value={String(row.lateCount)} danger />
                ) : null}
              </div>
            </div>
          </div>

          {/* orders */}
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
              Orders needing this
            </h3>
            {error ? (
              <p className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
                {error}
              </p>
            ) : !orders ? (
              <CenteredSpinner />
            ) : (
              <div className="panel overflow-x-auto">
                <table className="grid-table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>Ship to</th>
                      <th className="text-right">Qty</th>
                      <th>Deadline</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((o) => {
                      const dl = timeLeft(o.dispatchBy ? new Date(o.dispatchBy) : null);
                      return (
                        <tr key={o.orderId} className="cursor-pointer" onClick={() => setOpenOrderId(o.orderId)}>
                          <td>
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-xs">{o.externalOrderId}</span>
                              {o.isCod ? (
                                <span
                                  className="rounded-full px-1.5 py-0.5 text-[9px] font-bold tracking-wide"
                                  style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
                                >
                                  COD
                                </span>
                              ) : null}
                            </div>
                            <div className="muted text-[11px]">Ordered {dayLabel(new Date(o.orderedAt))}</div>
                          </td>
                          <td className="text-xs">
                            {o.buyerName ? <div>{o.buyerName}</div> : null}
                            <div className="muted">
                              {[o.shipCity, o.shipState].filter(Boolean).join(", ") || "—"}
                            </div>
                          </td>
                          <td className="text-right text-[13px] font-semibold tabular-nums">{o.quantity}</td>
                          <td>
                            {dl ? (
                              <span
                                className="text-xs font-medium"
                                style={{ color: dl.late ? "var(--danger)" : "var(--muted)" }}
                              >
                                {dl.text}
                              </span>
                            ) : (
                              <span className="muted text-xs">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </Modal>

      {openOrderId !== null ? (
        <OrderDetailModal orderId={openOrderId} onClose={() => setOpenOrderId(null)} />
      ) : null}

      {lightbox ? (
        <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />
      ) : null}
    </>
  );
}

function Metric({
  label,
  value,
  strong,
  danger,
}: {
  label: string;
  value: string;
  strong?: boolean;
  danger?: boolean;
}) {
  return (
    <span>
      <span className="muted">{label} </span>
      <span
        className={strong ? "font-semibold" : ""}
        style={{ color: danger ? "var(--danger)" : "var(--text)" }}
      >
        {value}
      </span>
    </span>
  );
}

function Thumb({ src, alt }: { src: string | null; alt: string }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={src}
        alt={alt}
        className="h-24 w-24 shrink-0 rounded-lg border object-cover"
        style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}
      />
    );
  }
  return (
    <div
      className="flex h-24 w-24 shrink-0 items-center justify-center rounded-lg border"
      style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="h-9 w-9" fill="none" stroke="var(--muted-2)" strokeWidth="1.4">
        <path d="M4 8l4-4h8l4 4M4 8v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8M4 8h16M9 12h6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
