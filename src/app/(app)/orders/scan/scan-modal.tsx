"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { ImageLightbox } from "@/components/image-lightbox";
import { Modal } from "@/components/modal";
import type { ScanStation } from "@/lib/scan";

import { CancellationCard } from "../cancellations-panel";
import { OrderCard as PackedOrderCard, type OrderRow } from "../order-table";
import {
  scanCheckIn,
  scanConfirmPacked,
  scanListAwaitingCheckIn,
  scanListPackedOrders,
  scanLookup,
  scanMapAndDispatch,
  scanRecordReturnCode,
} from "../scan-actions";
import { playScanBeep } from "./beep";
import { useBarcodeScanner } from "./use-barcode-scanner";

/**
 * The scan bench, both stations.
 *
 * Outbound ships the instant a scan matches: take the stock off, mark it
 * dispatched, done — no review step, so a bench scanner can fire the next
 * code the moment this one resolves. Inbound ends in a question (did the
 * goods come back sellable?) because restocking a worn return is how a used
 * item reaches the next customer, so it can never be automatic.
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

/** A pending cancellation/RTO or return, ready for the sellable question. */
interface CheckInTarget {
  orderId: number;
  externalOrderId: string;
  kind: "cancellation" | "return";
  recordId: number;
}

export function ScanModal({
  station,
  onClose,
  onDone,
  mapTo,
  checkInFor,
}: {
  station: ScanStation;
  onClose: () => void;
  onDone?: () => void;
  /**
   * "Map an AWB to this specific order" mode: every scan is tied straight to
   * `mapTo.orderId` instead of being looked up first. Set by the "map an AWB"
   * flow elsewhere in Orders, which already knows which order it wants —
   * running it through the normal lookup would just fail with "no match"
   * since that AWB is, by definition, not attached to any order yet.
   */
  mapTo?: { orderId: number; externalOrderId: string };
  /**
   * "Scan return for this order" mode — the goods-in mirror of `mapTo`. The
   * record is already known (a row's own scan icon opened this), so a scan
   * here only needs to confirm identity (or, failing a match, log the code)
   * before moving straight to the sellable question. A code that matches a
   * *different* order refuses rather than checking in the wrong parcel.
   */
  checkInFor?: CheckInTarget;
}) {
  const outbound = station === "outbound";

  const [feedback, setFeedback] = useState<Feedback>(null);
  const [note, setNote] = useState("");
  const [log, setLog] = useState<Entry[]>([]);
  const [pending, startTransition] = useTransition();
  const [committing, setCommitting] = useState(false);
  /** Set when an outbound scan matched nothing, so it can be offered up for AWB mapping. */
  const [unmapped, setUnmapped] = useState<string | null>(null);
  /** Set once a pending cancellation/RTO/return is confirmed, ready for the sellable question. */
  const [checkInTarget, setCheckInTarget] = useState<CheckInTarget | null>(null);
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

  const handleCode = useCallback(
    (raw: string) => {
      const code = raw.trim();
      if (!code || committing) return;

      setFeedback(null);
      setNote("");
      setUnmapped(null);
      startTransition(async () => {
        // The code stays visible in the box only while there is something
        // pending on screen for it (an inbound hit to review, or a
        // map-to-order picker). Otherwise it is cleared once the scan
        // resolves so a bench scanner's next code doesn't get typed onto the
        // end of this one.
        let keepInBox = false;
        try {
          if (mapTo) {
            // Already know which order this AWB belongs to, so skip the
            // lookup entirely — it would only ever come back "no match". A
            // manual AWB entry means the parcel is already in hand, so this
            // dispatches it in the same step rather than leaving a second
            // Confirm dispatch to click.
            const res = await scanMapAndDispatch(mapTo.orderId, code);
            if (!res.ok) {
              setFeedback({ tone: "stop", title: "Not mapped", text: res.error });
              push(code, "Refused", "stop");
            } else {
              changedRef.current = true;
              push(code, "Mapped + dispatched", "ok");
              setFeedback({
                tone: "ok",
                text: `Mapped ${code} to ${mapTo.externalOrderId} and marked shipped.`,
              });
              reset();
              onDone?.();
            }
          } else if (outbound) {
            // A packing-bench scan ships the parcel outright — no review
            // step, so the bench can fire the next code the instant this one
            // resolves.
            const res = await scanLookup(station, code);
            if (!res.ok) {
              if (res.reason === "blocked") {
                setFeedback({ tone: "stop", title: "STOP, do not ship this parcel", text: res.message });
                push(code, "Blocked", "stop");
              } else if (res.reason !== "empty") {
                setFeedback({ tone: "warn", text: res.message });
                push(code, "No match", "warn");
                // Amazon never hands us an AWB through sync, so "no match" at
                // the packing bench usually means this is one, not a bad scan.
                setUnmapped(code);
                keepInBox = true;
              }
            } else {
              const ship = await scanConfirmPacked(res.order.orderId);
              if (!ship.ok) {
                setFeedback({ tone: "stop", title: "Not dispatched", text: ship.error });
                push(res.order.externalOrderId, "Refused", "stop");
              } else if (ship.already) {
                setFeedback({ tone: "warn", text: "Already dispatched, so nothing moved." });
                push(ship.externalOrderId, "Already dispatched", "warn");
              } else {
                changedRef.current = true;
                setFeedback({ tone: "ok", text: `Shipped ${ship.externalOrderId}.` });
                push(ship.externalOrderId, "Shipped", "ok");
                onDone?.();
              }
              reset();
            }
          } else if (checkInFor) {
            // The record is already known — a scan here only needs to
            // confirm it's the right parcel (or, failing any match, log the
            // code) before moving to the sellable question.
            const res = await scanLookup(station, code);
            if (res.ok && res.order.orderId === checkInFor.orderId) {
              if (res.inbound?.alreadyReceived) {
                setFeedback({ tone: "warn", text: "This one was already checked in. Nothing changed." });
                push(code, "Already checked in", "warn");
              } else {
                push(code, "Matched", "ok");
                setCheckInTarget(checkInFor);
              }
            } else if (res.ok) {
              // Belongs to a different order entirely — refuse rather than
              // checking in the wrong parcel.
              setFeedback({
                tone: "stop",
                title: "Wrong order",
                text: `That code belongs to ${res.order.externalOrderId}, not ${checkInFor.externalOrderId}.`,
              });
              push(code, "Wrong order", "stop");
            } else if (res.reason !== "empty") {
              // No match anywhere — almost certainly the return's own AWB or
              // tracking sticker. Cancellations/RTOs have no field of their
              // own to hold that, so this just logs it against the order and
              // moves straight to the sellable question.
              await scanRecordReturnCode(checkInFor.orderId, code);
              push(code, "Logged", "ok");
              setCheckInTarget(checkInFor);
            }
          } else {
            // Plain goods-in scan: find whatever is pending for this code and
            // ask the sellable question, or offer the "no match" picker.
            const res = await scanLookup(station, code);
            if (!res.ok) {
              if (res.reason !== "empty") {
                setFeedback({ tone: "warn", text: res.message });
                push(code, "No match", "warn");
                // Almost always the return's own AWB or tracking sticker
                // rather than a bad scan.
                setUnmapped(code);
                keepInBox = true;
              }
            } else if (res.inbound?.alreadyReceived) {
              setFeedback({ tone: "warn", text: "This one was already checked in. Nothing changed." });
              push(code, "Already checked in", "warn");
            } else if (res.inbound) {
              push(code, "Matched", "ok");
              setCheckInTarget({
                orderId: res.order.orderId,
                externalOrderId: res.order.externalOrderId,
                kind: res.inbound.kind,
                recordId: res.inbound.recordId,
              });
            }
          }
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
    [committing, station, mapTo, checkInFor, outbound, onDone, push],
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
    setCheckInTarget(null);
    setNote("");
    setUnmapped(null);
    if (inputRef.current) inputRef.current.value = "";
    inputRef.current?.focus();
  }

  function checkIn(itemBack: boolean) {
    if (!checkInTarget) return;
    const target = checkInTarget;
    setCommitting(true);
    startTransition(async () => {
      try {
        const res = await scanCheckIn({
          kind: target.kind,
          recordId: target.recordId,
          itemBack,
          note,
          orderId: target.orderId,
        });
        if (!res.ok) {
          setFeedback({ tone: "stop", title: "Not checked in", text: res.error });
          push(target.externalOrderId, "Refused", "stop");
        } else {
          changedRef.current = true;
          setFeedback({
            tone: "ok",
            text: itemBack
              ? `Checked in ${target.externalOrderId}, restocked.`
              : `Checked in ${target.externalOrderId}, not restocked.`,
          });
          push(target.externalOrderId, itemBack ? "Restocked" : "Damaged", "ok");
          onDone?.();
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

  return (
    <Modal
      title={
        mapTo
          ? `Scan AWB for ${mapTo.externalOrderId}`
          : checkInFor
            ? `Scan return for ${checkInFor.externalOrderId}`
            : outbound
              ? "Scan barcode, packing"
              : "Scan barcode, goods in"
      }
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
            <button type="submit" className="btn btn-primary shrink-0 whitespace-nowrap" disabled={busy}>
              {busy ? "Working" : mapTo ? "Map AWB" : "Look up"}
            </button>
          </div>
          <p className="muted text-xs">
            {mapTo
              ? `Scan the courier label's AWB. It will be saved to ${mapTo.externalOrderId}.`
              : checkInFor
                ? `Scan the return's own label. It'll be logged against ${checkInFor.externalOrderId}.`
                : outbound
                ? "Order ID, AWB or shipment ID. A bench scanner types straight into this box."
                : "Order ID, AWB or return ID. RTOs and customer returns are both found here."}
          </p>
        </form>

        {feedback ? <FeedbackBanner feedback={feedback} /> : null}

        {unmapped && outbound && !mapTo ? (
          <AwbMapper
            code={unmapped}
            busy={busy}
            onOpenImage={(src, alt) => setLightbox({ src, alt })}
            onMapped={(res, code) => {
              changedRef.current = true;
              push(res.externalOrderId, "Mapped + dispatched", "ok");
              setFeedback({
                tone: "ok",
                text: `Mapped ${code} to ${res.externalOrderId} and marked shipped.`,
              });
              reset();
              onDone?.();
            }}
          />
        ) : null}

        {unmapped && !outbound && !checkInFor ? (
          <CheckInPicker
            code={unmapped}
            busy={busy}
            onOpenImage={(src, alt) => setLightbox({ src, alt })}
            onPicked={(target) => {
              push(target.externalOrderId, "Matched", "ok");
              setUnmapped(null);
              setCheckInTarget(target);
            }}
          />
        ) : null}

        {checkInTarget ? (
          <div className="flex flex-col gap-2.5">
            <span className="text-[13px] font-medium">Did the goods come back sellable?</span>
            <div className="flex flex-col gap-2 sm:flex-row">
              <button
                type="button"
                className="btn btn-primary flex-grow whitespace-nowrap"
                onClick={() => checkIn(true)}
                disabled={busy}
              >
                Sellable, restock
              </button>
              <button
                type="button"
                className="btn flex-grow whitespace-nowrap"
                onClick={() => checkIn(false)}
                disabled={busy}
              >
                Damaged, don&rsquo;t restock
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

/**
 * "No match" at the packing bench: offer to tie the scanned code to whichever
 * packed order it belongs to, since it is almost always an AWB Amazon never
 * gave us through sync rather than a bad scan.
 *
 * Shows the exact same rows, in the exact same order, as the Orders page's
 * Packed tab — including orders that already have an AWB, since mapping one
 * just replaces it (`mapAwbToOrder` still refuses a code already tied to a
 * *different* order). Rows render with the same mobile `OrderCard` the Packed
 * tab itself uses, so nothing here looks or sorts differently from what the
 * operator can see on that tab.
 */
type MapAndDispatchResult = Awaited<ReturnType<typeof scanMapAndDispatch>>;
type MapAndDispatchOk = Extract<MapAndDispatchResult, { ok: true }>;

function AwbMapper({
  code,
  busy,
  onOpenImage,
  onMapped,
}: {
  code: string;
  busy: boolean;
  onOpenImage: (src: string, alt: string) => void;
  onMapped: (res: MapAndDispatchOk, code: string) => void;
}) {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mapping, setMapping] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    scanListPackedOrders().then((rows) => {
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
      const res = await scanMapAndDispatch(orderId, code);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Shipped — it belongs on neither this picker nor the Packed tab
      // anymore. Removing it here covers the moment before the parent
      // dismisses the whole picker; a fresh `unmapped` code remounts this
      // component and refetches from scratch regardless.
      setOrders((prev) => prev?.filter((o) => o.id !== orderId) ?? prev);
      onMapped(res, code);
    } finally {
      setMapping(null);
    }
  }

  const locked = busy || mapping !== null;

  if (orders?.length === 0) {
    return <p className="muted text-xs">No packed orders right now.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="muted text-xs">
        Packed orders &middot; tap to map <span className="font-mono">{code}</span>
      </p>

      {error ? (
        <p className="text-xs" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}

      {orders === null ? (
        <p className="muted text-xs">Loading packed orders&hellip;</p>
      ) : (
        <>
          {orders.length > 5 ? (
            <input
              className="input text-[13px]"
              placeholder="Filter by order id or buyer"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          ) : null}

          <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
            {filtered?.length === 0 ? (
              <p className="muted text-xs">No packed orders match &ldquo;{query}&rdquo;.</p>
            ) : (
              filtered?.map((row) => (
                <PackedOrderCard
                  key={row.id}
                  row={row}
                  onOpen={locked ? () => {} : () => pick(row.id)}
                  onOpenImage={onOpenImage}
                  onScanAwb={locked ? undefined : () => pick(row.id)}
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * "No match" at goods-in: offer to tie the scanned code to whichever pending
 * cancellation/RTO it belongs to, since it is almost always the return's own
 * AWB or tracking sticker rather than a bad scan. Same rows, same card, as
 * the Cancellations tab's Pending list (customer returns live on the
 * separate /returns page and aren't part of this rollup).
 */
type AwaitingRecord = Awaited<ReturnType<typeof scanListAwaitingCheckIn>>[number];

function CheckInPicker({
  code,
  busy,
  onOpenImage,
  onPicked,
}: {
  code: string;
  busy: boolean;
  onOpenImage: (src: string, alt: string) => void;
  onPicked: (target: CheckInTarget) => void;
}) {
  const [records, setRecords] = useState<AwaitingRecord[] | null>(null);
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    scanListAwaitingCheckIn().then((rows) => {
      if (!cancelled) setRecords(rows);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = records?.filter((r) => !q || r.externalOrderId.toLowerCase().includes(q));

  async function pick(record: AwaitingRecord) {
    setPicking(record.eventId);
    try {
      // Cancellations/RTOs have no field of their own to hold a return code,
      // so — same as the checkInFor flow — this just logs it against the
      // order rather than inventing somewhere to put it.
      await scanRecordReturnCode(record.orderId, code);
      // Belongs to neither this picker nor the Cancellations tab's Pending
      // list once checked in; the parent hides this picker right away too.
      setRecords((prev) => prev?.filter((r) => r.eventId !== record.eventId) ?? prev);
      onPicked({
        orderId: record.orderId,
        externalOrderId: record.externalOrderId,
        kind: "cancellation",
        recordId: record.eventId,
      });
    } finally {
      setPicking(null);
    }
  }

  const locked = busy || picking !== null;

  if (records?.length === 0) {
    return <p className="muted text-xs">Nothing waiting on a check-in right now.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="muted text-xs">
        Awaiting check-in &middot; tap to log <span className="font-mono">{code}</span>
      </p>

      {records === null ? (
        <p className="muted text-xs">Loading&hellip;</p>
      ) : (
        <>
          {records.length > 5 ? (
            <input
              className="input text-[13px]"
              placeholder="Filter by order id"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          ) : null}

          <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
            {filtered?.length === 0 ? (
              <p className="muted text-xs">No records match &ldquo;{query}&rdquo;.</p>
            ) : (
              filtered?.map((r) => (
                <CancellationCard
                  key={r.eventId}
                  record={r}
                  resolved={false}
                  busy={locked}
                  onOpenImage={onOpenImage}
                  onPick={locked ? undefined : () => pick(r)}
                />
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
