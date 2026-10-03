"use client";

import { useState, useTransition } from "react";

import { Spinner } from "@/components/ui";
import { withBasePath } from "@/lib/base-path";
import { money } from "@/lib/utils";

import type { StoreOrderInfo } from "./actions";
import { paribelleOrderAction } from "./paribelle-actions";

/** Couriers offered as the AWB is typed; any other name works too. */
const COURIERS = ["Delhivery", "Blue Dart", "DTDC", "Xpressbees", "Ekart", "Shadowfax", "Ecom Express", "India Post", "Shiprocket"];

const STATUS_WORDS: Record<string, string> = {
  pending: "Placed, not confirmed",
  confirmed: "Confirmed",
  processing: "Processing",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
  return_requested: "Exchange asked for",
  return_approved: "Exchange approved",
  returned: "Returned",
  refunded: "Refunded",
};

type Act = Parameters<typeof paribelleOrderAction>[1];
type Form = null | "ship" | "cancel" | "refused";

/**
 * A paribelle.in order's own state and what can be done to it from here: confirm,
 * ship with the courier's AWB, mark delivered, cancel, or record a COD parcel
 * refused at the door. Each goes to the store first, which tells the customer.
 */
export function ParibellePanel({
  orderId,
  store,
  isOwner,
  onChanged,
}: {
  orderId: number;
  store: StoreOrderInfo;
  isOwner: boolean;
  onChanged: () => void;
}) {
  const [form, setForm] = useState<Form>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const cod = (store.paymentMethod ?? "").toLowerCase() === "cod";
  const s = store.status;

  const run = (act: Act) =>
    start(async () => {
      setError(null);
      const res = await paribelleOrderAction(orderId, act);
      if (!res.ok) return setError(res.error);
      setForm(null);
      onChanged();
    });

  const canShip = s === "pending" || s === "confirmed" || s === "processing";
  const canCancel = s === "pending" || s === "confirmed";

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--muted)" }}>
          paribelle.in
        </h3>
        {s !== "cancelled" ? (
          <a className="btn px-2 py-1 text-xs" href={withBasePath(`/api/paribelle/label/${orderId}`)} target="_blank" rel="noreferrer">
            Label
          </a>
        ) : null}
      </div>

      <div className="surface-2 space-y-3 px-3.5 py-3 text-sm">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-semibold">{STATUS_WORDS[s] ?? s}</span>
          <span className="muted text-xs">
            {cod ? `COD ${money(store.total)}` : `Prepaid ${money(store.total)}`}
            {store.replacementFor ? ` · replaces exchange ${store.replacementFor}` : ""}
          </span>
        </div>

        <div className="text-[13px] leading-snug">
          <div>
            {store.name}
            {store.phone ? <span className="muted"> · {store.phone}</span> : null}
          </div>
          <div className="muted">{store.address}</div>
        </div>

        {store.notes ? <p className="text-[13px]">Note from the customer: {store.notes}</p> : null}
        {s === "cancelled" && store.cancellationReason ? <p className="muted text-[13px]">{store.cancellationReason}</p> : null}

        {error ? (
          <p className="rounded-lg px-3 py-2 text-[13px]" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}

        {form === "ship" ? (
          <ShipForm pending={pending} onCancel={() => setForm(null)} onSubmit={(courier, awb) => run({ action: "ship", courier, awb })} />
        ) : form === "cancel" ? (
          <ReasonForm
            pending={pending}
            label="Why it's cancelled (the customer sees this)"
            submit="Cancel the order"
            onCancel={() => setForm(null)}
            onSubmit={(reason) => run({ action: "cancel", reason })}
          />
        ) : form === "refused" ? (
          <RefusedForm total={store.total} pending={pending} onCancel={() => setForm(null)} onSubmit={(act) => run(act)} />
        ) : (
          <div className="flex flex-wrap gap-2">
            {s === "pending" ? (
              <button className="btn text-xs" disabled={pending} onClick={() => run({ action: "confirm" })}>
                Confirm
              </button>
            ) : null}
            {canShip ? (
              <button className="btn btn-primary text-xs" disabled={pending} onClick={() => setForm("ship")}>
                Ship with AWB
              </button>
            ) : null}
            {s === "shipped" ? (
              <button className="btn btn-primary text-xs" disabled={pending} onClick={() => run({ action: "deliver" })}>
                Mark delivered
              </button>
            ) : null}
            {s === "shipped" && cod && isOwner ? (
              <button className="btn text-xs" disabled={pending} onClick={() => setForm("refused")}>
                Refused at the door
              </button>
            ) : null}
            {canCancel ? (
              <button className="btn text-xs" disabled={pending} onClick={() => setForm("cancel")}>
                Cancel
              </button>
            ) : null}
            {pending ? <Spinner size="1.1rem" /> : null}
          </div>
        )}
      </div>
    </div>
  );
}

function ShipForm({ pending, onSubmit, onCancel }: { pending: boolean; onSubmit: (courier: string, awb: string) => void; onCancel: () => void }) {
  const [courier, setCourier] = useState("");
  const [awb, setAwb] = useState("");
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (courier.trim() && awb.trim()) onSubmit(courier, awb);
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <input className="input" list="pb-couriers" placeholder="Courier" value={courier} onChange={(e) => setCourier(e.target.value)} autoFocus required />
        <input className="input font-mono" placeholder="AWB" value={awb} onChange={(e) => setAwb(e.target.value)} required />
      </div>
      <datalist id="pb-couriers">
        {COURIERS.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <p className="muted text-xs">The customer gets the tracking, and the parcel leaves the pack queue here.</p>
      <div className="flex gap-2">
        <button className="btn btn-primary text-xs" disabled={pending || !courier.trim() || !awb.trim()}>
          {pending ? <Spinner size="1rem" color="currentColor" /> : "Mark shipped"}
        </button>
        <button type="button" className="btn text-xs" onClick={onCancel} disabled={pending}>
          Back
        </button>
      </div>
    </form>
  );
}

function ReasonForm({
  label,
  submit,
  pending,
  onSubmit,
  onCancel,
}: {
  label: string;
  submit: string;
  pending: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim()) onSubmit(reason);
      }}
    >
      <label className="muted block text-xs">{label}</label>
      <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus required />
      <div className="flex gap-2">
        <button className="btn btn-primary text-xs" disabled={pending || !reason.trim()}>
          {pending ? <Spinner size="1rem" color="currentColor" /> : submit}
        </button>
        <button type="button" className="btn text-xs" onClick={onCancel} disabled={pending}>
          Back
        </button>
      </div>
    </form>
  );
}

/** A COD parcel refused at the door: it comes back as an RTO, with store credit or nothing. */
function RefusedForm({
  total,
  pending,
  onSubmit,
  onCancel,
}: {
  total: number | null;
  pending: boolean;
  onSubmit: (act: Act) => void;
  onCancel: () => void;
}) {
  const [decision, setDecision] = useState<"nothing" | "credit">("nothing");
  const [amount, setAmount] = useState(total ? String(Math.round(total)) : "");
  const [reason, setReason] = useState("");
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({
          action: "cod_refused",
          decision,
          creditAmount: decision === "credit" ? Number(amount) : undefined,
          reason: reason.trim() || undefined,
        });
      }}
    >
      <div className="flex flex-wrap gap-4 text-[13px]">
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={decision === "nothing"} onChange={() => setDecision("nothing")} />
          No credit
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={decision === "credit"} onChange={() => setDecision("credit")} />
          Store credit
        </label>
      </div>
      {decision === "credit" ? (
        <input className="input" type="number" min={1} step={1} placeholder="Credit, ₹" value={amount} onChange={(e) => setAmount(e.target.value)} required />
      ) : null}
      <input className="input" placeholder="Note (optional)" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      <div className="flex gap-2">
        <button className="btn btn-primary text-xs" disabled={pending || (decision === "credit" && !(Number(amount) > 0))}>
          {pending ? <Spinner size="1rem" color="currentColor" /> : "Record refusal"}
        </button>
        <button type="button" className="btn text-xs" onClick={onCancel} disabled={pending}>
          Back
        </button>
      </div>
    </form>
  );
}
