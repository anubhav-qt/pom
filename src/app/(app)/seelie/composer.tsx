"use client";

import { AlertTriangle, ArrowUp, AtSign, Brain, Check, ChevronDown, Clock3, FileText, Music, Package, Paperclip, Plus, Square, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { DropdownMenu, type DropdownOption } from "@/components/dropdown-menu";
import { contextTokens, formatTokens } from "@/lib/seelie/context";
import { ACTIVE_RUN, type Mention } from "@/lib/seelie/types";
import { isPdf, MAX_DRAFT_CLIPS, MAX_DRAFT_IMAGES, useSeelie, type DraftClip, type DraftImage } from "@/lib/stores/seelie-store";
import { cn } from "@/lib/utils";

import { mentionAction } from "./actions";
import { useWide } from "./job";

/**
 * Where a message is written: the text (up to four lines, then it scrolls), the photos,
 * clips and sounds going with it, the model and how hard it thinks. On a phone a capsule
 * (the rest behind +), from `sm` up a dock with everything in view. Both stay in one place
 * at the foot of the screen (seelie.tsx pins them). While Seelie works, a message goes into
 * its reply; @ picks a product or an order.
 */

const MAX_SIDE = 1600;
/** The box grows this many lines, then scrolls. */
const MAX_LINES = 4;

const THINKING_LABEL: Record<string, string> = {
  off: "No thinking",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** A photo scaled to fit 1600px and re-encoded as JPEG, ready to send. */
async function toDraftImage(file: File): Promise<DraftImage | null> {
  if (!file.type.startsWith("image/")) return null;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // JPEG has no transparency; a PNG's clear parts become white, not black.
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
  if (!blob) return null;
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return { data, mimeType: "image/jpeg", preview: URL.createObjectURL(blob) };
}

const coarse = () => window.matchMedia("(pointer: coarse)").matches;

/** The @word being typed at the caret, if any: where it starts and what's typed after the @. */
function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  if (caret < 0) return null;
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /\n/.test(query) || (query.match(/\s/g) ?? []).length > 2 || query.startsWith("[")) return null;
  return { start: at, query };
}

export function Composer({ disabled, onOpenSettings }: { disabled?: string | null; onOpenSettings: () => void }) {
  const wide = useWide();
  const draft = useSeelie((s) => s.draft);
  const images = useSeelie((s) => s.draftImages);
  const clips = useSeelie((s) => s.draftClips);
  const run = useSeelie((s) => s.run);
  const chatId = useSeelie((s) => s.chatId);
  const catalog = useSeelie((s) => s.status?.catalog ?? null);
  const modelId = useSeelie((s) => s.model);
  const thinking = useSeelie((s) => s.thinking);
  const limits = useSeelie((s) => s.limits);
  const messages = useSeelie((s) => s.messages);
  const queued = useSeelie((s) => s.queued);
  const { setDraft, addImages, removeImage, addClips, removeClip, send, stop, setModel, setThinking } = useSeelie.getState();

  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Being written in on a phone, so the keyboard is up.
  const [typing, setTyping] = useState(false);
  const [tall, setTall] = useState(false);
  const [caret, setCaret] = useState(0);
  const [menu, setMenu] = useState(false);

  // The bottom nav hides while the keyboard is up (`html[data-typing]` in globals.css).
  useEffect(() => {
    if (!typing) return;
    const root = document.documentElement;
    root.setAttribute("data-typing", "");
    return () => root.removeAttribute("data-typing");
  }, [typing]);

  const running = !!run && ACTIVE_RUN.includes(run.status);
  const model = catalog?.models.find((m) => m.id === modelId) ?? null;
  const seesImages = model?.images ?? true;
  const clipsReady = clips.every((c) => c.assetId !== null);
  const hasDraft = draft.trim().length > 0 || images.length > 0 || clips.length > 0;
  const canSend = !disabled && reading === 0 && clipsReady && hasDraft && (seesImages || images.length === 0);
  const full = images.length >= MAX_DRAFT_IMAGES && clips.length >= MAX_DRAFT_CLIPS;

  // Grows with the text up to four lines, then scrolls.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
    const max = line * MAX_LINES + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
    el.style.overflowY = el.scrollHeight > max + 1 ? "auto" : "hidden";
    setTall(el.scrollHeight > line * 1.6 + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom));
  }, [draft, wide]);

  // A fresh chat, or a switch to another, puts the cursor in the box (not on phones,
  // where it would pop the keyboard over the chat).
  useEffect(() => {
    if (!coarse()) textRef.current?.focus();
  }, [chatId]);

  async function take(files: File[]) {
    addClips(files.filter((f) => f.type.startsWith("video/") || f.type.startsWith("audio/") || isPdf(f)));
    const room = MAX_DRAFT_IMAGES - useSeelie.getState().draftImages.length;
    const picked = files.filter((f) => f.type.startsWith("image/")).slice(0, Math.max(0, room));
    if (!picked.length) return;
    setReading((n) => n + picked.length);
    try {
      const done = await Promise.all(picked.map((f) => toDraftImage(f).catch(() => null)));
      addImages(done.filter((d): d is DraftImage => d !== null));
    } finally {
      setReading((n) => n - picked.length);
    }
  }

  function submit() {
    if (!canSend) return;
    void send();
    // On a phone the keyboard goes down, so the reply has the screen.
    if (coarse()) textRef.current?.blur();
  }

  // @: the word being typed at the caret.
  const at = mentionAt(draft, caret);
  const picker = useMentions(at?.query ?? null);
  const [pick, setPick] = useState(0);
  useEffect(() => setPick(0), [at?.query]);

  function choose(m: Mention) {
    if (!at) return;
    const insert = `@${m.label} `;
    const next = draft.slice(0, at.start) + insert + draft.slice(caret);
    useSeelie.getState().addMention(m);
    setDraft(next);
    const pos = at.start + insert.length;
    requestAnimationFrame(() => {
      const el = textRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  }

  const usage = usageFor(limits, model?.provider ?? null);
  const context = model ? contextFor(messages, model.contextWindow, model.name) : null;
  const placeholder = disabled ?? (running ? "Tell Seelie something while it works…" : chatId ? "Reply to Seelie…" : "Ask Seelie anything…");

  const textarea = (
    <textarea
      ref={textRef}
      value={draft}
      rows={1}
      disabled={!!disabled}
      onChange={(e) => {
        setDraft(e.target.value);
        setCaret(e.target.selectionStart ?? e.target.value.length);
      }}
      onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
      onFocus={() => setTyping(coarse())}
      onBlur={() => setTyping(false)}
      onKeyDown={(e) => {
        if (at && picker.items.length) {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setPick((p) => (p + (e.key === "ArrowDown" ? 1 : picker.items.length - 1)) % picker.items.length);
            return;
          }
          if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            choose(picker.items[pick] ?? picker.items[0]);
            return;
          }
          if (e.key === "Escape") {
            setCaret(-1);
            return;
          }
        }
        if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
        // On a phone Enter is a new line; the arrow button sends.
        if (coarse()) return;
        e.preventDefault();
        submit();
      }}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData.files).filter((f) => /^(image|video|audio)\//.test(f.type) || isPdf(f));
        if (!files.length) return;
        if (!e.clipboardData.getData("text/plain")) e.preventDefault();
        void take(files);
      }}
      placeholder={placeholder}
      className={cn("sl-field", wide ? "px-4 pb-1.5 pt-3.5" : "py-2 pl-1 pr-1")}
    />
  );

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept={seesImages ? "image/*,video/*,audio/*,application/pdf,.pdf" : "video/*,audio/*,application/pdf,.pdf"}
      multiple
      hidden
      onChange={(e) => {
        void take(Array.from(e.target.files ?? []));
        e.target.value = "";
      }}
    />
  );

  const attachments =
    clips.length || images.length || reading ? (
      <div className={cn("flex gap-2 overflow-x-auto", wide ? "px-3 pt-3" : "px-2 pb-1.5 pt-1.5")}>
        {clips.map((clip) => (
          <ClipChip key={clip.key} clip={clip} onRemove={() => removeClip(clip.key)} />
        ))}
        {images.map((img, i) => (
          <div key={img.preview} className="group relative shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={img.preview} alt={`Photo ${i + 1}`} className="h-14 w-14 rounded-xl object-cover sm:h-16 sm:w-16" style={{ border: "1px solid var(--border)" }} />
            <span className="absolute bottom-1 left-1 rounded-md px-1 text-[10px] font-semibold tabular-nums text-white" style={{ background: "rgba(10,20,30,0.55)" }}>
              {i + 1}
            </span>
            <button
              type="button"
              onClick={() => removeImage(i)}
              aria-label={`Remove photo ${i + 1}`}
              className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-white"
              style={{ background: "var(--text)", boxShadow: "var(--shadow-xs)" }}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        {Array.from({ length: reading }, (_, i) => (
          <div key={`r${i}`} className="h-14 w-14 shrink-0 animate-pulse rounded-xl sm:h-16 sm:w-16" style={{ background: "var(--panel-2)", border: "1px solid var(--border)" }} />
        ))}
      </div>
    ) : null;

  // While Seelie works: Send passes the message on, Stop (with an empty box) stops it.
  const action =
    running && !hasDraft ? (
      <button type="button" onClick={() => void stop()} aria-label="Stop" title="Stop" className="sl-send stop">
        <Square className="h-3.5 w-3.5" fill="currentColor" />
      </button>
    ) : (
      <button type="button" onClick={submit} disabled={!canSend} aria-label={running ? "Send while it works" : "Send"} title={running ? "Seelie reads it before its next step" : "Send"} className="sl-send">
        <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.5} />
      </button>
    );

  const dragProps = {
    onDragOver: (e: React.DragEvent) => {
      if (disabled || !e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: React.DragEvent) => {
      setDragging(false);
      if (disabled) return;
      e.preventDefault();
      void take(Array.from(e.dataTransfer.files));
    },
  };

  return (
    <div className="relative">
      {queued.length ? <Queued /> : null}
      {at && (picker.items.length || picker.loading) ? <MentionList items={picker.items} loading={picker.loading} pick={pick} onPick={choose} /> : null}
      {fileInput}
      {wide ? (
        <div className={cn("sl-box2", dragging && "dragging", disabled && "opacity-60")} {...dragProps}>
          {attachments}
          {textarea}
          {/* A tap on these leaves the cursor in the box, so nothing moves under the pointer before it lands. */}
          <div className="flex items-center gap-1 px-2 pb-2 pt-0.5" onMouseDown={(e) => e.preventDefault()}>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={!!disabled || full}
              className="nav-icon-btn h-8 w-8 disabled:opacity-40"
              style={{ color: "var(--muted)" }}
              aria-label="Add photos, clips, sounds or PDFs"
              title={`${seesImages ? `Photos (up to ${MAX_DRAFT_IMAGES}), clips` : "Clips"}, sounds and PDFs (up to ${MAX_DRAFT_CLIPS}, 300 MB each)`}
            >
              <Paperclip className="h-[18px] w-[18px]" />
            </button>
            <button type="button" onClick={() => insertAt(textRef.current, draft, setDraft, setCaret)} className="nav-icon-btn h-8 w-8" style={{ color: "var(--muted)" }} aria-label="Pick a product or an order" title="@ a product or an order">
              <AtSign className="h-[17px] w-[17px]" />
            </button>
            <ModelPicker value={modelId} onChange={setModel} side="up" />
            <ThinkingPicker model={modelId} value={thinking} onChange={setThinking} side="up" />
            <div className="flex-1" />
            {context ? <ContextMeter context={context} /> : null}
            {usage ? (
              <button
                type="button"
                onClick={onOpenSettings}
                className="mr-1 flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[11px] tabular-nums hover:bg-[var(--tint-hover)]"
                style={{ color: usage.used > 0.85 ? "var(--danger)" : "var(--muted-2)" }}
                title={usage.title}
              >
                <span className="relative h-1.5 w-10 overflow-hidden rounded-full" style={{ background: "var(--panel-2)" }}>
                  <span
                    className="absolute inset-y-0 left-0 rounded-full"
                    style={{ width: `${Math.round(usage.used * 100)}%`, background: usage.used > 0.85 ? "var(--danger)" : usage.used > 0.6 ? "var(--warn)" : "var(--accent)" }}
                  />
                </span>
                {Math.round(usage.used * 100)}%
              </button>
            ) : null}
            {running && hasDraft ? (
              <button type="button" onClick={() => void stop()} aria-label="Stop" title="Stop" className="sl-send stop mr-1 h-8 w-8">
                <Square className="h-3 w-3" fill="currentColor" />
              </button>
            ) : null}
            {action}
          </div>
        </div>
      ) : (
        <div className={cn("sl-box1", (tall || attachments) && "tall", dragging && "dragging", disabled && "opacity-60")} {...dragProps}>
          {attachments}
          <div className="flex items-end gap-1.5">
            <div className="relative shrink-0" onMouseDown={(e) => e.preventDefault()}>
              <button type="button" className="sl-plus" aria-label="Attach, model and thinking" aria-expanded={menu} onClick={() => setMenu((m) => !m)} disabled={!!disabled}>
                <Plus className={cn("h-[18px] w-[18px] transition-transform", menu && "rotate-45")} />
              </button>
              {menu ? (
                <PlusMenu
                  onClose={() => setMenu(false)}
                  onAttach={() => {
                    setMenu(false);
                    fileRef.current?.click();
                  }}
                  onMention={() => {
                    setMenu(false);
                    insertAt(textRef.current, draft, setDraft, setCaret);
                  }}
                  full={full}
                  context={context}
                />
              ) : null}
            </div>
            {textarea}
            {action}
          </div>
        </div>
      )}
      {!seesImages && images.length ? (
        <p className="mt-1.5 px-2 text-xs" style={{ color: "var(--warn)" }}>
          {model?.name} can&apos;t see photos. Pick another model or remove them.
        </p>
      ) : null}
    </div>
  );
}

/** Put an @ at the caret (with a space before it when needed), which opens the picker. */
function insertAt(el: HTMLTextAreaElement | null, draft: string, setDraft: (s: string) => void, setCaret: (n: number) => void) {
  const pos = el?.selectionStart ?? draft.length;
  const pad = pos > 0 && !/\s/.test(draft[pos - 1]) ? " @" : "@";
  setDraft(draft.slice(0, pos) + pad + draft.slice(pos));
  const next = pos + pad.length;
  requestAnimationFrame(() => {
    el?.focus();
    el?.setSelectionRange(next, next);
    setCaret(next);
  });
}

/* -------------------------------------------------------------------------- */
/* @: products and orders                                                     */
/* -------------------------------------------------------------------------- */

function useMentions(query: string | null) {
  const [items, setItems] = useState<Mention[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (query === null) {
      setItems([]);
      return;
    }
    let live = true;
    setLoading(true);
    const t = setTimeout(() => {
      void mentionAction(query)
        .then((res) => live && setItems(res.ok ? res.data : []))
        .finally(() => live && setLoading(false));
    }, 160);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query]);
  return { items, loading };
}

function MentionList({ items, loading, pick, onPick }: { items: Mention[]; loading: boolean; pick: number; onPick: (m: Mention) => void }) {
  return (
    <div className="sl-pop bottom-full left-0 right-0 mb-2" role="listbox" onMouseDown={(e) => e.preventDefault()}>
      {items.length ? (
        items.map((m, i) => (
          <button key={m.token} type="button" role="option" aria-selected={i === pick} className={cn("sl-pop-item", i === pick && "on")} onClick={() => onPick(m)}>
            {m.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={m.image} alt="" className="h-8 w-8 shrink-0 rounded-md object-cover" style={{ border: "1px solid var(--border)" }} />
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ background: "var(--panel-2)", color: "var(--muted)" }}>
                {m.kind === "product" ? <Package className="h-4 w-4" /> : <AtSign className="h-4 w-4" />}
              </span>
            )}
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-[13px] font-medium">{m.label}</span>
              <span className="muted block truncate text-[11.5px]">{m.sub}</span>
            </span>
            <span className="sl-kt">{m.kind === "product" ? "Product" : "Order"}</span>
          </button>
        ))
      ) : (
        <p className="muted px-3 py-2 text-xs">{loading ? "Looking…" : "No product or order matches."}</p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Kept for after the reply                                                   */
/* -------------------------------------------------------------------------- */

/** Messages that go when Seelie finishes; a tap puts one back in the box. */
function Queued() {
  const queued = useSeelie((s) => s.queued);
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {queued.map((q, i) => (
        <span key={i} className="sl-queued">
          <Clock3 className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate">{q.text || `${q.images.length + q.clips.length} file${q.images.length + q.clips.length === 1 ? "" : "s"}`}</span>
          <span className="shrink-0 opacity-70">sends when Seelie finishes</span>
          <button type="button" onClick={() => useSeelie.getState().unqueue(i)} aria-label="Back to the box" className="shrink-0 opacity-70 hover:opacity-100">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The capsule's + menu                                                       */
/* -------------------------------------------------------------------------- */

function PlusMenu({ onClose, onAttach, onMention, full, context }: { onClose: () => void; onAttach: () => void; onMention: () => void; full: boolean; context: ReturnType<typeof contextFor> }) {
  const catalog = useSeelie((s) => s.status?.catalog ?? null);
  const modelId = useSeelie((s) => s.model);
  const thinking = useSeelie((s) => s.thinking);
  const showThinking = useSeelie((s) => s.showThinking);
  const { setModel, setThinking, setShowThinking } = useSeelie.getState();
  const model = catalog?.models.find((m) => m.id === modelId) ?? null;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [onClose]);
  return (
    <div ref={ref} className="sl-pop bottom-full left-0 mb-3 w-[min(19rem,calc(100vw-2rem))]">
      <button type="button" className="sl-pop-item" onClick={onAttach} disabled={full}>
        <Paperclip className="h-4 w-4" style={{ color: "var(--muted)" }} />
        <span className="text-[13.5px]">Photos, clips, sounds or PDFs</span>
      </button>
      <button type="button" className="sl-pop-item" onClick={onMention}>
        <AtSign className="h-4 w-4" style={{ color: "var(--muted)" }} />
        <span className="text-[13.5px]">A product or an order</span>
      </button>
      <p className="sl-pop-h">Model</p>
      <div className="max-h-48 overflow-y-auto">
        {catalog?.models.map((m) => (
          <button key={m.id} type="button" className={cn("sl-pop-item", m.id === modelId && "on")} onClick={() => setModel(m.id)}>
            <span className="min-w-0 flex-1 truncate text-left text-[13px]">{m.name}</span>
            {m.id === modelId ? <Check className="h-3.5 w-3.5" style={{ color: "var(--accent)" }} /> : null}
          </button>
        ))}
      </div>
      {(model?.thinkingLevels.length ?? 0) > 1 ? (
        <>
          <p className="sl-pop-h">Thinking</p>
          <div className="flex flex-wrap gap-1 px-2 pb-1.5">
            {model!.thinkingLevels.map((l) => (
              <button key={l} type="button" className={cn("sl-seg-chip", l === thinking && "on")} onClick={() => setThinking(l)}>
                {THINKING_LABEL[l] ?? l}
              </button>
            ))}
          </div>
        </>
      ) : null}
      <button type="button" className="sl-pop-item" onClick={() => setShowThinking(!showThinking)}>
        <Brain className="h-4 w-4" style={{ color: "var(--muted)" }} />
        <span className="flex-1 text-left text-[13.5px]">Show its thinking</span>
        <span className={cn("sl-check", showThinking && "on")}>{showThinking ? <Check className="h-2.5 w-2.5" /> : null}</span>
      </button>
      {context ? <p className="muted px-3 pb-2 pt-1 text-[11px] tabular-nums">{context.title.split(".")[0]}.</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

/** A clip, sound or PDF on its way: a still or an icon, the upload's progress, and a remove button. */
function ClipChip({ clip, onRemove }: { clip: DraftClip; onRemove: () => void }) {
  const uploading = clip.assetId === null && !clip.error;
  return (
    <div
      className="relative flex h-14 w-44 shrink-0 items-center gap-2 overflow-hidden rounded-xl pr-6 sm:h-16"
      style={{ border: `1px solid ${clip.error ? "var(--danger)" : "var(--border)"}`, background: "var(--panel-2)" }}
      title={clip.error ? `${clip.name}: ${clip.error}` : clip.name}
    >
      {clip.kind === "video" ? (
        <video src={clip.preview} muted playsInline preload="metadata" className="h-full w-12 shrink-0 bg-black object-cover" />
      ) : (
        <span className="flex h-full w-12 shrink-0 items-center justify-center" style={{ color: "var(--muted)" }}>
          {clip.kind === "pdf" ? <FileText className="h-5 w-5" /> : <Music className="h-5 w-5" />}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{clip.name}</p>
        <p className="mt-0.5 flex items-center gap-1 text-[11px] tabular-nums" style={{ color: clip.error ? "var(--danger)" : "var(--muted-2)" }}>
          {clip.error ? (
            <>
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span className="truncate">{clip.error}</span>
            </>
          ) : uploading ? (
            `${Math.round(clip.progress * 100)}% of ${megabytes(clip.bytes)}`
          ) : (
            megabytes(clip.bytes)
          )}
        </p>
      </div>
      {uploading ? (
        <span className="absolute inset-x-0 bottom-0 h-[3px]" style={{ background: "var(--border)" }}>
          <span className="block h-full transition-[width] duration-300" style={{ width: `${Math.round(clip.progress * 100)}%`, background: "var(--accent)" }} />
        </span>
      ) : null}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove ${clip.name}`}
        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full text-white"
        style={{ background: "var(--text)", boxShadow: "var(--shadow-xs)" }}
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

const megabytes = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(bytes >= 10 * 1048576 ? 0 : 1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** The model picker under the box, also used for a routine's model. */
export function ModelPicker({ value, onChange, side = "down" }: { value: string | null; onChange: (id: string) => void; side?: "up" | "down" }) {
  const catalog = useSeelie((s) => s.status?.catalog ?? null);
  const options: DropdownOption[] =
    catalog?.models.map((m, i, all) => ({
      id: m.id,
      label: m.name,
      dividerBefore: i > 0 && all[i - 1].provider !== m.provider,
    })) ?? [];
  if (!options.length) return null;
  const model = catalog?.models.find((m) => m.id === value) ?? null;
  return <DropdownMenu side={side} trigger={<Pill>{model?.name ?? "Model"}</Pill>} options={options} activeId={value ?? ""} onSelect={onChange} />;
}

/** How hard the model thinks, for the levels `model` offers. */
export function ThinkingPicker({
  model: modelId,
  value,
  onChange,
  side = "down",
}: {
  model: string | null;
  value: string | null;
  onChange: (level: string) => void;
  side?: "up" | "down";
}) {
  const model = useSeelie((s) => s.status?.catalog?.models.find((m) => m.id === modelId) ?? null);
  const options: DropdownOption[] = (model?.thinkingLevels ?? []).map((l) => ({ id: l, label: THINKING_LABEL[l] ?? l }));
  if (options.length < 2) return null;
  return (
    <DropdownMenu
      side={side}
      trigger={
        <Pill>
          <Brain className="h-3.5 w-3.5" />
          <span className="hidden min-[400px]:inline">{THINKING_LABEL[value ?? ""] ?? value}</span>
        </Pill>
      }
      options={options}
      activeId={value ?? ""}
      onSelect={onChange}
    />
  );
}

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="flex max-w-[8.5rem] items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--tint-hover)] min-[400px]:max-w-[11rem]"
      style={{ color: "var(--muted)" }}
    >
      <span className="flex min-w-0 items-center gap-1 truncate">{children}</span>
      <ChevronDown className="h-3 w-3 shrink-0 opacity-70" />
    </span>
  );
}

/** How full the chat is: its tokens against the model's window. */
function contextFor(messages: ReturnType<typeof useSeelie.getState>["messages"], window: number, modelName: string) {
  const tokens = contextTokens(messages);
  if (tokens === null || !window) return null;
  const used = Math.min(1, tokens / window);
  const n = new Intl.NumberFormat("en-IN");
  return {
    used,
    label: `${formatTokens(tokens)} / ${formatTokens(window)}`,
    title: `Context: ${n.format(tokens)} of ${n.format(window)} tokens (${Math.round((tokens / window) * 100)}%) that ${modelName} can read at once. Everything said, done and attached in this chat counts; start a new chat for a new task.`,
  };
}

/** A ring that fills as the chat's context does, with the count beside it. */
function ContextMeter({ context }: { context: NonNullable<ReturnType<typeof contextFor>> }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const color = context.used > 0.85 ? "var(--danger)" : context.used > 0.6 ? "var(--warn)" : "var(--accent)";
  return (
    <span className="mr-0.5 flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-[11px] tabular-nums" style={{ color: context.used > 0.85 ? "var(--danger)" : "var(--muted-2)" }} title={context.title} aria-label={context.title}>
      <svg width="18" height="18" viewBox="0 0 18 18" className="shrink-0 -rotate-90">
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--panel-2)" strokeWidth="2.5" />
        <circle cx="9" cy="9" r={r} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${Math.max(0.02, context.used) * c} ${c}`} />
      </svg>
      {context.label}
    </span>
  );
}

/** How much of its limits the least-used account serving this model has spent (its fullest window). */
function usageFor(limits: ReturnType<typeof useSeelie.getState>["limits"], provider: string | null) {
  if (!limits || !provider) return null;
  const accounts = limits.filter((a) => a.provider === provider && a.status === "active" && a.windows.length);
  if (!accounts.length) return null;
  const fullest = accounts.map((a) => ({ a, w: a.windows.reduce((x, y) => (y.used > x.used ? y : x)) }));
  const best = fullest.reduce((x, y) => (y.w.used < x.w.used ? y : x));
  return {
    used: best.w.used,
    title: `${best.a.email ?? best.a.providerName}: ${Math.round(best.w.used * 100)}% of ${best.w.label}${best.w.scope ? ` (${best.w.scope})` : ""} used. Click for all limits.`,
  };
}
