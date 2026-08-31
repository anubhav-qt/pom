"use client";

import { useEffect, useState } from "react";

import { ChannelTag, StatusBadge } from "@/components/ui";
import { Modal } from "@/components/modal";
import type { Channel, OrderStatus } from "@/db/schema";
import { money } from "@/lib/utils";

import { getOrderDetail, type OrderDetail } from "./actions";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="muted text-[11px] font-medium uppercase tracking-wide">{label}</div>
      <div className="mt-0.5 text-sm">{value ?? <span className="muted">—</span>}</div>
    </div>
  );
}

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function OrderDetailModal({ orderId, onClose }: { orderId: number; onClose: () => void }) {
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);

    getOrderDetail(orderId)
      .then((d) => {
        if (cancelled) return;
        if (!d) setError("This order could not be found — it may have been removed.");
        else setDetail(d);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [orderId]);

  return (
    <Modal
      title={detail ? `Order ${detail.externalOrderId}` : "Order details"}
      onClose={onClose}
      width="40rem"
    >
      {error ? (
        <p className="rounded-lg px-3 py-2 text-sm" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
          {error}
        </p>
      ) : !detail ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-4 animate-pulse rounded" style={{ background: "var(--panel-2)" }} />
          ))}
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <ChannelTag channel={detail.channel as Channel} />
            <StatusBadge status={detail.status as OrderStatus} />
            {detail.isCod ? (
              <span
                className="rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wide"
                style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
              >
                COD
              </span>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <Field label="Ordered" value={formatDate(detail.orderedAt)} />
            <Field label="Dispatch by" value={formatDate(detail.dispatchBy)} />
            <Field label="Value" value={money(detail.totalAmount)} />
            <Field label="Buyer" value={detail.buyerName} />
            <Field
              label="Ship to"
              value={[detail.shipCity, detail.shipState, detail.shipPincode].filter(Boolean).join(", ") || null}
            />
            <Field label="Last updated" value={formatDate(detail.updatedAt)} />
          </div>

          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
              {detail.items.length === 1 ? "Item" : `Items · ${detail.items.length}`}
            </h3>
            <div className="space-y-2.5">
              {detail.items.map((item, i) => (
                <ItemCard key={i} item={item} channel={detail.channel} />
              ))}
            </div>
          </div>

          {detail.shipment ? (
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
                Shipment
              </h3>
              <div className="surface-2 grid grid-cols-2 gap-4 px-3.5 py-3 sm:grid-cols-3">
                <Field label="Courier" value={detail.shipment.courier} />
                <Field label="AWB" value={detail.shipment.awb} />
                <Field label="Packed" value={formatDate(detail.shipment.packedAt)} />
                <Field label="Dispatched" value={formatDate(detail.shipment.dispatchedAt)} />
                <Field label="Label on file" value={detail.shipment.hasLabel ? "Yes" : "No"} />
              </div>
            </div>
          ) : null}

          {detail.returnRecord ? (
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--danger)" }}>
                Return / RTO
              </h3>
              <div className="surface-2 grid grid-cols-2 gap-4 px-3.5 py-3 sm:grid-cols-3">
                <Field label="Type" value={detail.returnRecord.kind} />
                <Field label="Reason" value={detail.returnRecord.reason} />
                <Field label="Status" value={detail.returnRecord.status} />
                <Field label="Received" value={formatDate(detail.returnRecord.receivedAt)} />
                <Field label="Restocked" value={detail.returnRecord.receivedAt ? (detail.returnRecord.restocked ? "Yes" : "No") : null} />
              </div>
            </div>
          ) : null}

        </div>
      )}
    </Modal>
  );
}

const AMAZON_ASIN_URL = (asin: string) => `https://www.amazon.in/dp/${asin}`;

function ItemCard({
  item,
  channel,
}: {
  item: OrderDetail["items"][number];
  channel: string;
}) {
  return (
    <div
      className="flex gap-3.5 rounded-xl border p-3"
      style={{ background: "var(--panel-2)", borderColor: "var(--border)" }}
    >
      <ItemImage src={item.imageUrl} alt={item.title ?? item.sku} />

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="text-[13px] font-medium leading-snug" style={{ textWrap: "pretty" } as React.CSSProperties}>
          {item.title ?? <span className="muted italic">Unnamed item</span>}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[13px] font-semibold tabular-nums" style={{ color: "var(--accent)" }}>
            {item.quantity}×
          </span>
          <span className="font-mono text-xs">{item.sku}</span>
          {!item.mapped ? (
            <span
              className="rounded-full px-1.5 py-0.5 text-[9.5px] font-bold tracking-wide"
              style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
            >
              UNMAPPED
            </span>
          ) : null}
          {item.binLocation ? (
            <span
              className="rounded-full px-1.5 py-0.5 text-[9.5px] font-bold tracking-wide"
              style={{ background: "var(--accent-soft)", color: "var(--accent)" }}
            >
              BIN {item.binLocation}
            </span>
          ) : null}
          {item.cancelled ? (
            <span
              className="rounded-full px-1.5 py-0.5 text-[9.5px] font-bold tracking-wide"
              style={{ background: "var(--panel)", color: "var(--muted)" }}
            >
              CANCELLED
            </span>
          ) : null}
        </div>

        {item.asin ? (
          <div className="text-[11.5px]" style={{ color: "var(--muted)" }}>
            ASIN <span className="font-mono" style={{ color: "var(--text)" }}>{item.asin}</span>
            {channel === "amazon" ? (
              <>
                {" · "}
                <a
                  href={AMAZON_ASIN_URL(item.asin)}
                  target="_blank"
                  rel="noreferrer"
                  className="underline decoration-dotted"
                >
                  View on Amazon
                </a>
              </>
            ) : null}
          </div>
        ) : null}

        <div className="mt-0.5 flex items-baseline justify-between gap-3">
          <span className="text-[11.5px] tabular-nums" style={{ color: "var(--muted)" }}>
            {money(item.unitPrice)} × {item.quantity}
          </span>
          <span className="text-sm font-semibold tabular-nums">
            {item.unitPrice != null ? money(Number(item.unitPrice) * item.quantity) : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

function ItemImage({ src, alt }: { src: string | null; alt: string }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={src}
        alt={alt}
        className="h-28 w-28 shrink-0 rounded-lg border object-cover"
        style={{ borderColor: "var(--border)", background: "var(--panel)" }}
      />
    );
  }
  return (
    <div
      className="flex h-28 w-28 shrink-0 items-center justify-center rounded-lg border"
      style={{ borderColor: "var(--border)", background: "var(--panel)" }}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" className="h-10 w-10" fill="none" stroke="var(--muted-2)" strokeWidth="1.4">
        <path
          d="M4 8l4-4h8l4 4M4 8v11a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8M4 8h16M9 12h6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
