"use client";

import { Download, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { AssistantCard } from "@/lib/assistant/agent";
import { withBasePath } from "@/lib/base-path";
import { useAssistantUi } from "@/lib/stores/assistant-ui";

import { AssistantCardView } from "./cards";
import { wrapHtmlFragment } from "./render-html";

type DisplayMode = "cards" | "html";

interface Message {
  role: "user" | "assistant";
  content: string;
  cards?: AssistantCard[];
  error?: boolean;
}

const SUGGESTIONS = [
  "How much revenue this month?",
  "What's still late?",
  "What's my best seller?",
  "How many orders are cancelled?",
];

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
function downloadHtmlPage(html: string) {
  const blob = new Blob([wrapHtmlFragment(html)], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `assistant-answer-${Date.now()}.html`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function HtmlPageLink({ html }: { html: string }) {
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

export function ChatWidget() {
  const open = useAssistantUi((s) => s.open);
  const setOpen = useAssistantUi((s) => s.setOpen);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("cards");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem("assistant-display-mode");
    if (saved === "cards" || saved === "html") setDisplayMode(saved);
  }, []);

  function changeDisplayMode(mode: DisplayMode) {
    setDisplayMode(mode);
    localStorage.setItem("assistant-display-mode", mode);
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setInput("");
    setBusy(true);

    const history = messages.map(({ role, content }) => ({ role, content }));
    setMessages((m) => [...m, { role: "user", content: question }]);

    try {
      const res = await fetch(withBasePath("/api/assistant/chat"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, history, displayMode }),
      });

      // Read as text first: a request that failed before it ever reached our
      // route handler — a gateway timeout, a proxy/rewrite error page — comes
      // back as HTML or plain text, not JSON, and `res.json()` would just
      // throw a generic parse error indistinguishable from an offline browser.
      const raw = await res.text();
      let data: { reply?: string; cards?: AssistantCard[]; error?: string } | null = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch {
        /* not JSON — handled below */
      }

      if (!res.ok || !data) {
        const content =
          data?.error ??
          (res.status === 504
            ? "The assistant took too long to answer that — try a narrower question."
            : `The assistant returned an unexpected response (HTTP ${res.status}).`);
        setMessages((m) => [...m, { role: "assistant", content, error: true }]);
      } else {
        setMessages((m) => [...m, { role: "assistant", content: data!.reply ?? "", cards: data!.cards }]);
      }
    } catch (err) {
      // The fetch itself never resolved — a genuine network/connectivity
      // failure, as opposed to a bad response from the server.
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: `Couldn't reach the assistant${err instanceof Error && err.message ? ` — ${err.message}` : " — check your connection."}`,
          error: true,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* The trigger — a plain sticky icon until clicked, exactly as asked:
          it does not look like a chat entry point until it opens into one.
          Hidden on mobile: the bottom nav's "AI" tab opens the same panel,
          and a floating circle there would just sit on top of that bar. */}
      <button
        onClick={() => setOpen(!open)}
        aria-label={open ? "Close assistant" : "Ask the assistant"}
        className="no-print fixed bottom-5 right-5 z-40 hidden h-14 w-14 items-center justify-center rounded-full text-white transition-transform hover:scale-105 active:scale-95 sm:flex"
        style={{
          background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
          boxShadow: "0 10px 30px -8px color-mix(in srgb, var(--accent) 60%, transparent)",
        }}
      >
        {open ? <X className="h-6 w-6" /> : <Sparkles className="h-6 w-6" />}
      </button>

      {open ? (
        <div
          className="panel no-print fixed inset-x-3 bottom-[calc(3.25rem+env(safe-area-inset-bottom))] z-40 flex flex-col overflow-hidden sm:inset-x-auto sm:bottom-24 sm:right-5 sm:w-[min(24rem,calc(100vw-2.5rem))]"
          style={{ height: "min(32rem, calc(100vh - 10rem))", animation: "rise-in 0.18s var(--ease-premium)" }}
        >
          <div
            className="flex items-center gap-2 border-b px-4 py-3"
            style={{ borderColor: "var(--border)" }}
          >
            <Sparkles className="h-4 w-4" style={{ color: "var(--accent)" }} />
            <div className="flex-1">
              <div className="text-sm font-semibold leading-tight">Ask about your data</div>
              <div className="muted text-[11px]">Answers come straight from your orders</div>
            </div>
            <div
              className="flex rounded-lg border p-0.5 text-[11px]"
              style={{ borderColor: "var(--border)" }}
              role="radiogroup"
              aria-label="Answer display mode"
            >
              {(["cards", "html"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={displayMode === mode}
                  onClick={() => changeDisplayMode(mode)}
                  className="rounded-md px-2 py-1 transition-colors"
                  style={{
                    background: displayMode === mode ? "var(--accent-soft)" : "transparent",
                    color: displayMode === mode ? "var(--accent)" : "var(--muted)",
                  }}
                >
                  {mode === "cards" ? "Cards" : "Page"}
                </button>
              ))}
            </div>
            {/* The floating trigger doubles as a close button on desktop, but
                it's hidden on mobile (superseded by the bottom nav's "AI"
                tab) — without this the panel would have no way to close. */}
            <button
              onClick={() => setOpen(false)}
              aria-label="Close assistant"
              className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg sm:hidden"
              style={{ color: "var(--muted)" }}
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {messages.length === 0 ? (
              <div className="space-y-2">
                <p className="muted text-sm">Try asking:</p>
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => ask(s)}
                    className="block w-full rounded-xl border px-3 py-2 text-left text-sm transition-colors hover:bg-[var(--accent-soft)]"
                    style={{ borderColor: "var(--border)" }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            ) : null}

            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
                {m.role === "user" ? (
                  <div
                    className="max-w-[85%] rounded-2xl rounded-br-sm px-3.5 py-2 text-sm text-white"
                    style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
                  >
                    {m.content}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div
                      className="max-w-[92%] rounded-2xl rounded-bl-sm px-3.5 py-2 text-sm"
                      style={{
                        background: m.error ? "var(--danger-soft)" : "var(--panel-2)",
                        color: m.error ? "var(--danger)" : "var(--text)",
                      }}
                    >
                      {m.content}
                    </div>
                    {(() => {
                      const htmlCard = m.cards?.find((c) => c.type === "html") as { html: string } | undefined;
                      if (!m.error && displayMode === "html" && htmlCard) {
                        return <HtmlPageLink html={htmlCard.html} />;
                      }
                      return m.cards?.filter((c) => c.type !== "html").map((c, ci) => <AssistantCardView key={ci} card={c} />);
                    })()}
                  </div>
                )}
              </div>
            ))}

            {busy ? (
              <div className="flex items-center gap-1.5 px-1">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-1.5 w-1.5 rounded-full"
                    style={{
                      background: "var(--muted-2)",
                      animation: `typing-bounce 1.1s ease-in-out ${i * 0.15}s infinite`,
                    }}
                  />
                ))}
              </div>
            ) : null}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              ask(input);
            }}
            className="flex items-center gap-2 border-t p-3"
            style={{ borderColor: "var(--border)" }}
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask a question…"
              disabled={busy}
              className="input"
            />
            <button type="submit" disabled={busy || !input.trim()} className="btn btn-primary px-3.5">
              Ask
            </button>
          </form>
        </div>
      ) : null}
    </>
  );
}
