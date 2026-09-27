"use client";

import { useEffect } from "react";

import { usePrinterStore } from "@/lib/stores/printer-store";

import { PrinterView } from "./printer-view";

/**
 * The live PDF printer. Its state lives in `usePrinterStore`, so leaving the
 * screen and coming back finds the files and the last result where they were,
 * and a reload brings them back from what the browser kept (see `resume`).
 * All markup is `PrinterView`.
 */
export function PdfPrinter() {
  const s = usePrinterStore();
  useEffect(() => void usePrinterStore.getState().resume(), []);

  return (
    <PrinterView
      files={s.items.map((i) => i.item)}
      phase={s.phase}
      options={s.options}
      result={s.result}
      error={s.error}
      popupBlocked={s.popupBlocked}
      onAddFiles={s.add}
      onRemove={s.remove}
      onClear={s.reset}
      onOptions={s.setOptions}
      onBuild={s.build}
      onReset={s.reset}
    />
  );
}
