"use client";

import { create } from "zustand";

import type {
  FileItem,
  Phase,
  PrinterOptions,
  RunFileReport,
  RunResult,
} from "@/app/(app)/pdf-printer/printer-view";
import { withBasePath } from "@/lib/base-path";

const MAX_FILES = 20;
/** What the new tab shows until the sheet is ready, so a blank tab never looks broken. */
const LOADER_HTML = `<!doctype html><title>POM</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;
background:linear-gradient(180deg,#eef7fb,#f8fbfd);font:500 14px system-ui,sans-serif;color:#3a2a30}
.s{--z:2.8rem;position:relative;width:var(--z);height:var(--z)}
.s i{position:absolute;inset:0;display:flex;align-items:center}
.s i:before{content:"";width:20%;height:20%;border-radius:50%;background:#0ea5e9;transform:scale(0);opacity:.5;animation:p 1s ease-in-out infinite;box-shadow:0 0 20px rgba(14,165,233,.3)}
.s i:nth-child(2){transform:rotate(45deg)}.s i:nth-child(2):before{animation-delay:-0.875s}
.s i:nth-child(3){transform:rotate(90deg)}.s i:nth-child(3):before{animation-delay:-0.75s}
.s i:nth-child(4){transform:rotate(135deg)}.s i:nth-child(4):before{animation-delay:-0.625s}
.s i:nth-child(5){transform:rotate(180deg)}.s i:nth-child(5):before{animation-delay:-0.5s}
.s i:nth-child(6){transform:rotate(225deg)}.s i:nth-child(6):before{animation-delay:-0.375s}
.s i:nth-child(7){transform:rotate(270deg)}.s i:nth-child(7):before{animation-delay:-0.25s}
.s i:nth-child(8){transform:rotate(315deg)}.s i:nth-child(8):before{animation-delay:-0.125s}
@keyframes p{0%,100%{transform:scale(0);opacity:.5}50%{transform:scale(1);opacity:1}}
</style><div class="s"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><div>Building your label sheet</div>`;
const isPdf = (f: File) => f.type === "application/pdf" || /\.pdf$/i.test(f.name);

interface PrinterState {
  items: { item: FileItem; file: File }[];
  phase: Phase;
  options: PrinterOptions;
  result: RunResult | null;
  error: { message: string; files?: RunFileReport[] } | null;
  popupBlocked: boolean;

  add: (files: File[]) => void;
  remove: (id: string) => void;
  reset: () => void;
  setOptions: (o: PrinterOptions) => void;
  build: () => Promise<void>;
}

let seq = 0;

/**
 * The PDF printer's working state, kept outside the component for the same
 * reason the Orders and Dashboard caches are: switching to another screen and
 * back must not throw away what was picked or the last result, and a build in
 * flight keeps running (and lands here) even if the screen is not on show.
 */
export const usePrinterStore = create<PrinterState>((set, get) => ({
  items: [],
  phase: "idle",
  options: { stamp: true, cutGuides: false },
  result: null,
  error: null,
  popupBlocked: false,

  add: (list) => {
    const pdfs = list.filter(isPdf);
    const rejected = list.length - pdfs.length;
    const seen = new Set(get().items.map((c) => `${c.item.name}:${c.item.size}`));
    const next = [...get().items];
    for (const file of pdfs) {
      const key = `${file.name}:${file.size}`;
      if (seen.has(key)) continue;
      seen.add(key);
      next.push({ item: { id: String(++seq), name: file.name, size: file.size }, file });
    }
    // A new pick starts a new batch: the previous report no longer describes it.
    set({
      items: next,
      result: null,
      phase: rejected > 0 ? "error" : "idle",
      error:
        rejected > 0
          ? { message: `${rejected} file${rejected === 1 ? " was" : "s were"} skipped because ${rejected === 1 ? "it is" : "they are"} not a PDF.` }
          : null,
    });
  },

  remove: (id) => set((s) => ({ items: s.items.filter((c) => c.item.id !== id) })),

  reset: () => set({ items: [], result: null, error: null, phase: "idle", popupBlocked: false }),

  setOptions: (options) => set({ options }),

  build: async () => {
    const { items, options } = get();
    if (items.length === 0 || items.length > MAX_FILES) return;

    // Opened now, inside the click, so the browser treats it as user-initiated;
    // it is pointed at the sheet once that exists. If blocked, the result card
    // still has an "Open sheet" link.
    // The loader is opened as a real page (a blob), not document.write()n into
    // an about:blank tab: phone browsers ignore the viewport tag on a written
    // document and draw it at desktop width, which is what shrank the spinner
    // into a corner.
    let loaderUrl: string | null = null;
    try {
      loaderUrl = URL.createObjectURL(new Blob([LOADER_HTML], { type: "text/html" }));
    } catch {
      // No blob support: the tab just stays blank until the sheet lands.
    }
    const tab = window.open(loaderUrl ?? "", "_blank");
    if (loaderUrl) setTimeout(() => URL.revokeObjectURL(loaderUrl!), 60_000);
    set({ phase: "processing", result: null, error: null, popupBlocked: false });

    const body = new FormData();
    for (const { file } of items) body.append("files", file);
    if (!options.stamp) body.set("stamp", "0");
    if (options.cutGuides) body.set("cutGuides", "1");

    try {
      const res = await fetch(withBasePath("/api/label-print"), { method: "POST", body });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json) {
        tab?.close();
        set({ error: { message: json?.error ?? "Could not build the label sheet.", files: json?.files }, phase: "error" });
        return;
      }
      set({ result: json as RunResult, phase: "done", popupBlocked: !tab });
      if (tab) tab.location.href = json.url;
    } catch {
      tab?.close();
      set({ error: { message: "Could not reach the server. Check your connection and try again." }, phase: "error" });
    }
  },
}));
