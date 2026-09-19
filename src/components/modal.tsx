"use client";

import { X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * A centred modal on a blurred scrim, portaled to `document.body` so it
 * escapes any `overflow-hidden`/`transform` ancestor (the sticky-header
 * wrapper, table containers) that would otherwise clip or mis-position a
 * `fixed` element nested inside them.
 *
 * Below `sm` there is no room to centre anything, so it becomes a full-screen
 * sheet instead — same header/body structure, just filling the viewport with
 * no rounded corners or scrim gap to fumble with a thumb.
 */
export function Modal({
  title,
  onClose,
  children,
  width = "36rem",
  aboveNav = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
  /** On a phone, stop above the bottom nav instead of covering it. */
  aboveNav?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // A modal open should not let the page behind it scroll.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div className={`fixed inset-x-0 top-0 z-50 flex items-stretch justify-center overflow-y-auto sm:items-start sm:px-4 sm:pb-10 sm:pt-20 lg:pt-28 ${aboveNav ? "bottom-[calc(56px+env(safe-area-inset-bottom))] sm:bottom-0" : "bottom-0"}`}>
      <div
        className={`fixed inset-x-0 top-0 ${aboveNav ? "bottom-[calc(56px+env(safe-area-inset-bottom))] sm:bottom-0" : "bottom-0"}`}
        style={{ background: "rgba(10, 20, 30, 0.35)", backdropFilter: "blur(3px)" }}
        onClick={onClose}
        aria-hidden
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="panel relative flex h-full w-full flex-col overflow-hidden rounded-none sm:h-auto sm:rounded-2xl"
        style={{ maxWidth: width, animation: "rise-in 0.18s var(--ease-premium)" }}
      >
        <div
          className="flex shrink-0 items-center justify-between border-b px-5 py-4"
          style={{ borderColor: "var(--border)" }}
        >
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          <button onClick={onClose} className="nav-icon-btn" aria-label="Close">
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 sm:max-h-[75vh] sm:flex-none">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
