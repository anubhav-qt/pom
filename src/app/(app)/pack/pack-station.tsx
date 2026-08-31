"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import { ChannelTag } from "@/components/ui";
import type { Channel } from "@/db/schema";

import { confirmPacked, scanOrder, type ScanResult } from "./actions";

type Feedback = { tone: "ok" | "warn" | "stop"; text: string } | null;

export function PackStation({ initial }: { initial: { remaining: number; packedToday: number } }) {
  const [result, setResult] = useState<ScanResult | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [stats, setStats] = useState(initial);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  // The scanner acts as a keyboard, so the input must never lose focus —
  // otherwise a scan goes nowhere and the packer does not notice.
  useEffect(() => {
    const refocus = () => inputRef.current?.focus();
    refocus();
    const id = window.setInterval(refocus, 1500);
    return () => window.clearInterval(id);
  }, []);

  /** Read the input, clear it for the next scan, and look the code up. */
  function submitCode() {
    const input = inputRef.current;
    if (!input) return;
    const value = input.value;
    input.value = "";
    if (value.trim()) handleScan(value);
  }

  function handleScan(code: string) {
    setFeedback(null);
    startTransition(async () => {
      try {
        const res = await scanOrder(code);
        setResult(res);
        if (!res.found) {
          setFeedback({
            tone: res.message?.startsWith("STOP") ? "stop" : "warn",
            text: res.message ?? "Not found.",
          });
        } else if (res.order?.alreadyPacked) {
          setFeedback({
            tone: "warn",
            text: "This parcel was already packed — possible duplicate.",
          });
        }
      } catch (err) {
        // Never fail silently here: a packer who sees nothing happen assumes
        // the scan worked and ships the parcel anyway.
        setFeedback({
          tone: "stop",
          text: `Lookup failed — ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });
  }

  function pack() {
    const order = result?.order;
    if (!order) return;

    startTransition(async () => {
      try {
        const res = await confirmPacked(order.id);
        if (res.ok) {
          setFeedback({ tone: "ok", text: `Packed ${order.externalOrderId}` });
          setResult(null);
          setStats((s) => ({
            remaining: Math.max(0, s.remaining - 1),
            packedToday: s.packedToday + 1,
          }));
        } else {
          setFeedback({ tone: "warn", text: res.error });
        }
      } catch (err) {
        setFeedback({
          tone: "stop",
          text: `Could not save — ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      inputRef.current?.focus();
    });
  }

  const order = result?.order;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline gap-6">
        <h1 className="text-lg font-semibold">Packing station</h1>
        <span className="muted text-sm tabular-nums">
          {stats.remaining} left · {stats.packedToday} packed
        </span>
      </div>

      <div className="panel p-3">
        <label htmlFor="code" className="muted mb-1 block text-xs font-medium">
          Scan AWB, order ID or packet ID
        </label>
        <div className="flex gap-2">
          <input
            id="code"
            name="code"
            ref={inputRef}
            autoComplete="off"
            className="input text-lg font-mono"
            placeholder="Waiting for scan…"
            /**
             * Handled explicitly rather than through form submission. A barcode
             * scanner ends every scan with Enter, and implicit form submission
             * is inconsistent enough across browsers that a scan could silently
             * do nothing — the worst possible failure at a packing bench.
             */
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              submitCode();
            }}
          />
          <button className="btn" onClick={submitCode} disabled={pending}>
            Look up
          </button>
        </div>
      </div>

      {feedback ? (
        <div
          className={
            feedback.tone === "stop"
              ? "rounded-md bg-rose-500/15 px-4 py-3 text-lg font-bold text-rose-600"
              : feedback.tone === "warn"
                ? "rounded-md bg-amber-500/15 px-4 py-3 text-sm font-medium text-amber-600"
                : "rounded-md bg-emerald-500/15 px-4 py-3 text-sm font-medium text-emerald-600"
          }
          role="status"
        >
          {feedback.text}
        </div>
      ) : null}

      {order ? (
        <div className="panel p-4">
          <div className="flex flex-wrap items-center gap-3">
            <ChannelTag channel={order.channel as Channel} />
            <span className="font-mono text-sm">{order.externalOrderId}</span>
            <span className="muted text-sm">
              {[order.buyerName, order.shipCity].filter(Boolean).join(" · ")}
            </span>
          </div>

          <ul className="mt-4 space-y-2">
            {order.items.map((item, i) => (
              <li
                key={i}
                className="flex items-center gap-3 rounded-md px-3 py-2"
                style={{ background: "var(--bg)" }}
              >
                <span className="min-w-[3rem] text-2xl font-bold tabular-nums">
                  {item.quantity}×
                </span>
                <span className="flex-1">
                  <span className="font-mono text-sm">{item.sku}</span>
                  {item.title ? <div className="muted text-xs">{item.title}</div> : null}
                </span>
                {item.binLocation ? (
                  <span className="rounded bg-blue-500/10 px-2 py-1 text-sm font-semibold text-blue-600">
                    {item.binLocation}
                  </span>
                ) : (
                  <span className="muted text-xs">no bin set</span>
                )}
              </li>
            ))}
          </ul>

          <button
            className="btn btn-primary mt-4 w-full py-3 text-base"
            onClick={pack}
            disabled={pending}
          >
            {pending ? "Saving…" : "Confirm packed"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
