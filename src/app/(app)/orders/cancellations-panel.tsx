"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { ChannelTag, StatusBadge } from "@/components/ui";
import { Empty } from "@/components/ui";
import type { OrderStatus } from "@/db/schema";
import { cn, dayLabel, money } from "@/lib/utils";

import { checkInCancellation, reopenCancellation } from "./actions";
import type { CancellationRecord } from "./queries";

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

  function act(eventId: number, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusyId(eventId);
    startTransition(async () => {
      await fn();
      setBusyId(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="inline-flex rounded-[10px] p-[3px]"
          style={{ background: "var(--panel)", border: "1px solid var(--border)", boxShadow: "var(--shadow-xs)" }}
        >
          <SubTab
            href="/orders?view=cancellations"
            active={!resolved}
            onSelect={onResolvedChange ? () => onResolvedChange(false) : undefined}
          >
            Pending <Count n={counts.pending} />
          </SubTab>
          <SubTab
            href="/orders?view=cancellations&resolved=1"
            active={resolved}
            onSelect={onResolvedChange ? () => onResolvedChange(true) : undefined}
          >
            Completed <Count n={counts.completed} />
          </SubTab>
        </div>

        {rightSlot}
      </div>

      <div className="panel overflow-x-auto">
        {records.length === 0 ? (
          <Empty
            title={resolved ? "Nothing checked in yet" : "No pending cancellations"}
            hint={
              resolved
                ? "Records move here once someone ticks them off."
                : "Cancellations and RTOs waiting on a physical check-in show up here."
            }
          />
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Items</th>
                <th>Status change</th>
                <th>Detected</th>
                <th className="text-right">Value</th>
                <th>{resolved ? "Outcome" : "Item received?"}</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.eventId}>
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
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SubTab({
  href,
  active,
  onSelect,
  children,
}: {
  href: string;
  active: boolean;
  /** When given, the tab switches in place instead of navigating. */
  onSelect?: () => void;
  children: React.ReactNode;
}) {
  const className = cn(
    "inline-flex items-center gap-1.5 rounded-[7px] px-3 py-1.5 text-sm font-medium transition-colors",
    !active && "muted",
  );
  const style = active ? { background: "var(--accent-soft)", color: "#0b7fb0" } : undefined;

  if (onSelect) {
    return (
      <button type="button" onClick={onSelect} className={className} style={style}>
        {children}
      </button>
    );
  }

  return (
    <Link href={href} className={className} style={style}>
      {children}
    </Link>
  );
}

function Count({ n }: { n: number }) {
  return <span className="ml-1 tabular-nums opacity-70">{n}</span>;
}

function PendingCell({
  record,
  busy,
  onReceived,
  onNotReturning,
}: {
  record: CancellationRecord;
  busy: boolean;
  onReceived: () => void;
  onNotReturning: () => void;
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
      <button
        className="text-[11px] underline"
        style={{ color: "var(--muted)" }}
        disabled={busy}
        onClick={onNotReturning}
      >
        not returning
      </button>
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
        {back ? "Item back" : "Not returned"}
      </span>
      <span className="muted">
        {record.auto
          ? "auto — never shipped"
          : `by ${record.checkedInByName ?? "staff"} · ${dayLabel(new Date(record.checkedInAt!))}`}
      </span>
      <button className="text-[11px] underline" style={{ color: "var(--muted)" }} disabled={busy} onClick={onReopen}>
        reopen
      </button>
    </div>
  );
}
