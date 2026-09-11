/**
 * ARCHIVED — the "Page" half of the chat widget's old Cards/Page toggle.
 * The widget is cards-only now; this is kept, unwired, in case custom-page
 * display mode comes back. Pairs with lib/assistant/archive/html-mode.ts
 * (server side) and archive/render-html.ts (the page-shell wrapper).
 */
"use client";

import { Download } from "lucide-react";

import { wrapHtmlFragment } from "./render-html";

/**
 * Downloads the model's HTML fragment as a standalone .html file, instead of
 * trying to open it in a new tab — new-tab approaches (blob: navigation,
 * document.write into window.open) turned out unreliable across browsers
 * (blocked popups, blob: URLs failing to resolve once handed to a new
 * renderer process). A download via a temporary <a download> anchor doesn't
 * hit either failure mode — it never has to resolve as a navigable page.
 * The fragment is already sanitized server-side (sanitize-html.ts strips
 * scripts/handlers before it's ever returned).
 */
export function downloadHtmlPage(html: string) {
  const blob = new Blob([wrapHtmlFragment(html)], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `assistant-answer-${Date.now()}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function HtmlPageLink({ html }: { html: string }) {
  return (
    <button
      type="button"
      onClick={() => downloadHtmlPage(html)}
      className="flex w-fit items-center gap-1.5 rounded-xl border px-3 py-2 text-sm transition-colors hover:bg-[var(--accent-soft)]"
      style={{ borderColor: "var(--border)" }}
    >
      <Download className="h-3.5 w-3.5" style={{ color: "var(--accent)" }} />
      Download page
    </button>
  );
}
