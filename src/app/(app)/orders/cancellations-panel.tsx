"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { ImageLightbox } from "@/components/image-lightbox";
import { ChannelTag, StatusBadge } from "@/components/ui";
import { Empty } from "@/components/ui";
import type { OrderStatus } from "@/db/schema";
import { dayLabel, money } from "@/lib/utils";

import { checkInCancellation, reopenCancellation } from "./actions";
import { BarcodeIcon, OrderThumb } from "./order-table";
import type { CancellationRecord } from "./queries";
import { ScanModal } from "./scan/scan-modal";

export function CancellationsPanel({
  records,
  counts,
  resolved,
  onResolvedChange,
  rightSlot,
}: {
  records: CancellationRecord[];
  counts: { pending: number; completed: number };
  resolved: boolean;
  /**
   * Switch between Pending and Completed without a navigation, so the workspace
   * can serve the other tab from cache. Falls back to a link when absent.
   */
  onResolvedChange?: (resolved: boolean) => void;
  /** Rendered at the right end of the sub-tab row, e.g. the scan button. */
  rightSlot?: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  // Row scan icon on a "ready" (physically back) record: scan the return's
  // own label to confirm it, then ask sellable/damaged — same modal the
  // goods-in bench uses, just pre-told which record it's for.
  const [checkTarget, setCheckTarget] = useState<{
    orderId: number;
    externalOrderId: string;
    kind: "cancellation";
    recordId: number;
  } | null>(null);

  function act(eventId: number, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusyId(eventId);
    startTransition(async () => {
      await fn();
      setBusyId(null);
      router.refresh();
    });
  }

  function selectResolved(resolvedNext: boolean) {
    if (onResolvedChange) onResolvedChange(resolvedNext);
    else router.push(`/orders?view=cancellations${resolvedNext ? "&resolved=1" : ""}`);
  }

  return (
    <div className="space-y-4">
      {/* Scan Barcode moves to the mobile bottom nav's "Scanner" tab; this
          stays for desktop, which has no such nav. */}
      <div className="hidden justify-end sm:flex">{rightSlot}</div>

      {records.length === 0 ? (
        <div className="panel">
          <Empty
            title={resolved ? "Nothing checked in yet" : "No pending cancellations"}
            hint={
              resolved
                ? "Records move here once someone ticks them off."
                : "Cancellations and RTOs waiting on a physical check-in show up here."
            }
          />
        </div>
      ) : (
        <>
          {/* Cards below sm, the dense grid from sm up. */}
          <div className="flex flex-col gap-2.5 sm:hidden">
            {records.map((r) => (
              <CancellationCard
                key={r.eventId}
                record={r}
                resolved={resolved}
                busy={busyId === r.eventId && pending}
                onReceived={() => act(r.eventId, () => checkInCancellation(r.eventId, { itemBack: true }))}
                onNotReturning={() => act(r.eventId, () => checkInCancellation(r.eventId, { itemBack: false }))}
                onReopen={() => act(r.eventId, () => reopenCancellation(r.eventId))}
                onOpenImage={(src, alt) => setLightbox({ src, alt })}
                onScan={
                  !resolved && r.stage === "ready"
                    ? () =>
                        setCheckTarget({
                          orderId: r.orderId,
                          externalOrderId: r.externalOrderId,
                          kind: "cancellation",
                          recordId: r.eventId,
                        })
                    : undefined
                }
              />
            ))}
          </div>

          <div className="panel hidden overflow-x-auto sm:block">
          <table className="grid-table">
            <thead>
              <tr>
                <th className="w-14">Item</th>
                <th>Order</th>
                <th>Items</th>
                <th>Status change</th>
                <th>Detected</th>
                <th className="text-right">Value</th>
                <th>{resolved ? "Outcome" : "Item received?"}</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => {
                const thumbSrc = r.items.find((it) => it.imageUrl)?.imageUrl ?? null;
                const thumbAlt = r.items[0]?.title ?? r.externalOrderId;
                return (
                <tr key={r.eventId}>
                  <td>
                    <div className="relative w-11">
                      <span
                        onClick={(e) => {
                          if (!thumbSrc) return;
                          e.stopPropagation();
                          setLightbox({ src: thumbSrc, alt: thumbAlt });
                        }}
                      >
                        <OrderThumb src={thumbSrc} alt={thumbAlt} />
                      </span>
                      {r.items.length > 1 ? (
                        <span
                          className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white"
                          style={{ background: "var(--accent)" }}
                          title={`${r.items.length} different items in this order`}
                        >
                          +{r.items.length - 1}
                        </span>
                      ) : null}
                    </div>
                  </td>

                  <td>
                    <div className="flex items-center gap-2">
                      <ChannelTag channel={r.channel as never} />
                    </div>
                    <div className="mt-1 font-mono text-xs">{r.externalOrderId}</div>
                    <div className="muted text-xs">Ordered {dayLabel(new Date(r.orderedAt))}</div>
                  </td>

                  <td className="max-w-xs">
                    <div className="space-y-1.5">
                      {r.items.map((it, i) => (
                        <div key={i}>
                          <div className="line-clamp-2 text-[13px] font-medium leading-snug">
                            {it.title ?? <span className="muted italic">Unnamed item</span>}
                          </div>
                          <div className="muted mt-0.5 text-[11px]">
                            <span className="tabular-nums">{it.quantity}×</span>{" "}
                            <span className="font-mono">{it.sku}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </td>

                  <td>
                    <div className="flex items-center gap-2">
                      {r.fromStatus ? (
                        <StatusBadge status={r.fromStatus as OrderStatus} />
                      ) : (
                        <span className="muted text-xs">first seen</span>
                      )}
                      <span className="muted">→</span>
                      <StatusBadge status={r.toStatus as OrderStatus} />
                    </div>
                  </td>

                  <td className="text-xs">
                    <div>{dayLabel(new Date(r.detectedAt))}</div>
                    <div className="muted">
                      {new Date(r.detectedAt).toLocaleTimeString("en-IN", {
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                      {r.syncRunId ? ` · sync #${r.syncRunId}` : ""}
                    </div>
                  </td>

                  <td className="text-right tabular-nums">{money(r.totalAmount)}</td>

                  <td>
                    {resolved ? (
                      <ResolvedCell record={r} onReopen={() => act(r.eventId, () => reopenCancellation(r.eventId))} busy={busyId === r.eventId && pending} />
                    ) : (
                      <PendingCell
                        record={r}
                        busy={busyId === r.eventId && pending}
                        onReceived={() => act(r.eventId, () => checkInCancellation(r.eventId, { itemBack: true }))}
                        onNotReturning={() => act(r.eventId, () => checkInCancellation(r.eventId, { itemBack: false }))}
                        onScan={
                          r.stage === "ready"
                            ? () =>
                                setCheckTarget({
                                  orderId: r.orderId,
                                  externalOrderId: r.externalOrderId,
                                  kind: "cancellation",
                                  recordId: r.eventId,
                                })
                            : undefined
                        }
                      />
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </>
      )}

      {lightbox ? (
        <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />
      ) : null}

      {checkTarget ? (
        <ScanModal
          station="inbound"
          checkInFor={checkTarget}
          onClose={() => setCheckTarget(null)}
          onDone={() => router.refresh()}
        />
      ) : null}
    </div>
  );
}

/**
 * Mobile stand-in for a table row: same fields, same actions, stacked instead
 * of columned since a 6-column table has nowhere to go on a phone.
 */
export function CancellationCard({
  record,
  resolved,
  busy,
  onReceived,
  onNotReturning,
  onReopen,
  onOpenImage,
  onScan,
  onPick,
}: {
  record: CancellationRecord;
  resolved: boolean;
  busy: boolean;
  onReceived?: () => void;
  onNotReturning?: () => void;
  onReopen?: () => void;
  onOpenImage: (src: string, alt: string) => void;
  /** Row scan icon (only meaningful for a "ready" pending record). */
  onScan?: () => void;
  /**
   * Picker mode: this card is a row in the goods-in "no match" picker, not
   * the Cancellations tab itself. Tapping it selects the record instead of
   * doing anything to it, so the normal received/reopen controls don't show.
   */
  onPick?: () => void;
}) {
  const thumbSrc = record.items.find((it) => it.imageUrl)?.imageUrl ?? null;
  const thumbAlt = record.items[0]?.title ?? record.externalOrderId;

  return (
    <div className="panel flex gap-3 p-3">
      <span
        className="relative w-14 shrink-0"
        onClick={(e) => {
          if (!thumbSrc) return;
          e.stopPropagation();
          onOpenImage(thumbSrc, thumbAlt);
        }}
      >
        <OrderThumb src={thumbSrc} alt={thumbAlt} size="h-14 w-14" />
        {record.items.length > 1 ? (
          <span
            className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold text-white"
            style={{ background: "var(--accent)" }}
          >
            +{record.items.length - 1}
          </span>
        ) : null}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <ChannelTag channel={record.channel as never} />
        <span className="font-mono text-xs">{record.externalOrderId}</span>
      </div>

      <div className="flex items-center gap-2 text-xs">
        {record.fromStatus ? (
          <StatusBadge status={record.fromStatus as OrderStatus} />
        ) : (
          <span className="muted">first seen</span>
        )}
        <span className="muted">→</span>
        <StatusBadge status={record.toStatus as OrderStatus} />
      </div>

      <div className="space-y-1">
        {record.items.map((it, i) => (
          <div key={i} className="text-[13px] leading-snug">
            <span className="font-medium">
              {it.title ?? <span className="muted italic">Unnamed item</span>}
            </span>
            <span className="muted">
              {" "}
              · {it.quantity}× <span className="font-mono">{it.sku}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="muted flex flex-wrap items-center gap-x-2 text-xs">
        <span>Ordered {dayLabel(new Date(record.orderedAt))}</span>
        <span>·</span>
        <span>Detected {dayLabel(new Date(record.detectedAt))}</span>
        <span>·</span>
        <span className="tabular-nums">{money(record.totalAmount)}</span>
      </div>

      <div
        className="flex items-center justify-between pt-1"
        style={{ borderTop: "1px solid var(--border)" }}
      >
        {onPick ? (
          <button
            type="button"
            className="btn btn-primary ml-auto whitespace-nowrap"
            onClick={onPick}
            disabled={busy}
          >
            {busy ? "Matching" : "Match"}
          </button>
        ) : resolved ? (
          <ResolvedCell record={record} onReopen={onReopen!} busy={busy} />
        ) : (
          <PendingCell
            record={record}
            busy={busy}
            onReceived={onReceived!}
            onNotReturning={onNotReturning!}
            onScan={onScan}
          />
        )}
      </div>
      </div>
    </div>
  );
}

function PendingCell({
  record,
  busy,
  onReceived,
  onNotReturning,
  onScan,
}: {
  record: CancellationRecord;
  busy: boolean;
  onReceived: () => void;
  onNotReturning: () => void;
  /** Scan the return's own label instead of ticking it by hand. */
  onScan?: () => void;
}) {
  // "awaiting" = shipped then cancelled, but Amazon hasn't reported the parcel
  // coming back yet. Nothing to tick — the item may still be in transit or lost.
  if (record.stage === "awaiting") {
    return (
      <div className="flex flex-col items-start gap-1 text-xs">
        <span className="muted">Awaiting parcel — Amazon has not confirmed a return</span>
        <button
          className="text-[11px] underline"
          style={{ color: "var(--muted)" }}
          disabled={busy}
          onClick={onNotReturning}
        >
          mark not returning
        </button>
      </div>
    );
  }

  // "ready" = RTO, i.e. Amazon has marked the shipment ReturnedToSeller.
  return (
    <div className="flex flex-col items-start gap-1">
      <label className="flex cursor-pointer items-center gap-2 text-xs">
        <input type="checkbox" checked={false} disabled={busy} onChange={onReceived} />
        Received &amp; shelved
      </label>
      <span className="muted text-[11px]">
        Amazon returned it {dayLabel(new Date(record.detectedAt))}
      </span>
      <div className="flex items-center gap-2">
        <button
          className="text-[11px] underline"
          style={{ color: "var(--muted)" }}
          disabled={busy}
          onClick={onNotReturning}
        >
          not returning
        </button>
        {onScan ? (
          <button
            type="button"
            className="btn px-2 py-1"
            onClick={(e) => {
              e.stopPropagation();
              onScan();
            }}
            disabled={busy}
            aria-label={`Scan return for ${record.externalOrderId}`}
            title="Scan return"
          >
            <BarcodeIcon />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ResolvedCell({
  record,
  onReopen,
  busy,
}: {
  record: CancellationRecord;
  onReopen: () => void;
  busy: boolean;
}) {
  const back = record.itemBack;
  return (
    <div className="flex flex-col items-start gap-1 text-xs">
      <span
        className="rounded-full px-2 py-0.5 font-medium"
        style={
          back
            ? { background: "var(--ok-soft)", color: "var(--ok)" }
            : { background: "var(--panel-2)", color: "var(--muted)" }
        }
      >
        {/* Null is not "no". It means nobody ever recorded what came back, which
            is what a bulk close leaves behind, and claiming "Not returned" for
            an RTO that did ship would be inventing a fact. */}
        {back === null ? "Condition unknown" : back ? "Item back" : "Not returned"}
      </span>
      <span className="muted">
        {record.auto
          ? back === null
            ? "closed in bulk, never checked in"
            : "auto, never shipped"
          : `by ${record.checkedInByName ?? "staff"} · ${dayLabel(new Date(record.checkedInAt!))}`}
      </span>
      <button className="text-[11px] underline" style={{ color: "var(--muted)" }} disabled={busy} onClick={onReopen}>
        reopen
      </button>
    </div>
  );
}
