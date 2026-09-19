"use client";

import { useEffect, useState } from "react";

import { PrinterView, type PrinterOptions } from "../printer-view";

import { demoProps, type DemoState } from "./fixtures";

/**
 * The printer screen in a fixed demo state. The stage above changes the state
 * by postMessage rather than reloading the frame, so switching states plays
 * the same open/close animations as the real screen, and the toggles work.
 */
export function DemoFrameClient({ initial }: { initial: DemoState }) {
  const [state, setState] = useState<DemoState>(initial);
  const [options, setOptions] = useState<PrinterOptions>({ stamp: true, cutGuides: false });

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return;
      if (e.data && typeof e.data.demoState === "string") setState(e.data.demoState as DemoState);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return <PrinterView {...demoProps(state)} options={options} onOptions={setOptions} />;
}
