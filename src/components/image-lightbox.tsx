"use client";

import { X } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";

/**
 * Just the image, enlarged, on a scrim. For when someone taps a thumbnail and
 * wants a closer look at the product photo — not the order it belongs to,
 * which is what tapping anywhere else on the same card opens instead.
 */
export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      style={{ background: "rgba(8, 20, 28, 0.85)", animation: "rise-in 0.15s var(--ease-premium)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full text-white"
        style={{ background: "rgba(255,255,255,0.12)" }}
        aria-label="Close"
      >
        <X className="h-5 w-5" />
      </button>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        className="max-h-full max-w-full rounded-xl object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  );
}
