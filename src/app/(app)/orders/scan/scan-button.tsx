"use client";

import { useState } from "react";

import { ScanModal } from "./scan-modal";

/**
 * The "Scan Barcode" trigger.
 *
 * Sits in the right slot of whichever toolbar row it is dropped into, so the
 * page owns its placement rather than this component reaching for a corner.
 */
export function ScanBarcodeButton({
  onDone,
  className = "btn",
}: {
  className?: string;
  /** Called after anything was committed, so the page can refetch. */
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={className}
        aria-haspopup="dialog"
      >
        <ScanIcon />
        Scan
      </button>

      {open ? (
        <ScanModal onClose={() => setOpen(false)} onDone={onDone} />
      ) : null}
    </>
  );
}

export function ScanIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="var(--accent)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 7V5a2 2 0 0 1 2-2h2" />
      <path d="M17 3h2a2 2 0 0 1 2 2v2" />
      <path d="M21 17v2a2 2 0 0 1-2 2h-2" />
      <path d="M7 21H5a2 2 0 0 1-2-2v-2" />
      <path d="M3 12h18" />
    </svg>
  );
}
