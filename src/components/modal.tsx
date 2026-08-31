"use client";

import { X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * A centred modal on a blurred scrim. Portaled to `document.body` so it
 * escapes any `overflow-hidden`/`transform` ancestor (the sticky-header
 * wrapper, table containers) that would otherwise clip or mis-position a
 * `fixed` element nested inside them.
 */
export function Modal({
  title,
  onClose,
  children,
  width = "36rem",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: string;
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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 pb-10 pt-20 sm:pt-28">
      <div
        className="fixed inset-0"
        style={{ background: "rgba(10, 20, 30, 0.35)", backdropFilter: "blur(3px)" }}
        onClick={onClose}
        aria-hidden
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="panel relative w-full overflow-hidden"
        style={{ maxWidth: width, animation: "rise-in 0.18s var(--ease-premium)" }}
      >
        <div
          className="flex items-center justify-between border-b px-5 py-4"
          style={{ borderColor: "var(--border)" }}
        >
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          <button onClick={onClose} className="nav-icon-btn" aria-label="Close">
            <X className="h-[18px] w-[18px]" />
          </button>
        </div>

        <div className="max-h-[75vh] overflow-y-auto p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
