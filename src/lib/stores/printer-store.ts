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
.s{width:34px;height:34px;border-radius:50%;border:3px solid #cdeaf5;border-top-color:#0ea5d9;animation:r .8s linear infinite}
@keyframes r{to{transform:rotate(360deg)}}
</style><div class="s"></div><div>Building your label sheet</div>`;
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
    const tab = window.open("", "_blank");
    try {
      tab?.document.write(LOADER_HTML);
      tab?.document.close();
    } catch {
      // A tab we cannot write to just stays blank until the sheet lands.
    }
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
