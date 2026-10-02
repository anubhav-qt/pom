"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { photoSrc } from "@/lib/photo-src";
import { cn } from "@/lib/utils";

/**
 * Just the image, enlarged, on a scrim. For when someone taps a thumbnail and
 * wants a closer look at the product photo — not the order it belongs to,
 * which is what tapping anywhere else on the same card opens instead.
 *
 * Clicks stop here: the lightbox is portaled, but React still bubbles its
 * events up the component tree, so without that a tap on the scrim would
 * reach the card behind it and open the order. Escape is caught first for the
 * same reason, so it closes the photo and not the modal the photo sits in.
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
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  function close(e: React.SyntheticEvent) {
    e.stopPropagation();
    onClose();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-6"
      style={{ background: "rgba(8, 20, 28, 0.85)", animation: "rise-in 0.28s var(--ease-apple)" }}
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
    >
      <button
        type="button"
        onClick={close}
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full text-white"
        style={{ background: "rgba(255,255,255,0.12)" }}
        aria-label="Close"
      >
        <X className="h-5 w-5" />
      </button>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photoSrc(src)}
        alt={alt}
        className="max-h-full max-w-full rounded-xl object-contain"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
  );
}

/**
 * A photo that opens full screen when tapped, the one way every product photo
 * in the app behaves. The tap is kept to the photo, so a card or row around
 * it still opens its own thing everywhere else.
 */
export function ZoomImg({
  src,
  fullSrc,
  alt,
  className,
  style,
}: {
  src: string;
  /** A larger copy for full screen, when `src` is a small one. */
  fullSrc?: string;
  alt: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);

  function show(e: React.SyntheticEvent) {
    e.stopPropagation();
    e.preventDefault();
    setOpen(true);
  }

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photoSrc(src)}
        alt={alt}
        className={cn(className, "cursor-zoom-in")}
        style={style}
        role="button"
        tabIndex={0}
        aria-label={alt ? `Enlarge ${alt}` : "Enlarge photo"}
        onClick={show}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") show(e);
        }}
      />
      {open ? <ImageLightbox src={fullSrc ?? src} alt={alt} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
