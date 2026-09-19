"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useState, useTransition } from "react";

import { ChannelTag, Empty, Spinner } from "@/components/ui";
import type { Channel } from "@/db/schema";
import { dayLabel } from "@/lib/utils";

import { receiveReturn } from "./actions";

export interface ReturnRow {
  id: number;
  channel: Channel;
  externalReturnId: string;
  externalOrderId: string | null;
  kind: "return" | "rto" | "exchange";
  reason: string | null;
  awb: string | null;
  status: string | null;
  expectedAt: string | null;
  receivedAt: string | null;
  restocked: boolean;
  conditionNote: string | null;
}

const KIND_LABEL = {
  return: "Customer return",
  rto: "RTO",
  exchange: "Exchange",
} as const;

export function ReturnsTable({ rows, showAll }: { rows: ReturnRow[]; showAll: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  function checkIn(returnId: number, restock: boolean, note: string) {
    startTransition(async () => {
      const res = await receiveReturn({ returnId, restock, conditionNote: note });
      if (!res.ok) setError(res.error);
      else {
        setError(null);
        setOpen(null);
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Returns &amp; RTO</h1>
        <Link
          href={showAll ? "/returns" : "/returns?show=all"}
          className="btn ml-auto text-xs"
        >
          {showAll ? "Show pending only" : "Show all"}
        </Link>
      </div>

      {error ? (
        <p className="rounded-md bg-rose-500/10 px-3 py-2 text-sm text-rose-600">{error}</p>
      ) : null}

      <div className="panel overflow-x-auto">
        {rows.length === 0 ? (
          <Empty
            title={showAll ? "No returns recorded" : "Nothing waiting to be checked in"}
            hint="Returns arrive from Flipkart automatically. Amazon and Meesho returns need to be added by hand for now."
          />
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th>Return</th>
                <th>Type</th>
                <th>Order</th>
                <th>Reason</th>
                <th>Expected</th>
                <th>Status</th>
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Fragment key={row.id}>
                  <tr>
                    <td>
                      <ChannelTag channel={row.channel} />
                      <div className="font-mono text-xs">{row.externalReturnId}</div>
                      {row.awb ? <div className="muted text-xs">AWB {row.awb}</div> : null}
                    </td>

                    <td>
                      <span
                        className={
                          row.kind === "rto"
                            ? "rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-600"
                            : "rounded bg-rose-500/10 px-1.5 py-0.5 text-xs font-medium text-rose-600"
                        }
                      >
                        {KIND_LABEL[row.kind]}
                      </span>
                    </td>

                    <td className="font-mono text-xs">{row.externalOrderId ?? "—"}</td>
                    <td className="max-w-[14rem] truncate text-xs">{row.reason ?? "—"}</td>
                    <td className="text-xs">
                      {row.expectedAt ? dayLabel(new Date(row.expectedAt)) : "—"}
                    </td>

                    <td className="text-xs">
                      {row.receivedAt ? (
                        <span className="text-emerald-600">
                          Checked in {dayLabel(new Date(row.receivedAt))}
                          {row.restocked ? " · restocked" : " · not restocked"}
                        </span>
                      ) : (
                        <span className="muted">{row.status ?? "In transit"}</span>
                      )}
                    </td>

                    <td className="text-right">
                      {row.receivedAt ? (
                        <span className="muted text-xs">Done</span>
                      ) : (
                        <button
                          className="btn text-xs"
                          onClick={() => setOpen(open === row.id ? null : row.id)}
                        >
                          Check in
                        </button>
                      )}
                    </td>
                  </tr>

                  {open === row.id ? (
                    <tr>
                      <td colSpan={7} style={{ background: "var(--bg)" }}>
                        <form
                          className="flex flex-wrap items-center gap-2 py-1"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const fd = new FormData(e.currentTarget);
                            checkIn(
                              row.id,
                              fd.get("restock") === "on",
                              String(fd.get("note") ?? ""),
                            );
                          }}
                        >
                          <label className="flex items-center gap-1.5 text-sm">
                            <input type="checkbox" name="restock" defaultChecked />
                            Sellable — put back into stock
                          </label>
                          <input
                            name="note"
                            className="input flex-1 min-w-[12rem]"
                            placeholder="Condition note (e.g. box torn, item fine)"
                          />
                          <button className="btn btn-primary" disabled={pending}>
                            {pending ? <Spinner size="1rem" color="currentColor" /> : "Confirm"}
                          </button>
                        </form>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
