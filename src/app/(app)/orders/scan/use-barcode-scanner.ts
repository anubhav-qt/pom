"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Camera barcode reading, with the platform's own decoder preferred.
 *
 * Two decoders, in order:
 *
 * 1. `BarcodeDetector`, built into Chrome and Android WebView. It is hardware
 *    accelerated and costs nothing to ship, which matters on the phone someone
 *    is actually holding at a packing bench.
 * 2. ZXing, lazily imported only when the native one is missing (Safari, older
 *    Firefox). It is ~200 kB, so loading it up front would slow the modal down
 *    for the majority who never need it.
 *
 * Everything here degrades to nothing gracefully: if there is no camera, no
 * permission, or no decoder, the caller still has the keyboard input, which is
 * the primary path for a bench with a real USB scanner anyway.
 */

/** Formats worth looking for. Amazon labels are Code 128; ASINs are Code 39. */
const FORMATS = ["code_128", "code_39", "ean_13", "ean_8", "itf", "qr_code", "upc_a", "upc_e"];

export type CameraState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "running" }
  | { status: "unsupported"; reason: string }
  | { status: "denied"; reason: string }
  | { status: "error"; reason: string };

interface NativeDetector {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
}

declare global {
  interface Window {
    BarcodeDetector?: {
      new (opts?: { formats?: string[] }): NativeDetector;
      getSupportedFormats?: () => Promise<string[]>;
    };
  }
}

/** After a read, nothing else is read for this long: time to take the parcel away. */
const COOLDOWN_MS = 1500;
/**
 * A code that has been read can't be read again until it has been out of view
 * this long. Longer than one missed frame, since focus hunting drops a few and
 * ZXing only looks every 500 ms.
 */
const REARM_MS = 1500;

export function useBarcodeScanner(onDetect: (code: string) => void) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<CameraState>({ status: "idle" });
  /** True for the pause after a read, so the viewfinder can say so. */
  const [cooling, setCooling] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const zxingRef = useRef<{ stop: () => void } | null>(null);
  const coolTimerRef = useRef<number | null>(null);
  const stoppedRef = useRef(false);
  const onDetectRef = useRef(onDetect);
  onDetectRef.current = onDetect;

  /**
   * A parcel stays in frame for many video frames, and its label usually
   * carries more than one barcode, so reading every frame fires the same
   * parcel over and over. Instead, a read code is "held" (with anything seen
   * in the same frame, being the same label) until it leaves the view, and
   * after any read nothing else is read for COOLDOWN_MS.
   */
  const heldRef = useRef(new Map<string, number>()); // code -> last time it was in view
  const lastReadAtRef = useRef(0);

  const see = useCallback((values: string[]) => {
    const codes = values.map((v) => v.trim()).filter(Boolean);
    const now = Date.now();
    const held = heldRef.current;

    for (const [code, at] of held) if (now - at >= REARM_MS) held.delete(code);

    const sameLabel = codes.some((c) => held.has(c));
    if (sameLabel) {
      for (const c of codes) held.set(c, now);
      return;
    }
    // A new code seen during the pause is left alone, not held, so it is read
    // as soon as the pause ends if it is still in view.
    if (codes.length === 0 || now - lastReadAtRef.current < COOLDOWN_MS) return;

    for (const c of codes) held.set(c, now);
    lastReadAtRef.current = now;
    setCooling(true);
    if (coolTimerRef.current !== null) window.clearTimeout(coolTimerRef.current);
    coolTimerRef.current = window.setTimeout(() => setCooling(false), COOLDOWN_MS);
    onDetectRef.current(codes[0]);
  }, []);

  const stop = useCallback(() => {
    stoppedRef.current = true;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    zxingRef.current?.stop();
    zxingRef.current = null;
    if (coolTimerRef.current !== null) {
      window.clearTimeout(coolTimerRef.current);
      coolTimerRef.current = null;
    }
    heldRef.current.clear();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCooling(false);
    setState({ status: "idle" });
  }, []);

  const start = useCallback(async () => {
    if (typeof window === "undefined") return;

    if (!navigator.mediaDevices?.getUserMedia) {
      setState({
        status: "unsupported",
        reason: "This browser has no camera access. Type or scan the code into the box instead.",
      });
      return;
    }

    stoppedRef.current = false;
    setState({ status: "starting" });

    let stream: MediaStream;
    try {
      // The rear camera is the one pointed at the parcel.
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setState({
          status: "denied",
          reason: "Camera permission was refused. Allow it in the browser, or type the code below.",
        });
      } else if (name === "NotFoundError" || name === "OverconstrainedError") {
        setState({ status: "unsupported", reason: "No camera found on this device." });
      } else {
        setState({
          status: "error",
          reason: err instanceof Error ? err.message : "The camera could not be started.",
        });
      }
      return;
    }

    if (stoppedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }

    video.srcObject = stream;
    video.setAttribute("playsinline", "true"); // iOS would otherwise go fullscreen
    try {
      await video.play();
    } catch {
      /* autoplay can reject while the modal is still animating in; the loop
         below copes because it simply reads nothing until frames arrive. */
    }

    setState({ status: "running" });

    /* ------------------------------------------------------------ decoding */
    let detector: NativeDetector | null = null;
    if (window.BarcodeDetector) {
      try {
        const supported = (await window.BarcodeDetector.getSupportedFormats?.()) ?? FORMATS;
        detector = new window.BarcodeDetector({
          formats: FORMATS.filter((f) => supported.includes(f)),
        });
      } catch {
        detector = null;
      }
    }

    if (detector) {
      const tick = async () => {
        if (stoppedRef.current || !videoRef.current) return;
        try {
          const found = await detector!.detect(videoRef.current);
          see(found.map((f) => f.rawValue));
        } catch {
          /* A single failed frame is normal while focus hunts, so keep going. */
        }
        if (!stoppedRef.current) rafRef.current = requestAnimationFrame(() => void tick());
      };
      void tick();
      return;
    }

    // No native decoder, so fall back to ZXing, imported only now.
    try {
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      if (stoppedRef.current) return;
      const reader = new BrowserMultiFormatReader();
      // ZXing finds one code per look, and a look that finds nothing reports
      // an error rather than an empty result.
      const controls = await reader.decodeFromVideoElement(video, (result) => {
        see(result ? [result.getText()] : []);
      });
      // Its loop outlives the stream, so it is stopped with the camera.
      if (stoppedRef.current) controls.stop();
      else zxingRef.current = controls;
    } catch (err) {
      setState({
        status: "error",
        reason:
          err instanceof Error
            ? `Barcode decoding is unavailable: ${err.message}`
            : "Barcode decoding is unavailable on this browser.",
      });
    }
  }, [see]);

  // Never leave the camera light on because a modal unmounted.
  useEffect(() => stop, [stop]);

  return { videoRef, state, cooling, start, stop };
}
