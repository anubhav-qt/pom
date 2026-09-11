"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { ImageLightbox } from "@/components/image-lightbox";
import { Modal } from "@/components/modal";
import type { ScanLookup, ScanStation } from "@/lib/scan";

import { scanCheckIn, scanConfirmPacked, scanListUnmappedOrders, scanLookup, scanMapAwb } from "../scan-actions";
import { playScanBeep } from "./beep";
import { useBarcodeScanner } from "./use-barcode-scanner";

/**
 * The scan bench, both stations.
 *
 * Outbound ends in one button: confirm, take the stock off, done. Inbound ends
 * in a question (did the goods come back sellable?) because restocking a worn
 * return is how a used item reaches the next customer, so it can never be
 * automatic.
 *
 * Three input routes, all landing on the same lookup: the camera, a bench
 * scanner typing into the box, and someone reading a code out and typing it.
 * The box is always focused so a scanner gun never fires into nowhere.
 */

type Feedback =
  | { tone: "ok"; text: string }
  | { tone: "warn"; text: string }
  | { tone: "stop"; title: string; text: string }
  | null;

interface Entry {
  id: number;
  code: string;
  label: string;
  tone: "ok" | "warn" | "stop";
  at: string;
}

export function ScanModal({
  station,
  onClose,
  onDone,
}: {
  station: ScanStation;
  onClose: () => void;
  onDone?: () => void;
}) {
  const outbound = station === "outbound";

  const [lookup, setLookup] = useState<ScanLookup | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [note, setNote] = useState("");
  const [log, setLog] = useState<Entry[]>([]);
  const [pending, startTransition] = useTransition();
  const [committing, setCommitting] = useState(false);
  /** Set when an outbound scan matched nothing, so it can be offered up for AWB mapping. */
  const [unmapped, setUnmapped] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const nextId = useRef(1);
  const changedRef = useRef(false);

  const push = useCallback((code: string, label: string, tone: Entry["tone"]) => {
    setLog((prev) =>
      [
        {
          id: nextId.current++,
          code,
          label,
          tone,
          at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
        ...prev,
      ].slice(0, 12),
    );
  }, []);

  /* ------------------------------------------------------------- lookup -- */

  /**
   * Render whatever a lookup came back with — a hit, a block, a miss — and
   * say whether the code should stay in the box (there is something on
   * screen for it now) or be cleared (nothing to do, ready for the next scan).
   * Shared by a direct scan and by a code that just got mapped to an order.
   */
  const applyLookup = useCallback(
    (res: ScanLookup, code: string) => {
      setLookup(res);
      setUnmapped(null);

      if (!res.ok) {
        if (res.reason === "blocked") {
          setFeedback({ tone: "stop", title: "STOP, do not ship this parcel", text: res.message });
          push(code, "Blocked", "stop");
        } else if (res.reason !== "empty") {
          setFeedback({ tone: "warn", text: res.message });
          push(code, "No match", "warn");
          // Amazon never hands us an AWB through sync, so "no match" at the
          // packing bench usually means this is one, not a bad scan.
          if (outbound) {
            setUnmapped(code);
            return true;
          }
        }
        return false;
      }

      if (res.outbound?.alreadyPacked) {
        setFeedback({
          tone: "warn",
          text: "This parcel was already scanned and dispatched. Nothing changed.",
        });
      } else if (res.inbound?.alreadyReceived) {
        setFeedback({ tone: "warn", text: "This one was already checked in. Nothing changed." });
      }
      return true;
    },
    [push, outbound],
  );

  const handleCode = useCallback(
    (raw: string) => {
      const code = raw.trim();
      if (!code || committing) return;

      setFeedback(null);
      setNote("");
      setUnmapped(null);
      startTransition(async () => {
        // The code stays visible in the box only while there is something
        // pending on screen for it (a hit to review, or a map-to-order
        // picker). Otherwise it is cleared once the lookup resolves so a
        // bench scanner's next code doesn't get typed onto the end of this one.
        let keepInBox = false;
        try {
          const res = await scanLookup(station, code);
          keepInBox = applyLookup(res, code);
        } catch (err) {
          // Never fail quietly here: someone who sees nothing happen assumes
          // the scan worked and ships the parcel anyway.
          setFeedback({
            tone: "stop",
            title: "Lookup failed",
            text: err instanceof Error ? err.message : String(err),
          });
        } finally {
          if (!keepInBox && inputRef.current) inputRef.current.value = "";
        }
      });
    },
    [committing, station, applyLookup],
  );

  // Camera detections land in the bottom bar first, exactly like a typed or
  // bench-scanner code, so the operator sees what was read before the lookup
  // resolves rather than lookup results just appearing out of nowhere.
  const handleDetected = useCallback(
    (code: string) => {
      if (inputRef.current) inputRef.current.value = code;
      playScanBeep();
      handleCode(code);
    },
    [handleCode],
  );

  const scanner = useBarcodeScanner(handleDetected);

  // The bench scanner acts as a keyboard, so the box must keep focus.
  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    focus();
    const id = window.setInterval(focus, 1500);
    return () => window.clearInterval(id);
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const input = inputRef.current;
    if (!input) return;
    // The code stays in the box while the lookup runs — cleared only once the
    // scan is actually resolved (see reset()), so the bar always shows what
    // was scanned rather than going blank mid-lookup.
    if (input.value.trim()) playScanBeep();
    handleCode(input.value);
  }

  /* ------------------------------------------------------------ commit -- */

  function reset() {
    setLookup(null);
    setNote("");
    setUnmapped(null);
    if (inputRef.current) inputRef.current.value = "";
    inputRef.current?.focus();
  }

  function confirmPacked() {
    if (!lookup?.ok || !lookup.outbound) return;
    const order = lookup.order;
    setCommitting(true);
    startTransition(async () => {
      try {
        const res = await scanConfirmPacked(order.orderId);
        if (!res.ok) {
          setFeedback({ tone: "stop", title: "Not dispatched", text: res.error });
          push(order.externalOrderId, "Refused", "stop");
        } else if (res.already) {
          setFeedback({ tone: "warn", text: "Already dispatched, so nothing moved." });
          push(order.externalOrderId, "Already dispatched", "warn");
        } else {
          changedRef.current = true;
          setFeedback({
            tone: "ok",
            text: `Dispatched ${order.externalOrderId}. Ready for the next scan.`,
          });
          push(order.externalOrderId, "Dispatched", "ok");
        }
        reset();
      } finally {
        setCommitting(false);
      }
    });
  }

  function checkIn(itemBack: boolean) {
    if (!lookup?.ok || !lookup.inbound) return;
    const order = lookup.order;
    const inbound = lookup.inbound;
    setCommitting(true);
    startTransition(async () => {
      try {
        const res = await scanCheckIn({
          kind: inbound.kind,
          recordId: inbound.recordId,
          itemBack,
          note,
          code: lookup.code,
          orderId: order.orderId,
        });
        if (!res.ok) {
          setFeedback({ tone: "stop", title: "Not checked in", text: res.error });
          push(order.externalOrderId, "Refused", "stop");
        } else {
          changedRef.current = true;
          setFeedback({
            tone: "ok",
            text: itemBack
              ? `Checked in ${order.externalOrderId} and put the stock back on.`
              : `Checked in ${order.externalOrderId} as damaged. Stock was not restocked.`,
          });
          push(order.externalOrderId, itemBack ? "Restocked" : "Damaged", "ok");
        }
        reset();
      } finally {
        setCommitting(false);
      }
    });
  }

  function close() {
    scanner.stop();
    if (changedRef.current) onDone?.();
    onClose();
  }

  const busy = pending || committing;
  const hit = lookup?.ok ? lookup : null;
  const order = hit?.order ?? null;
  const canPack = Boolean(lookup?.ok && lookup.outbound && !lookup.outbound.alreadyPacked);
  const canCheckIn = Boolean(lookup?.ok && lookup.inbound && !lookup.inbound.alreadyReceived);

  return (
    <Modal
      title={outbound ? "Scan barcode, packing" : "Scan barcode, goods in"}
      onClose={close}
      width="36rem"
    >
      <div className="flex flex-col gap-4">
        <Viewfinder scanner={scanner} />

        {/* manual entry */}
        <form onSubmit={submit} className="flex flex-col gap-1.5">
          <div className="flex gap-2">
            <div className="relative flex-grow">
              <input
                ref={inputRef}
                className="input pl-10 font-mono text-[13.5px]"
                placeholder="Scan or type a code"
                autoComplete="off"
                spellCheck={false}
                aria-label="Barcode"
              />
              <svg
                className="pointer-events-none absolute left-3.5 top-2.5 h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--muted-2)"
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
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Working" : "Look up"}
            </button>
          </div>
          <p className="muted text-xs">
            {outbound
              ? "Order ID, AWB or shipment ID. A bench scanner types straight into this box."
              : "Order ID, AWB or return ID. RTOs and customer returns are both found here."}
          </p>
        </form>

        {feedback ? <FeedbackBanner feedback={feedback} /> : null}

        {unmapped ? (
          <AwbMapper
            code={unmapped}
            busy={busy}
            onClose={() => setUnmapped(null)}
            onMapped={(res, code) => {
              if (res.ok) push(res.order.externalOrderId, "AWB mapped", "ok");
              applyLookup(res, code);
            }}
          />
        ) : null}

        {hit ? (
          <div
            className="overflow-hidden rounded-xl border"
            style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}
          >
            <OrderCard lookup={hit} onOpenImage={(src, alt) => setLightbox({ src, alt })} />

            {outbound ? (
              <div
                className="flex items-center justify-between gap-3 px-3.5 py-3"
                style={{ borderTop: "1px solid var(--border)", background: "var(--panel)" }}
              >
                <span className="muted text-xs">
                  {canPack ? "Stock comes off on confirm." : "Already dispatched."}
                </span>
                <div className="flex gap-2">
                  <button type="button" className="btn" onClick={reset} disabled={busy}>
                    Skip
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={confirmPacked}
                    disabled={busy || !canPack}
                  >
                    Confirm dispatch
                  </button>
                </div>
              </div>
            ) : (
              <div
                className="flex flex-col gap-2.5 p-3.5"
                style={{ borderTop: "1px solid var(--border)", background: "var(--panel)" }}
              >
                <span className="text-[13px] font-medium">
                  Did the goods come back sellable?
                </span>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    className="btn flex-grow"
                    onClick={() => checkIn(true)}
                    disabled={busy || !canCheckIn}
                    style={{ borderColor: "var(--ok)", background: "var(--ok-soft)" }}
                  >
                    Yes, put back on the shelf
                  </button>
                  <button
                    type="button"
                    className="btn flex-grow"
                    onClick={() => checkIn(false)}
                    disabled={busy || !canCheckIn}
                  >
                    No, damaged or missing
                  </button>
                </div>
                <input
                  className="input text-[13.5px]"
                  placeholder="Condition note (optional)"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={busy}
                />
              </div>
            )}
          </div>
        ) : null}

        {log.length > 0 ? <SessionLog log={log} /> : null}
      </div>

      {lightbox ? (
        <ImageLightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />
      ) : null}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */

type UnmappedOrder = Awaited<ReturnType<typeof scanListUnmappedOrders>>[number];

/**
 * "No match" at the packing bench: offer to tie the scanned code to whichever
 * packed order it belongs to, since it is almost always an AWB Amazon never
 * gave us through sync rather than a bad scan.
 */
function AwbMapper({
  code,
  busy,
  onClose,
  onMapped,
}: {
  code: string;
  busy: boolean;
  onClose: () => void;
  onMapped: (res: ScanLookup, code: string) => void;
}) {
  const [orders, setOrders] = useState<UnmappedOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mapping, setMapping] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    scanListUnmappedOrders().then((rows) => {
      if (!cancelled) setOrders(rows);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = orders?.filter(
    (o) =>
      !q ||
      o.externalOrderId.toLowerCase().includes(q) ||
      o.buyerName?.toLowerCase().includes(q),
  );

  async function pick(orderId: number) {
    setMapping(orderId);
    setError(null);
    try {
      const res = await scanMapAwb(orderId, code);
      if ("error" in res) {
        setError(res.error);
        return;
      }
      onMapped(res, code);
    } finally {
      setMapping(null);
    }
  }

  return (
    <div
      className="flex flex-col gap-2.5 rounded-xl border p-3.5"
      style={{ borderColor: "var(--border)", background: "var(--panel-2)" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[13.5px] font-medium">No order has this code yet</p>
          <p className="muted text-xs">
            Amazon doesn&rsquo;t give us the AWB automatically. Pick which packed order{" "}
            <span className="font-mono">{code}</span> belongs to, and it&rsquo;ll scan straight
            away next time.
          </p>
        </div>
        <button type="button" className="btn shrink-0 px-2.5 py-1 text-xs" onClick={onClose}>
          Dismiss
        </button>
      </div>

      {error ? (
        <p className="text-xs" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}

      {orders === null ? (
        <p className="muted text-xs">Loading packed orders&hellip;</p>
      ) : orders.length === 0 ? (
        <p className="muted text-xs">No packed orders are waiting on an AWB right now.</p>
      ) : (
        <>
          <input
            className="input text-[13px]"
            placeholder="Filter by order id or buyer"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div
            className="flex max-h-56 flex-col overflow-y-auto rounded-lg border"
            style={{ borderColor: "var(--border)" }}
          >
            {filtered?.length === 0 ? (
              <p className="muted p-3 text-xs">No packed orders match &ldquo;{query}&rdquo;.</p>
            ) : (
              filtered?.map((o, i) => (
                <button
                  key={o.orderId}
                  type="button"
                  disabled={busy || mapping !== null}
                  onClick={() => pick(o.orderId)}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 text-left"
                  style={{
                    background: "var(--panel)",
                    borderTop: i === 0 ? undefined : "1px solid var(--border)",
                  }}
                >
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-mono text-[12.5px]">{o.externalOrderId}</span>
                    <span className="muted truncate text-xs">
                      {o.buyerName ?? "No name"}
                      {o.shipCity ? ` · ${o.shipCity}${o.shipState ? `, ${o.shipState}` : ""}` : ""}
                    </span>
                  </span>
                  <span className="btn shrink-0 px-2.5 py-1 text-xs" aria-hidden>
                    {mapping === o.orderId ? "Mapping" : "Map"}
                  </span>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Viewfinder({ scanner }: { scanner: ReturnType<typeof useBarcodeScanner> }) {
  const { videoRef, state, start, stop } = scanner;
  const running = state.status === "running" || state.status === "starting";

  return (
    <div
      className="relative overflow-hidden rounded-xl"
      style={{ background: "#0b1a24", height: "13rem" }}
    >
      <video
        ref={videoRef}
        muted
        playsInline
        className="h-full w-full object-cover"
        style={{ display: running ? "block" : "none" }}
      />

      {running ? (
        <>
          {/* scan frame */}
          <div className="pointer-events-none absolute" style={{ inset: "18% 12%" }}>
            <span className="absolute left-0 top-0 h-6 w-6 rounded-tl-lg border-l-2 border-t-2" style={{ borderColor: "var(--accent-2)" }} />
            <span className="absolute right-0 top-0 h-6 w-6 rounded-tr-lg border-r-2 border-t-2" style={{ borderColor: "var(--accent-2)" }} />
            <span className="absolute bottom-0 left-0 h-6 w-6 rounded-bl-lg border-b-2 border-l-2" style={{ borderColor: "var(--accent-2)" }} />
            <span className="absolute bottom-0 right-0 h-6 w-6 rounded-br-lg border-b-2 border-r-2" style={{ borderColor: "var(--accent-2)" }} />
          </div>

          <span
            className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-medium"
            style={{ background: "rgba(8,20,28,0.6)", color: "#d6f4ff", backdropFilter: "blur(6px)" }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--ok)" }} />
            {state.status === "starting" ? "Starting" : "Camera on"}
          </span>
          <button
            type="button"
            onClick={stop}
            className="absolute right-3 top-3 rounded-lg px-2.5 py-1 text-xs font-medium"
            style={{ background: "rgba(8,20,28,0.6)", color: "#d6f4ff", backdropFilter: "blur(6px)" }}
          >
            Stop camera
          </button>
        </>
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center">
          <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="#7fa6bb" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
            <circle cx="12" cy="13" r="3.2" />
          </svg>
          {state.status === "idle" ? (
            <>
              <button type="button" onClick={start} className="btn">
                Use the camera
              </button>
              <p className="text-xs" style={{ color: "#7fa6bb" }}>
                Or just type the code below.
              </p>
            </>
          ) : (
            <p className="text-[13px]" style={{ color: "#a9cede" }}>
              {state.reason}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function FeedbackBanner({ feedback }: { feedback: NonNullable<Feedback> }) {
  if (feedback.tone === "stop") {
    return (
      <div
        className="flex items-start gap-3 rounded-xl p-4"
        style={{ border: "1.5px solid var(--danger)", background: "var(--danger-soft)" }}
        role="alert"
      >
        <svg viewBox="0 0 24 24" className="mt-px h-5 w-5 shrink-0" fill="none" stroke="var(--danger)" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="10" />
          <path d="m4.9 4.9 14.2 14.2" />
        </svg>
        <div>
          <p className="text-[15px] font-semibold" style={{ color: "var(--danger)" }}>
            {feedback.title}
          </p>
          <p className="mt-0.5 text-[13.5px] leading-snug">{feedback.text}</p>
        </div>
      </div>
    );
  }

  const warn = feedback.tone === "warn";
  return (
    <div
      className="flex items-start gap-3 rounded-xl px-4 py-3"
      style={{
        border: `1px solid ${warn ? "rgba(217,138,43,0.4)" : "rgba(16,185,129,0.4)"}`,
        background: warn ? "var(--warn-soft)" : "var(--ok-soft)",
      }}
      role="status"
    >
      <svg viewBox="0 0 24 24" className="mt-px h-5 w-5 shrink-0" fill="none" stroke={warn ? "var(--warn)" : "var(--ok)"} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {warn ? (
          <>
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v5" />
            <path d="M12 16h.01" />
          </>
        ) : (
          <path d="M20 6 9 17l-5-5" />
        )}
      </svg>
      <p className="text-[13.5px] leading-snug">{feedback.text}</p>
    </div>
  );
}

type ScanHit = Extract<ScanLookup, { ok: true }>;

function OrderCard({
  lookup,
  onOpenImage,
}: {
  lookup: ScanHit;
  onOpenImage: (src: string, alt: string) => void;
}) {
  const { order, inbound } = lookup;
  const first = order.items[0];

  return (
    <div className="flex gap-3.5 p-3.5">
      {first?.imageUrl ? (
        <button
          type="button"
          onClick={() => onOpenImage(first.imageUrl!, first.title ?? first.sku)}
          className="shrink-0"
          style={{ cursor: "zoom-in" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={first.imageUrl}
            alt=""
            className="h-20 w-16 rounded-lg object-cover"
            style={{ background: "var(--panel)" }}
          />
        </button>
      ) : (
        <div className="h-20 w-16 shrink-0 rounded-lg" style={{ background: "var(--bg-subtle)" }} />
      )}

      <div className="flex min-w-0 flex-grow flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-[13px] font-medium">{order.externalOrderId}</span>
          {inbound ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11.5px] font-medium"
              style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--danger)" }} />
              {inbound.label}
            </span>
          ) : null}
          {order.isCod ? (
            <span
              className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[11.5px] font-medium"
              style={{ background: "var(--warn-soft)", color: "var(--warn)" }}
            >
              COD
            </span>
          ) : null}
        </div>

        {order.items.map((item, i) => (
          <div key={`${item.sku}-${i}`} className="flex flex-col gap-0.5">
            <p className="text-[13.5px] leading-snug" style={{ textWrap: "pretty" }}>
              {item.title ?? item.sku}
            </p>
            <div className="muted flex flex-wrap gap-3 text-xs">
              <span className="font-mono">{item.sku}</span>
              <span>Qty {item.quantity}</span>
              {item.binLocation ? <span>Bin {item.binLocation}</span> : null}
              {!item.mapped ? (
                <span style={{ color: "var(--warn)" }}>Unmapped, not stock controlled</span>
              ) : null}
            </div>
          </div>
        ))}

        <div className="muted flex flex-wrap gap-3 text-xs">
          {order.shipCity ? (
            <span>
              {order.shipCity}
              {order.shipState ? `, ${order.shipState}` : ""}
            </span>
          ) : null}
          {order.totalAmount ? <span>&#8377;{order.totalAmount}</span> : null}
          <span>Matched on {lookup.matchedOn.replace("_", " ")}</span>
        </div>
      </div>
    </div>
  );
}

function SessionLog({ log }: { log: Entry[] }) {
  return (
    <div>
      <div className="flex items-center justify-between pb-2">
        <span
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: "var(--muted-2)" }}
        >
          This session
        </span>
        <span className="muted text-xs">
          {log.filter((e) => e.tone === "ok").length} done
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border" style={{ borderColor: "var(--border)" }}>
        {log.map((entry, i) => (
          <div
            key={entry.id}
            className="flex items-center gap-2.5 px-3 py-2.5"
            style={{
              background: "var(--panel)",
              borderTop: i === 0 ? undefined : "1px solid var(--border)",
            }}
          >
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{
                background:
                  entry.tone === "ok"
                    ? "var(--ok)"
                    : entry.tone === "warn"
                      ? "var(--warn)"
                      : "var(--danger)",
              }}
            />
            <span className="min-w-0 flex-grow truncate font-mono text-[12.5px]">
              {entry.code}
            </span>
            <span
              className="text-xs"
              style={{
                color:
                  entry.tone === "ok"
                    ? "var(--muted)"
                    : entry.tone === "warn"
                      ? "var(--warn)"
                      : "var(--danger)",
              }}
            >
              {entry.label}
            </span>
            <span className="w-10 text-right text-xs" style={{ color: "var(--muted-2)" }}>
              {entry.at}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
