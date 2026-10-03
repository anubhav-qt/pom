"use client";

import type { AssistantMessage, ImageContent, TextContent, ToolCall, ToolResultMessage } from "@paribelle/pi-ai";
import { AlertTriangle, ChevronDown, Download, ExternalLink, FileText, Music, Paperclip, Share2, X } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import { ZoomImg } from "@/components/image-lightbox";
import { Spinner } from "@/components/ui";
import { BASE_PATH, withBasePath } from "@/lib/base-path";
import { ACTIVE_RUN, type ChatMessage, type HelperState, type ToolKind, type ToolRow } from "@/lib/seelie/types";
import { useSeelie, type DraftClip, type DraftImage } from "@/lib/stores/seelie-store";
import { cn } from "@/lib/utils";

import { Markdown } from "./markdown";

/**
 * The open chat: what was asked, Seelie's replies, and between them the steps it took
 * (its thinking and each tool call) as dots on a line, with the approval buttons on the
 * ones waiting for a yes.
 */

type Results = Map<string, { result: ToolResultMessage; seq: number }>;
type Pending = { text: string; images: DraftImage[]; clips: DraftClip[] };

const imageUrl = (chatId: string, seq: number, index: number) => withBasePath(`/api/seelie/chats/${chatId}/images/${seq}/${index}`);

/** A step on the line: a thought or a tool call. */
type StepItem = { type: "thinking"; text: string; live: boolean } | { type: "tool"; call: ToolCall };

/** The chat in reading order. Steps in a row share one line, across a turn's model calls. */
type Piece =
  | { type: "user"; entry?: ChatMessage; pending?: Pending }
  | { type: "text"; text: string }
  | { type: "steps"; steps: StepItem[] }
  | { type: "error"; text: string }
  | { type: "stopped" };

function piecesOf(messages: ChatMessage[], pending: Pending | null, partial: AssistantMessage | null, showThinking: boolean): Piece[] {
  const pieces: Piece[] = [];
  const step = (s: StepItem) => {
    const last = pieces[pieces.length - 1];
    if (last?.type === "steps") last.steps.push(s);
    else pieces.push({ type: "steps", steps: [s] });
  };
  const reply = (message: AssistantMessage, streaming: boolean) => {
    const end = message.content.length - 1;
    message.content.forEach((block, i) => {
      if (block.type === "thinking") {
        if (showThinking && block.thinking.trim()) step({ type: "thinking", text: block.thinking, live: streaming && i === end });
      } else if (block.type === "text") {
        if (block.text.trim()) pieces.push({ type: "text", text: block.text });
      } else step({ type: "tool", call: block });
    });
    if (message.stopReason === "error") pieces.push({ type: "error", text: message.errorMessage || "The model returned an error." });
    else if (message.stopReason === "aborted") pieces.push({ type: "stopped" });
  };
  for (const m of messages) {
    if (m.message.role === "user") pieces.push({ type: "user", entry: m });
    else if (m.message.role === "assistant") reply(m.message, false);
  }
  if (pending) pieces.push({ type: "user", pending });
  if (partial) reply(partial, true);
  return pieces;
}

export function Timeline() {
  const chatId = useSeelie((s) => s.chatId);
  const messages = useSeelie((s) => s.messages);
  const tools = useSeelie((s) => s.tools);
  const partial = useSeelie((s) => s.partial);
  const pending = useSeelie((s) => s.pending);
  const run = useSeelie((s) => s.run);
  const showThinking = useSeelie((s) => s.showThinking);

  const results = useMemo(() => {
    const map: Results = new Map();
    for (const m of messages) if (m.message.role === "toolResult") map.set(m.message.toolCallId, { result: m.message, seq: m.seq });
    return map;
  }, [messages]);

  const active = !!run && ACTIVE_RUN.includes(run.status);
  const working = Object.values(tools).some((t) => t.runId === run?.id && (t.status === "running" || t.status === "awaiting"));
  const partialHasContent = !!partial?.content.some((c) => (c.type === "text" ? c.text : c.type === "thinking" ? c.thinking : true));
  const pieces = useMemo(
    () => piecesOf(messages, pending, partialHasContent ? partial : null, showThinking),
    [messages, pending, partial, partialHasContent, showThinking],
  );
  const waiting = active && !partialHasContent && !working ? (run?.status === "waiting" ? "Waiting for your answer…" : "Seelie is working…") : null;
  // Between steps, the wait is the next dot on their line.
  const onLine = !!waiting && pieces[pieces.length - 1]?.type === "steps";

  return (
    <div className="space-y-3 pb-4">
      {pieces.map((p, i) => {
        const key = `${p.type}:${i}`;
        switch (p.type) {
          case "user":
            return <UserBubble key={key} entry={p.entry} pending={p.pending} chatId={chatId} />;
          case "text":
            return <Markdown key={key} text={p.text} />;
          case "error":
            return (
              <Notice key={key} tone="danger">
                {p.text}
              </Notice>
            );
          case "stopped":
            return (
              <p key={key} className="muted text-xs">
                Stopped.
              </p>
            );
          case "steps":
            return <Steps key={key} steps={p.steps} tools={tools} results={results} chatId={chatId} trailing={onLine && i === pieces.length - 1 ? waiting : null} />;
        }
      })}
      {waiting && !onLine ? (
        <div className="flex items-center gap-2.5 py-1">
          <Spinner size="1.1rem" />
          <span className="muted text-sm">{waiting}</span>
        </div>
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
  /** Where it plays (a clip or a sound) or opens (a PDF) from. */
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

function UserBubble({ entry, pending, chatId }: { entry?: ChatMessage; pending?: Pending; chatId: string | null }) {
  let text = pending?.text ?? "";
  let images: { src: string }[] = pending?.images.map((i) => ({ src: i.preview })) ?? [];
  let attached: Attachment[] = pending?.clips.map((c) => ({ name: c.name, kind: c.kind, src: c.preview })) ?? [];
  if (entry && entry.message.role === "user") {
    const content = entry.message.content;
    if (typeof content === "string") text = content;
    else {
      const texts = content.filter((c): c is TextContent => c.type === "text").map((c) => c.text);
      attached = texts.map(attachmentOf).filter((a): a is Attachment => a !== null);
      text = texts.filter((t) => !attachmentOf(t)).join("\n");
      images = chatId
        ? content.flatMap((c, i) => (c.type === "image" ? [{ src: imageUrl(chatId, entry.seq, i) }] : []))
        : [];
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
        <div
          className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm px-3.5 py-2 text-sm text-white"
          style={{ background: "linear-gradient(135deg, var(--accent), var(--accent-2))" }}
        >
          {text}
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

/* -------------------------------------------------------------------------- */
/* Steps: dots on a line                                                      */
/* -------------------------------------------------------------------------- */

type Tone = "queued" | "live" | "ask" | "ok" | "bad" | "off" | "thought";

const TONE: Record<Tone, { color: string; hollow?: boolean; ping?: boolean }> = {
  queued: { color: "var(--accent)", hollow: true },
  live: { color: "var(--accent)", ping: true },
  ask: { color: "var(--warn)", ping: true },
  ok: { color: "var(--ok)" },
  bad: { color: "var(--danger)" },
  off: { color: "var(--muted-2)", hollow: true },
  thought: { color: "color-mix(in srgb, var(--accent) 45%, transparent)" },
};

const STATUS_TONE: Record<ToolRow["status"], Tone> = { queued: "queued", running: "live", awaiting: "ask", done: "ok", denied: "off", error: "bad" };
const HELPER_TONE: Record<HelperState["status"], Tone> = { working: "live", done: "ok", error: "bad", stopped: "off" };

/** Steps in a row, at most 40% of the chat's width (all of it on a phone). */
function Steps({
  steps,
  tools,
  results,
  chatId,
  trailing,
}: {
  steps: StepItem[];
  tools: Record<string, ToolRow>;
  results: Results;
  chatId: string | null;
  trailing: string | null;
}) {
  const count = steps.length + (trailing ? 1 : 0);
  return (
    <ol className="w-full sm:w-2/5 sm:min-w-[16rem]">
      {steps.map((s, i) =>
        s.type === "thinking" ? (
          <ThinkingStep key={`thinking:${i}`} text={s.text} live={s.live} last={i === count - 1} />
        ) : s.call.name === "helpers" ? (
          <HelpersStep key={s.call.id} call={s.call} row={tools[s.call.id]} result={results.get(s.call.id)} tools={tools} chatId={chatId} last={i === count - 1} />
        ) : (
          <ToolStep key={s.call.id} call={s.call} row={tools[s.call.id]} result={results.get(s.call.id)} chatId={chatId} last={i === count - 1} />
        ),
      )}
      {trailing ? (
        <Step tone="live" last>
          <p className="muted text-xs leading-5">{trailing}</p>
        </Step>
      ) : null}
    </ol>
  );
}

/** One dot, coloured by how the step went; the line runs on to the next dot. */
function Step({ tone, last, children }: { tone: Tone; last: boolean; children: React.ReactNode }) {
  const t = TONE[tone];
  return (
    <li className={cn("relative min-w-0 pl-5", !last && "pb-2.5")}>
      {last ? null : <span aria-hidden className="absolute -bottom-[3px] left-1 top-[17px] w-px" style={{ background: "var(--border-strong)" }} />}
      <span aria-hidden className="absolute left-0 top-[5.5px] h-[9px] w-[9px]">
        {t.ping ? <span className="absolute inset-0 rounded-full opacity-60 motion-safe:animate-ping" style={{ background: t.color }} /> : null}
        <span className="absolute inset-0 rounded-full" style={t.hollow ? { border: `1.5px solid ${t.color}` } : { background: t.color }} />
      </span>
      {children}
    </li>
  );
}

/** A step's name and what it's doing; opens for what it was asked and what came back. */
function StepHead({ label, line, took, open, onToggle }: { label: string; line: string | null | undefined; took: string | null; open: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className="group flex w-full items-start gap-2 text-left">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-5 group-hover:text-[var(--accent-ink)]">{label}</span>
        {line ? <span className="muted line-clamp-2 break-words text-xs">{line}</span> : null}
      </span>
      {took ? (
        <span className="shrink-0 text-[11px] leading-5 tabular-nums" style={{ color: "var(--muted-2)" }}>
          {took}
        </span>
      ) : null}
      <ChevronDown className={cn("mt-[3px] h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-180")} style={{ color: "var(--muted-2)" }} />
    </button>
  );
}

const ThinkingStep = memo(function ThinkingStep({ text, live, last }: { text: string; live: boolean; last: boolean }) {
  const [open, setOpen] = useState(live);
  useEffect(() => setOpen(live), [live]);
  return (
    <Step tone={live ? "live" : "thought"} last={last}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="muted flex items-center gap-1 text-xs font-medium leading-5 hover:text-[var(--text)]"
      >
        {live ? "Thinking…" : "Thought it through"}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="muted mt-1 text-[13px]">
          <Markdown text={text} className="text-[13px]" />
        </div>
      ) : null}
    </Step>
  );
});

/** What each kind of change is, on its approval. */
const ASKS: Record<ToolKind, string> = {
  read: "",
  write: "This changes the OMS.",
  market: "This changes Amazon.",
  store: "This changes paribelle.in.",
  publish: "This posts publicly.",
  spend: "This uses the image model's limited budget.",
  ads: "This can spend money on Meta ads.",
  forget: "This deletes something Seelie remembers for you.",
};

/** A change's plain one-liner (the model's `ask`), and the arguments the tool itself takes. */
function splitAsk(args: unknown): { ask: string | null; rest: unknown } {
  if (!args || typeof args !== "object" || Array.isArray(args) || !("ask" in args)) return { ask: null, rest: args };
  const { ask, ...rest } = args as Record<string, unknown>;
  return { ask: typeof ask === "string" && ask.trim() ? ask.trim() : null, rest };
}

function humanize(name: string) {
  return name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function duration(row: ToolRow) {
  if (!row.startedAt || !row.endedAt) return null;
  const ms = new Date(row.endedAt).getTime() - new Date(row.startedAt).getTime();
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** What the tool returned: the text, and the data parsed back out of its last line. */
function readResult(result: ToolResultMessage | undefined) {
  if (!result) return null;
  const text = result.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  let data: unknown;
  const lastLine = text.slice(text.lastIndexOf("\n") + 1);
  if (/^[[{]/.test(lastLine)) {
    try {
      data = JSON.parse(lastLine);
    } catch {
      data = undefined;
    }
  }
  const prose = data === undefined ? text : text.slice(0, Math.max(0, text.length - lastLine.length - 1));
  const images = result.content.flatMap((c, i) => (c.type === "image" ? [{ block: c as ImageContent, index: i }] : []));
  return { text: prose, data, images, isError: result.isError };
}

const ToolStep = memo(function ToolStep({
  call,
  row: maybeRow,
  result,
  chatId,
  last,
}: {
  call: ToolCall;
  row?: ToolRow;
  result?: { result: ToolResultMessage; seq: number };
  chatId: string | null;
  last: boolean;
}) {
  const row: ToolRow = maybeRow ?? {
    runId: "",
    callId: call.id,
    tool: call.name,
    label: humanize(call.name),
    kind: "read",
    args: call.arguments,
    summary: null,
    status: result ? (result.result.isError ? "error" : "done") : "queued",
    approval: null,
    decidedBy: null,
    decidedAt: null,
    startedAt: null,
    endedAt: null,
  };
  const awaiting = row.status === "awaiting";
  const [open, setOpen] = useState(false);
  const { ask, rest } = splitAsk(row.args);
  const out = readResult(result?.result);
  const video = videoOf(out?.data);
  const pictures = picturesOf(out?.data);
  const documents = documentsOf(out?.data);

  return (
    <Step tone={STATUS_TONE[row.status]} last={last}>
      <StepHead
        label={row.label}
        line={row.status === "running" && row.progress ? row.progress : (ask ?? row.summary)}
        took={duration(row)}
        open={open}
        onToggle={() => setOpen((v) => !v)}
      />

      {video ? (
        <div className="mt-2">
          <video src={video.src} poster={video.poster} controls playsInline preload="metadata" className="max-h-[28rem] w-auto max-w-full rounded-xl bg-black" />
          <VideoActions video={video} />
        </div>
      ) : null}

      {pictures.length ? <Pictures pictures={pictures} /> : null}
      {documents.length ? <Documents documents={documents} /> : null}

      {open || awaiting ? (
        <div className="surface-2 mt-2 overflow-hidden" style={awaiting ? { borderColor: "color-mix(in srgb, var(--warn) 45%, transparent)" } : undefined}>
          {awaiting ? <Approval row={row} ask={ask} open={open} onToggle={() => setOpen((v) => !v)} /> : null}
          {open ? (
            <div className="space-y-2.5 px-3 py-2.5">
              <Section title={awaiting ? "Exactly what it runs" : "Asked"}>
                {/* The headline was the plain words: the tool's own line goes with the details. */}
                {ask && row.summary ? <p className="mb-1.5 break-words font-mono text-[12px]">{row.summary}</p> : null}
                <Args args={rest} />
              </Section>
              {row.status === "denied" ? <p className="muted text-xs">Not allowed{row.decidedBy ? ` by ${row.decidedBy}` : ""}.</p> : null}
              {out ? (
                <Section title={out.isError ? "Error" : "Result"}>
                  {out.text ? <Pre text={out.text} tone={out.isError ? "danger" : undefined} /> : null}
                  {out.data !== undefined ? <DataView data={out.data} /> : null}
                  {out.images.length && chatId && result ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {out.images.map(({ index }) => (
                        <ZoomImg key={index} src={imageUrl(chatId, result.seq, index)} alt={`Image ${index}`} className="h-24 w-24 rounded-lg object-cover" />
                      ))}
                    </div>
                  ) : null}
                </Section>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </Step>
  );
});

/* -------------------------------------------------------------------------- */
/* Helpers: parts of a request worked on at the same time                      */
/* -------------------------------------------------------------------------- */

/** A helpers call: each helper as a dot of its own, with its model, its steps (asking like any other) and its answer. */
function HelpersStep({
  call,
  row,
  result,
  tools,
  chatId,
  last,
}: {
  call: ToolCall;
  row?: ToolRow;
  result?: { result: ToolResultMessage; seq: number };
  tools: Record<string, ToolRow>;
  chatId: string | null;
  last: boolean;
}) {
  const [open, setOpen] = useState(false);
  const live = !result && (!row || row.status === "running" || row.status === "queued");
  const jobs = ((call.arguments as { jobs?: { title?: string; thinking?: string }[] }).jobs ?? []).filter(Boolean);
  const fromResult = (result?.result.details as { helpers?: HelperState[] } | undefined)?.helpers;
  const helpers: HelperState[] =
    row?.helpers ??
    fromResult ??
    jobs.map((j) => ({ title: j.title ?? "Helper", model: "", thinking: j.thinking ?? "", status: live ? "working" : "stopped", answer: null }));
  const steps = Object.values(tools).filter((t) => t.parent === call.id);
  const tone: Tone = row ? STATUS_TONE[row.status] : live ? "live" : result?.result.isError ? "bad" : "ok";
  const titles = helpers.map((h) => h.title).join(", ");

  return (
    <Step tone={tone} last={last}>
      <StepHead
        label="Helpers"
        line={live && row?.progress ? row.progress : `${helpers.length === 1 ? "1 helper" : `${helpers.length} at once`}: ${titles}`}
        took={row ? duration(row) : null}
        open={open}
        onToggle={() => setOpen((v) => !v)}
      />
      <ol className="mt-2">
        {helpers.map((h, i) => (
          <HelperStep
            key={i}
            helper={h.status === "working" && !live ? { ...h, status: "stopped" } : h}
            steps={steps.filter((t) => t.helper === i)}
            open={open}
            chatId={chatId}
            last={i === helpers.length - 1}
          />
        ))}
      </ol>
    </Step>
  );
}

function HelperStep({ helper: h, steps, open, chatId, last }: { helper: HelperState; steps: ToolRow[]; open: boolean; chatId: string | null; last: boolean }) {
  const [answer, setAnswer] = useState(false);
  // Steps show while it works, when one waits for an answer, and when the card is opened.
  const showSteps = open || h.status === "working" || steps.some((t) => t.status === "awaiting");
  const about = [
    h.model ? `${h.model}${h.thinking ? ` · ${h.thinking}` : ""}` : null,
    !showSteps && steps.length ? (steps.length === 1 ? "1 step" : `${steps.length} steps`) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Step tone={HELPER_TONE[h.status]} last={last}>
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium leading-5">{h.title}</span>
          {about ? <span className="muted block truncate text-[11px]">{about}</span> : null}
        </span>
        {h.answer ? (
          <button
            type="button"
            onClick={() => setAnswer((v) => !v)}
            aria-expanded={answer}
            className="muted flex shrink-0 items-center gap-0.5 text-xs leading-5 hover:text-[var(--text)]"
          >
            Answer
            <ChevronDown className={cn("h-3 w-3 transition-transform", answer && "rotate-180")} />
          </button>
        ) : null}
      </div>
      {showSteps && steps.length ? (
        <ol className="mt-2">
          {steps.map((t, j) => (
            <ToolStep
              key={t.callId}
              call={{ type: "toolCall", id: t.callId, name: t.tool, arguments: (t.args ?? {}) as ToolCall["arguments"] }}
              row={t}
              result={t.result ? { result: t.result, seq: -1 } : undefined}
              chatId={chatId}
              last={j === steps.length - 1}
            />
          ))}
        </ol>
      ) : null}
      {answer && h.answer ? (
        <div className="surface-2 muted mt-2 px-2.5 py-2">
          <Markdown text={h.answer} className="text-[13px]" />
        </div>
      ) : null}
    </Step>
  );
}

interface CardPicture {
  id: number;
  name: string;
  size?: string;
}

/** Sources of the pictures Seelie made (not the photos it was given, nor masks). */
const MADE = new Set(["photoshoot", "edited", "generated", "cutout"]);

/** The pictures a photo tool made, anywhere in its result (photo_edit's list, a shoot's results, a model sheet). */
function picturesOf(data: unknown): CardPicture[] {
  const found = new Map<number, CardPicture>();
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 4 || found.size >= 24) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    const id = typeof o.ref === "string" ? /^asset:(\d+)$/.exec(o.ref)?.[1] : undefined;
    if (id && o.kind === "image" && typeof o.source === "string" && MADE.has(o.source)) {
      found.set(Number(id), { id: Number(id), name: typeof o.name === "string" ? o.name : o.ref as string, ...(typeof o.size === "string" ? { size: o.size } : {}) });
      return;
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(data, 0);
  return [...found.values()];
}

const assetUrl = (id: number, query: string) => withBasePath(`/api/seelie/assets/${id}?${query}`);

interface CardDocument {
  id: number;
  name: string;
  pages?: number;
  kb?: number;
  locked?: boolean;
}

/** The PDFs a tool made, anywhere in its result (one, or a split's list). */
function documentsOf(data: unknown): CardDocument[] {
  const found = new Map<number, CardDocument>();
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 3 || found.size >= 24) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    const id = typeof o.ref === "string" ? /^asset:(\d+)$/.exec(o.ref)?.[1] : undefined;
    if (id && o.kind === "document" && typeof o.source === "string" && MADE.has(o.source)) {
      found.set(Number(id), {
        id: Number(id),
        name: typeof o.name === "string" ? o.name : (o.ref as string),
        ...(typeof o.pages === "number" ? { pages: o.pages } : {}),
        ...(typeof o.kb === "number" ? { kb: o.kb } : {}),
        ...(o.locked === true ? { locked: true } : {}),
      });
      return;
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(data, 0);
  return [...found.values()];
}

/** What a PDF tool made: open it in the browser's viewer, or save it. */
function Documents({ documents }: { documents: CardDocument[] }) {
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {documents.map((d) => (
        <div key={d.id} className="surface-2 flex max-w-md items-center gap-2.5 px-2.5 py-2">
          <FileText className="h-5 w-5 shrink-0" style={{ color: "var(--muted)" }} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium" title={d.name}>
              {d.name}
            </p>
            <p className="muted text-[11px] tabular-nums">
              {[d.pages ? `${d.pages} page${d.pages === 1 ? "" : "s"}` : null, d.kb ? (d.kb >= 1024 ? `${(d.kb / 1024).toFixed(1)} MB` : `${d.kb} KB`) : null, d.locked ? "password-locked" : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <a href={assetUrl(d.id, "")} target="_blank" rel="noopener" className="btn shrink-0 p-1.5" aria-label={`Open ${d.name}`} title="Open">
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <a href={assetUrl(d.id, "download=1")} download className="btn shrink-0 p-1.5" aria-label={`Download ${d.name}`} title="Download">
            <Download className="h-3.5 w-3.5" />
          </a>
        </div>
      ))}
    </div>
  );
}

/** What a photo tool made, each with Download (the full file). */
function Pictures({ pictures }: { pictures: CardPicture[] }) {
  return (
    // Three across a phone's width; fixed-size tiles from `sm` up.
    <div className="mt-2 grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:gap-2.5">
      {pictures.map((p) => (
        <figure key={p.id} className="min-w-0 space-y-1 sm:w-28">
          <ZoomImg
            src={assetUrl(p.id, "w=480")}
            fullSrc={assetUrl(p.id, "w=1280")}
            alt={p.name}
            className="aspect-[7/9] w-full rounded-lg object-cover sm:h-36 sm:w-28"
            style={{ border: "1px solid var(--border)", background: "var(--panel)" }}
          />
          <figcaption className="flex items-center gap-1">
            <span className="muted min-w-0 flex-1 truncate text-[11px]" title={p.name}>
              {p.size ?? p.name}
            </span>
            <a href={assetUrl(p.id, "download=1")} download className="btn shrink-0 p-1.5 sm:p-1" aria-label={`Download ${p.name}`} title="Download">
              <Download className="h-3.5 w-3.5" />
            </a>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

interface CardVideo {
  src: string;
  poster?: string;
  download?: string;
  title: string;
}

const ours = (url: unknown): url is string =>
  typeof url === "string" && (url.startsWith(`${BASE_PATH}/api/reels/`) || url.startsWith(`${BASE_PATH}/api/seelie/videos/`));

/** A reel or a library video the tool made, played in its card. */
function videoOf(data: unknown): CardVideo | null {
  if (!data || typeof data !== "object" || !("video" in data)) return null;
  const { video, poster, download, title, ref } = data as Record<string, unknown>;
  if (!ours(video)) return null;
  return {
    src: video,
    ...(ours(poster) ? { poster } : {}),
    ...(ours(download) ? { download } : {}),
    title: typeof title === "string" && title.trim() ? title.trim() : typeof ref === "string" ? ref : "Seelie video",
  };
}

/** Save the video, or hand it to another app (WhatsApp, Instagram…) where the device can. */
function VideoActions({ video }: { video: CardVideo }) {
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    try {
      setCanShare(typeof navigator.canShare === "function" && navigator.canShare({ files: [new File([""], "x.mp4", { type: "video/mp4" })] }));
    } catch {
      setCanShare(false);
    }
  }, []);

  async function share() {
    setSharing(true);
    setError(null);
    try {
      const res = await fetch(video.src, { cache: "no-store" });
      if (!res.ok) throw new Error(`Couldn't fetch the video (${res.status}).`);
      const name = `${video.title.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 60) || "video"}.mp4`;
      const file = new File([await res.blob()], name, { type: "video/mp4" });
      await navigator.share({ files: [file], title: video.title });
    } catch (err) {
      // Closing the share sheet isn't a failure.
      if (!(err instanceof DOMException && err.name === "AbortError")) setError(err instanceof Error ? err.message : "Couldn't share it.");
    } finally {
      setSharing(false);
    }
  }

  if (!video.download && !canShare) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {video.download ? (
        <a href={video.download} download className="btn btn-white text-[13px]">
          <Download className="h-3.5 w-3.5" />
          Download
        </a>
      ) : null}
      {canShare ? (
        <button type="button" className="btn btn-white text-[13px]" disabled={sharing} onClick={() => void share()}>
          {sharing ? <Spinner size="0.9rem" /> : <Share2 className="h-3.5 w-3.5" />}
          Share
        </button>
      ) : null}
      {error ? <span className="text-xs" style={{ color: "var(--danger)" }}>{error}</span> : null}
    </div>
  );
}

/**
 * The approval: what will happen in plain words (anyone can approve it), whom it touches,
 * Deny and Approve, and one tap down, exactly what will run.
 */
function Approval({ row, ask, open, onToggle }: { row: ToolRow; ask: string | null; open: boolean; onToggle: () => void }) {
  const decide = useSeelie((s) => s.decide);
  return (
    // Deny and Approve share the step's width, big enough for a thumb.
    <div className={cn("space-y-2 px-3 py-2.5", open && "border-b")} style={{ borderColor: "var(--border)", background: "var(--warn-soft)" }}>
      <div>
        <p className="text-[14px] font-medium leading-snug">{ask ?? row.summary ?? row.label}</p>
        <p className="muted mt-0.5 text-xs">Seelie is asking first. {ASKS[row.kind]}</p>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" className="btn btn-white flex-1 px-3 py-2 text-[13px] sm:py-1.5" onClick={() => void decide(row, false)}>
          Deny
        </button>
        <button type="button" className="btn btn-blue flex-1 px-3 py-2 text-[13px] sm:py-1.5" onClick={() => void decide(row, true)}>
          Approve
        </button>
      </div>
      {row.kind === "write" ? (
        <button type="button" className="btn w-full px-2.5 py-2 text-xs sm:py-1.5" onClick={() => void decide(row, true, true)}>
          Always in this chat
        </button>
      ) : null}
      <button type="button" onClick={onToggle} aria-expanded={open} className="muted flex items-center gap-1 text-xs hover:text-[var(--text)]">
        {open ? "Hide the details" : "See exactly what it runs"}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
        {title}
      </p>
      {children}
    </div>
  );
}

const PRE_CHARS = 4000;

function Pre({ text, tone }: { text: string; tone?: "danger" }) {
  const [all, setAll] = useState(false);
  const long = text.length > PRE_CHARS;
  return (
    <div>
      <pre
        className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg px-2.5 py-2 font-mono text-[12px] leading-relaxed"
        style={{ background: "var(--panel)", border: "1px solid var(--border)", color: tone === "danger" ? "var(--danger)" : undefined }}
      >
        {long && !all ? `${text.slice(0, PRE_CHARS)}…` : text}
      </pre>
      {long ? (
        <button type="button" className="muted mt-1 text-xs underline" onClick={() => setAll((v) => !v)}>
          {all ? "Show less" : `Show all ${text.length.toLocaleString("en-IN")} characters`}
        </button>
      ) : null}
    </div>
  );
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

/** The call's arguments, one line each; nested values as JSON. */
function Args({ args }: { args: unknown }) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return <Pre text={JSON.stringify(args, null, 2)} />;
  const entries = Object.entries(args as Record<string, unknown>);
  if (!entries.length) return <p className="muted text-xs">Nothing.</p>;
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12.5px]">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="muted font-mono">{k}</dt>
          <dd className="min-w-0 whitespace-pre-wrap break-words">
            {typeof v === "object" && v !== null ? <span className="font-mono text-[12px]">{JSON.stringify(v, null, 2)}</span> : fmt(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** SQL's rows as a table; anything else as JSON. */
function DataView({ data }: { data: unknown }) {
  const d = data as { columns?: unknown; rows?: unknown; rowCount?: number; more?: boolean; ms?: number };
  if (d && Array.isArray(d.columns) && Array.isArray(d.rows)) {
    const columns = d.columns as string[];
    const rows = (d.rows as unknown[][]).slice(0, 200);
    return (
      <div>
        <div className="max-h-80 overflow-auto rounded-lg" style={{ border: "1px solid var(--border)", background: "var(--panel)" }}>
          <table className="w-full border-collapse text-[12px]">
            <thead className="sticky top-0">
              <tr>
                {columns.map((c) => (
                  <th key={c} className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold" style={{ background: "var(--panel-2)", color: "var(--muted)" }}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {r.map((v, j) => (
                    <td key={j} className="max-w-[18rem] truncate px-2.5 py-1 tabular-nums" style={{ borderTop: "1px solid var(--border)" }} title={fmt(v)}>
                      {fmt(v)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted mt-1 text-[11px]">
          {d.rowCount ?? rows.length} row{(d.rowCount ?? rows.length) === 1 ? "" : "s"}
          {d.more ? " (more not shown)" : ""}
          {typeof d.ms === "number" ? ` · ${d.ms} ms` : ""}
        </p>
      </div>
    );
  }
  return <Pre text={JSON.stringify(data, null, 2)} />;
}
