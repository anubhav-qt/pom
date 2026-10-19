"use client";

import type { TextContent, ToolResultMessage } from "@paribelle/pi-ai";
import { AlertTriangle, AtSign, Check, Copy, FileText, MessageSquareText, Music, Package, Paperclip, X } from "lucide-react";
import { useMemo, useState } from "react";

import { ZoomImg } from "@/components/image-lightbox";
import { Spinner } from "@/components/ui";
import { withBasePath } from "@/lib/base-path";
import { MENTION, STEER_NOTE, type ChatMessage, type Reaction } from "@/lib/seelie/types";
import { useSeelie, type PendingSend } from "@/lib/stores/seelie-store";
import { cn } from "@/lib/utils";

import { ChangeList, WrapBox } from "./cards";
import { ChipLine, LiveCard, PlanView, useWide, type Ctx } from "./job";
import { Markdown } from "./markdown";
import { Documents, MadeStrip, Pictures, Thumb, VideoBlock } from "./media";
import { ItemLines, ThoughtLine } from "./steps";
import { buildTurns, changesOf, chatChanges, chatMade, madeAnything, madeBy, nowOf, rowsOf, type Results, type Turn } from "./turns";

/**
 * The open chat: each request, then what Seelie did for it (on a phone a live card, from
 * `sm` up the plan as a checklist; a lookup or two as one line), its reply, and once a
 * job is done a wrap-up with what changed (each with Undo) and what to do next. What the
 * chat made is in a strip at its top.
 */

const imageUrl = (chatId: string, seq: number, index: number) => withBasePath(`/api/seelie/chats/${chatId}/images/${seq}/${index}`);

/* -------------------------------------------------------------------------- */
/* Turns, worked out once per change for everyone who draws them              */
/* -------------------------------------------------------------------------- */

let memo: { key: unknown[]; turns: Turn[]; results: Results } | null = null;

/** The chat's turns and tool results (shared by the timeline and the pinned bar). */
export function useTurns() {
  const messages = useSeelie((s) => s.messages);
  const tools = useSeelie((s) => s.tools);
  const partial = useSeelie((s) => s.partial);
  const pending = useSeelie((s) => s.pending);
  const steering = useSeelie((s) => s.steering);
  const run = useSeelie((s) => s.run);
  const showThinking = useSeelie((s) => s.showThinking);
  const key = [messages, tools, partial, pending, steering, run, showThinking];
  if (!memo || memo.key.some((k, i) => k !== key[i])) {
    const results: Results = new Map();
    for (const m of messages) if (m.message.role === "toolResult") results.set((m.message as ToolResultMessage).toolCallId, { result: m.message as ToolResultMessage, seq: m.seq });
    const hasContent = !!partial?.content.some((c) => (c.type === "text" ? c.text : c.type === "thinking" ? c.thinking || true : true));
    memo = { key, results, turns: buildTurns({ messages, tools, partial: hasContent ? partial : null, pending, steering, run, showThinking }) };
  }
  return { turns: memo.turns, results: memo.results, tools };
}

export function Timeline() {
  const chatId = useSeelie((s) => s.chatId);
  const { turns, results, tools } = useTurns();
  const wide = useWide();
  const ctx: Ctx = useMemo(() => ({ tools, results, chatId }), [tools, results, chatId]);
  const made = useMemo(() => chatMade(turns, results, tools), [turns, results, tools]);
  const changes = useMemo(() => chatChanges(turns, tools, results), [turns, tools, results]);

  return (
    <div className="space-y-3 pb-4">
      <MadeStrip made={made} changes={changes} renderChanges={() => <ChangeList changes={changes} />} />
      {turns.map((t) => (
        <TurnView key={t.key} turn={t} ctx={ctx} wide={wide} />
      ))}
    </div>
  );
}

function TurnView({ turn, ctx, wide }: { turn: Turn; ctx: Ctx; wide: boolean }) {
  const steps = turn.work.some((it) => it.type === "tool" || it.type === "steer");
  const made = useMemo(() => madeBy(turn.items, ctx.results, ctx.tools), [turn, ctx]);
  const changes = useMemo(() => (turn.live ? [] : changesOf(turn.items, ctx.tools, ctx.results)), [turn, ctx]);
  const asks = rowsOf(turn, ctx.tools).some((r) => r.status === "awaiting");
  // A phone shows a live card for real work; a lookup or two stays one line.
  const big = !!turn.plan || turn.calls >= 3 || asks || madeAnything(made) || turn.work.some((it) => it.type === "steer");
  const thoughts = turn.work.filter((it) => it.type === "thinking");

  return (
    <>
      {turn.ask ? <UserBubble entry={turn.ask.entry} pending={turn.ask.pending} /> : null}
      {!steps ? (
        thoughts.map((t) => (t.type === "thinking" ? <ThoughtLine key={t.key} text={t.text} ms={t.ms} live={t.live} /> : null))
      ) : wide ? (
        turn.plan ? (
          <PlanView turn={turn} ctx={ctx} />
        ) : (
          <div>
            <ItemLines items={turn.work} ctx={ctx} />
            {turn.live ? <Working turn={turn} ctx={ctx} /> : null}
          </div>
        )
      ) : big ? (
        <LiveCard turn={turn} ctx={ctx} />
      ) : (
        <ChipLine turn={turn} ctx={ctx} />
      )}
      {turn.live && !turn.items.length ? <Waiting /> : null}
      {turn.reply ? <Reply turn={turn} /> : null}
      {!turn.live && steps ? (
        <WrapBox turn={turn} changes={changes}>
          {wide && turn.plan && madeAnything(made) ? (
            <div>
              {made.videos.map((v) => (
                <div key={v.src} className="mt-1">
                  <VideoBlock video={v} />
                </div>
              ))}
              {made.pictures.length ? <Pictures pictures={made.pictures} /> : null}
              {made.documents.length ? <Documents documents={made.documents} /> : null}
            </div>
          ) : null}
        </WrapBox>
      ) : null}
    </>
  );
}

/** Before the first step: Seelie has the message and is on it. */
function Waiting() {
  const run = useSeelie((s) => s.run);
  return (
    <div className="flex items-center gap-2.5 py-1">
      <Spinner size="1.05rem" />
      <span className="sl-shimmer text-sm">{run?.status === "waiting" ? "Waiting for your answer…" : "Seelie is on it…"}</span>
    </div>
  );
}

/** Between steps on the wide list without a plan: what's happening now. */
function Working({ turn, ctx }: { turn: Turn; ctx: Ctx }) {
  const now = nowOf(turn, ctx.tools);
  if (now.asking || turn.items.some((it) => it.type === "tool" && ctx.tools[it.call.id]?.status === "running")) return null;
  return (
    <div className="mt-2.5 flex items-center gap-2 pl-[17px] text-[12.5px]">
      <span className="sl-spin sm" />
      <span className="sl-shimmer">{now.text}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The reply                                                                  */
/* -------------------------------------------------------------------------- */

function Reply({ turn }: { turn: Turn }) {
  const reply = turn.reply!;
  return (
    <div>
      <Markdown text={reply.text} />
      {!turn.live && reply.seq ? <ReplyActions seq={reply.seq} text={reply.text} /> : null}
    </div>
  );
}

/** Thumbs, a note Seelie can keep as a memory, and copy. */
function ReplyActions({ seq, text }: { seq: number; text: string }) {
  const chatId = useSeelie((s) => s.chatId);
  const reaction = useSeelie((s) => (s.messages.find((m) => m.seq === seq)?.message as { reaction?: Reaction } | undefined)?.reaction ?? null);
  const [noting, setNoting] = useState(false);
  const [note, setNote] = useState("");
  const [keep, setKeep] = useState(true);
  const [copied, setCopied] = useState(false);
  if (!chatId) return null;
  const react = (liked: boolean | null, extra?: { note: string; remember: boolean }) =>
    useSeelie.getState().react({ on: "reply", chatId, seq, liked, note: extra?.note ?? reaction?.note ?? null, remember: extra?.remember });

  return (
    <div className="mt-1">
      <div className="-ml-1.5 flex items-center">
        <Thumb up active={reaction?.liked === true} onClick={() => void react(reaction?.liked === true ? null : true)} label="Good answer" />
        <Thumb active={reaction?.liked === false} onClick={() => void react(reaction?.liked === false ? null : false)} label="Not good" />
        <button type="button" className="nav-icon-btn h-8 w-8" style={{ color: noting || reaction?.note ? "var(--accent-ink)" : "var(--muted-2)" }} onClick={() => setNoting((v) => !v)} aria-label="Add a note" title="Add a note">
          <MessageSquareText className="h-[15px] w-[15px]" />
        </button>
        <button
          type="button"
          className="nav-icon-btn h-8 w-8"
          style={{ color: copied ? "var(--ok)" : "var(--muted-2)" }}
          aria-label="Copy"
          title="Copy"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="h-[15px] w-[15px]" /> : <Copy className="h-[15px] w-[15px]" />}
        </button>
        {reaction?.note && !noting ? (
          <span className="muted ml-1 min-w-0 truncate text-[11.5px]" title={reaction.note}>
            {reaction.remembered ? "Remembered: " : "Note: "}
            {reaction.note}
          </span>
        ) : null}
      </div>
      {noting ? (
        <form
          className="sl-note-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!note.trim()) return;
            void react(reaction?.liked ?? null, { note: note.trim(), remember: keep }).then((ok) => {
              if (ok) {
                setNoting(false);
                setNote("");
              }
            });
          }}
        >
          <input value={note} onChange={(e) => setNote(e.target.value)} autoFocus maxLength={1000} placeholder="What should Seelie do differently?" className="input text-base sm:text-[13px]" />
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs" style={{ color: "var(--muted)" }}>
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} className="accent-[var(--accent)]" />
              Remember it for next time
            </label>
            <span className="flex-1" />
            <button type="button" className="btn px-2.5 py-1 text-xs" onClick={() => setNoting(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-blue px-2.5 py-1 text-xs" disabled={!note.trim()}>
              Save
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* What was asked                                                             */
/* -------------------------------------------------------------------------- */

/** What the engine writes for each attached clip: `Attached: {"ref":"asset:12",...}`. */
const ATTACHED = /^Attached: (\{.*\})$/;

interface Attachment {
  name: string;
  kind: string;
  src: string | null;
}

function attachmentOf(text: string): Attachment | null {
  const m = ATTACHED.exec(text.trim());
  if (!m) return null;
  try {
    const a = JSON.parse(m[1]) as { ref?: string; kind?: string; name?: string };
    const id = /^asset:(\d+)$/.exec(a.ref ?? "")?.[1];
    if (!id) return null;
    const plays = a.kind === "video" || a.kind === "audio" || a.kind === "document";
    return { name: a.name ?? `asset:${id}`, kind: a.kind ?? "file", src: plays ? withBasePath(`/api/seelie/assets/${id}`) : null };
  } catch {
    return null;
  }
}

/** The message's words, with each product or order picked with @ as a chip. */
export function WithMentions({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION)) {
    const at = m.index ?? 0;
    if (at > last) parts.push(text.slice(last, at));
    parts.push(
      <span key={at} className="sl-mention" title={`${m[2]} ${m[3]}`}>
        {m[2] === "product" ? <Package className="h-3 w-3" /> : <AtSign className="h-3 w-3" />}
        {m[1]}
      </span>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

function UserBubble({ entry, pending }: { entry?: ChatMessage; pending?: PendingSend }) {
  const chatId = useSeelie((s) => s.chatId);
  let text = pending?.text ?? "";
  let images: { src: string }[] = pending?.images.map((i) => ({ src: i.preview })) ?? [];
  let attached: Attachment[] = pending?.clips.map((c) => ({ name: c.name, kind: c.kind, src: c.preview })) ?? [];
  if (entry && entry.message.role === "user") {
    const content = entry.message.content;
    if (typeof content === "string") text = content;
    else {
      const texts = content.filter((c): c is TextContent => c.type === "text" && c.text !== STEER_NOTE).map((c) => c.text);
      attached = texts.map(attachmentOf).filter((a): a is Attachment => a !== null);
      text = texts.filter((t) => !attachmentOf(t)).join("\n");
      images = chatId ? content.flatMap((c, i) => (c.type === "image" ? [{ src: imageUrl(chatId, entry.seq, i) }] : [])) : [];
    }
  }
  return (
    // A little more room above each question than between the steps of a reply.
    <div className={cn("flex flex-col items-end gap-1.5 pt-2 first:pt-0", pending && "opacity-80")}>
      {attached.length ? (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {attached.map((a, i) =>
            a.kind === "video" && a.src ? (
              <video key={i} src={a.src} controls playsInline preload="metadata" title={a.name} className="max-h-60 w-auto max-w-full rounded-xl bg-black" />
            ) : a.kind === "audio" && a.src ? (
              <div key={i} className="surface-2 flex max-w-full flex-wrap items-center gap-2 px-2.5 py-1.5 sm:flex-nowrap">
                <Music className="h-4 w-4 shrink-0" style={{ color: "var(--muted)" }} />
                <span className="min-w-0 max-w-[10rem] truncate text-xs">{a.name}</span>
                <audio src={a.src} controls preload="none" className="h-8 w-full max-w-full sm:w-auto sm:max-w-[14rem]" />
              </div>
            ) : (a.kind === "document" || a.kind === "pdf") && a.src ? (
              <a key={i} href={a.src} target="_blank" rel="noopener" title={`Open ${a.name}`} className="surface-2 flex max-w-full items-center gap-1.5 px-2.5 py-1.5 text-xs">
                <FileText className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--muted)" }} />
                <span className="min-w-0 truncate">{a.name}</span>
              </a>
            ) : (
              <span key={i} className="surface-2 flex items-center gap-1.5 px-2.5 py-1.5 text-xs">
                <Paperclip className="h-3.5 w-3.5" style={{ color: "var(--muted)" }} />
                {a.name}
              </span>
            ),
          )}
        </div>
      ) : null}
      {images.length ? (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {images.map((img, i) => (
            <ZoomImg key={i} src={img.src} alt={`Photo ${i + 1}`} className="h-20 w-20 rounded-xl object-cover" style={{ border: "1px solid var(--border)" }} />
          ))}
        </div>
      ) : null}
      {text ? (
        <div className="sl-ub">
          <WithMentions text={text} />
        </div>
      ) : null}
    </div>
  );
}

export function Notice({ tone, children, onClose }: { tone: "danger" | "warn"; children: React.ReactNode; onClose?: () => void }) {
  return (
    <div
      className="flex items-start gap-2 rounded-xl px-3 py-2 text-sm"
      style={{ background: tone === "danger" ? "var(--danger-soft)" : "var(--warn-soft)", color: tone === "danger" ? "var(--danger)" : "var(--warn)" }}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {onClose ? (
        <button type="button" onClick={onClose} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
          <X className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
