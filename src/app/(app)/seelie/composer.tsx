"use client";

import { AlertTriangle, ArrowDown, ArrowUp, Brain, ChevronDown, Music, Paperclip, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { DropdownMenu, type DropdownOption } from "@/components/dropdown-menu";
import { contextTokens, formatTokens } from "@/lib/seelie/context";
import { ACTIVE_RUN } from "@/lib/seelie/types";
import { MAX_DRAFT_CLIPS, MAX_DRAFT_IMAGES, useSeelie, type DraftClip, type DraftImage } from "@/lib/stores/seelie-store";
import { cn } from "@/lib/utils";

/**
 * Where a message is written: the text, the photos, clips and sounds going with it, and
 * the model and how hard it thinks. Docked to the bottom of the screen, above the phone's nav bar;
 * while it is written in on a phone, the nav bar steps aside and it sits on the keyboard.
 */

const MAX_SIDE = 1600;

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

export function Composer({
  disabled,
  onOpenSettings,
  onJump,
}: {
  disabled?: string | null;
  onOpenSettings: () => void;
  /** Set while the reader has scrolled up: a button back down to the latest. */
  onJump?: () => void;
}) {
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
  const { setDraft, addImages, removeImage, addClips, removeClip, send, stop, setModel, setThinking } = useSeelie.getState();

  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(0);
  const [dragging, setDragging] = useState(false);
  // Being written in on a phone, so the keyboard is up.
  const [typing, setTyping] = useState(false);

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
  const canSend =
    !disabled &&
    !running &&
    reading === 0 &&
    clipsReady &&
    (draft.trim().length > 0 || images.length > 0 || clips.length > 0) &&
    (seesImages || images.length === 0);
  const full = images.length >= MAX_DRAFT_IMAGES && clips.length >= MAX_DRAFT_CLIPS;

  // Grows with the text, up to 40% of the screen; then it scrolls.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`;
  }, [draft]);

  // A fresh chat, or a switch to another, puts the cursor in the box (not on phones,
  // where it would pop the keyboard over the chat).
  useEffect(() => {
    if (!coarse()) textRef.current?.focus();
  }, [chatId]);

  async function take(files: File[]) {
    addClips(files.filter((f) => f.type.startsWith("video/") || f.type.startsWith("audio/")));
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


  const usage = usageFor(limits, model?.provider ?? null);
  const context = model ? contextFor(messages, model.contextWindow, model.name) : null;

  // Docked above the phone's nav bar (56px + the safe area), at the window's foot from `sm` up
  // and while the keyboard is up.
  return (
    <div
      className={cn(
        "sticky z-20 -mx-1 px-1 pb-3 pt-3 sm:bottom-0 sm:pb-5",
        typing ? "bottom-0" : "bottom-[calc(56px+env(safe-area-inset-bottom))]",
      )}
      style={{ background: "linear-gradient(to top, var(--bg) 72%, transparent)" }}
    >
      {onJump ? (
        <div className="pointer-events-none absolute inset-x-0 -top-8 flex justify-center">
          <button
            type="button"
            onClick={onJump}
            aria-label="Down to the latest"
            className="pointer-events-auto flex h-9 w-9 items-center justify-center rounded-full border transition-transform active:scale-95"
            style={{ background: "var(--panel)", borderColor: "var(--border-strong)", boxShadow: "var(--shadow-md)", color: "var(--muted)", animation: "rise-in 0.28s var(--ease-apple)" }}
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        </div>
      ) : null}
      <div
        className={cn(
          "rounded-[22px] border transition-[border-color,box-shadow] duration-200 focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_3px_var(--accent-ring),var(--shadow-md)]",
          dragging && "border-[var(--accent)]",
          disabled && "opacity-60",
        )}
        style={{ background: "var(--panel)", borderColor: dragging ? "var(--accent)" : "var(--border-strong)", boxShadow: "var(--shadow-md)" }}
        onDragOver={(e) => {
          if (disabled || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          setDragging(false);
          if (disabled) return;
          e.preventDefault();
          void take(Array.from(e.dataTransfer.files));
        }}
      >
        {clips.length ? (
          <div className="flex gap-2 overflow-x-auto px-3 pt-3">
            {clips.map((clip) => (
              <ClipChip key={clip.key} clip={clip} onRemove={() => removeClip(clip.key)} />
            ))}
          </div>
        ) : null}

        {images.length || reading ? (
          <div className="flex gap-2 overflow-x-auto px-3 pt-3">
            {images.map((img, i) => (
              <div key={img.preview} className="group relative shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.preview} alt={`Photo ${i + 1}`} className="h-16 w-16 rounded-xl object-cover" style={{ border: "1px solid var(--border)" }} />
                <span
                  className="absolute bottom-1 left-1 rounded-md px-1 text-[10px] font-semibold tabular-nums text-white"
                  style={{ background: "rgba(10,20,30,0.55)" }}
                >
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
              <div key={`r${i}`} className="h-16 w-16 shrink-0 animate-pulse rounded-xl" style={{ background: "var(--panel-2)", border: "1px solid var(--border)" }} />
            ))}
          </div>
        ) : null}

        <textarea
          ref={textRef}
          value={draft}
          rows={1}
          disabled={!!disabled}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setTyping(coarse())}
          onBlur={() => setTyping(false)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            // On a phone Enter is a new line; the arrow button sends.
            if (coarse()) return;
            e.preventDefault();
            submit();
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files).filter((f) => /^(image|video|audio)\//.test(f.type));
            if (!files.length) return;
            if (!e.clipboardData.getData("text/plain")) e.preventDefault();
            void take(files);
          }}
          placeholder={disabled ?? (chatId ? "Reply to Seelie…" : "Ask Seelie anything, or tell it what to do…")}
          className="block max-h-[40vh] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-base leading-relaxed outline-none placeholder:text-[var(--muted-2)] sm:text-[15px]"
        />

        {/* A tap on these leaves the cursor in the box, so a phone's keyboard stays up and
            nothing moves under the finger before the tap lands. */}
        <div className="flex items-center gap-1 px-2 pb-2 pt-1" onMouseDown={(e) => e.preventDefault()}>
          <input
            ref={fileRef}
            type="file"
            accept={seesImages ? "image/*,video/*,audio/*" : "video/*,audio/*"}
            multiple
            hidden
            onChange={(e) => {
              void take(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={!!disabled || full}
            className="nav-icon-btn h-9 w-9 disabled:opacity-40 sm:h-8 sm:w-8"
            style={{ color: "var(--muted)" }}
            aria-label="Add photos, clips or sounds"
            title={`${seesImages ? `Photos (up to ${MAX_DRAFT_IMAGES}), clips` : "Clips"} and sounds (up to ${MAX_DRAFT_CLIPS}, 300 MB each)`}
          >
            <Paperclip className="h-[18px] w-[18px]" />
          </button>

          <ModelPicker value={modelId} onChange={setModel} side="up" />
          <ThinkingPicker model={modelId} value={thinking} onChange={setThinking} side="up" />

          <div className="flex-1" />

          {context ? <ContextMeter context={context} /> : null}

          {usage ? (
            <button
              type="button"
              onClick={onOpenSettings}
              className="mr-1 hidden items-center gap-1.5 rounded-lg px-1.5 py-1 text-[11px] tabular-nums hover:bg-[var(--tint-hover)] sm:flex"
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

          {running ? (
            <button
              type="button"
              onClick={() => void stop()}
              aria-label="Stop"
              className="flex h-9 w-9 items-center justify-center rounded-full text-white transition-transform active:scale-95"
              style={{ background: "var(--text)" }}
            >
              <Square className="h-3.5 w-3.5" fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label="Send"
              className="flex h-9 w-9 items-center justify-center rounded-full text-white transition-[transform,opacity] active:scale-95 disabled:opacity-35"
              style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))", boxShadow: canSend ? "0 4px 14px -4px color-mix(in srgb, var(--accent) 55%, transparent)" : undefined }}
            >
              <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
      {!seesImages && images.length ? (
        <p className="mt-1.5 px-2 text-xs" style={{ color: "var(--warn)" }}>
          {model?.name} can&apos;t see photos. Pick another model or remove them.
        </p>
      ) : null}
    </div>
  );
}

/** A clip or sound on its way: a still or a note icon, the upload's progress, and a remove button. */
function ClipChip({ clip, onRemove }: { clip: DraftClip; onRemove: () => void }) {
  const uploading = clip.assetId === null && !clip.error;
  return (
    <div
      className="relative flex h-16 w-44 shrink-0 items-center gap-2 overflow-hidden rounded-xl pr-6"
      style={{ border: `1px solid ${clip.error ? "var(--danger)" : "var(--border)"}`, background: "var(--panel-2)" }}
      title={clip.error ? `${clip.name}: ${clip.error}` : clip.name}
    >
      {clip.kind === "video" ? (
        <video src={clip.preview} muted playsInline preload="metadata" className="h-full w-12 shrink-0 bg-black object-cover" />
      ) : (
        <span className="flex h-full w-12 shrink-0 items-center justify-center" style={{ color: "var(--muted)" }}>
          <Music className="h-5 w-5" />
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

/** A ring that fills as the chat's context does, with the count beside it (a tap shows it on narrow phones). */
function ContextMeter({ context }: { context: NonNullable<ReturnType<typeof contextFor>> }) {
  const [open, setOpen] = useState(false);
  const r = 7;
  const c = 2 * Math.PI * r;
  const color = context.used > 0.85 ? "var(--danger)" : context.used > 0.6 ? "var(--warn)" : "var(--accent)";
  return (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      className="mr-0.5 flex h-9 items-center gap-1.5 rounded-lg px-1.5 text-[11px] tabular-nums hover:bg-[var(--tint-hover)] sm:h-auto sm:py-1"
      style={{ color: context.used > 0.85 ? "var(--danger)" : "var(--muted-2)" }}
      title={context.title}
      aria-label={context.title}
    >
      <svg width="18" height="18" viewBox="0 0 18 18" className="shrink-0 -rotate-90">
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--panel-2)" strokeWidth="2.5" />
        <circle cx="9" cy="9" r={r} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={`${Math.max(0.02, context.used) * c} ${c}`} />
      </svg>
      <span className={cn(open ? "inline" : "hidden min-[400px]:inline")}>{context.label}</span>
    </button>
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
