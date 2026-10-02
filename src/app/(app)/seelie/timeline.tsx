"use client";

import type { AssistantMessage, ImageContent, TextContent, ToolCall, ToolResultMessage } from "@paribelle/pi-ai";
import {
  AlertTriangle,
  Ban,
  Camera,
  Check,
  ChevronDown,
  Database,
  Download,
  Eraser,
  Globe,
  Hand,
  Megaphone,
  Music,
  Paperclip,
  PencilLine,
  Send,
  Share2,
  ShoppingBag,
  Sparkles,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import { ZoomImg } from "@/components/image-lightbox";
import { Spinner } from "@/components/ui";
import { BASE_PATH, withBasePath } from "@/lib/base-path";
import { ACTIVE_RUN, type ChatMessage, type HelperState, type ToolKind, type ToolRow } from "@/lib/seelie/types";
import { useSeelie, type DraftClip, type DraftImage } from "@/lib/stores/seelie-store";
import { cn } from "@/lib/utils";

import { Markdown } from "./markdown";

/**
 * The open chat: what was asked, Seelie's thinking and replies, and a card per tool
 * call, with the approval buttons on the ones waiting for a yes.
 */

type Results = Map<string, { result: ToolResultMessage; seq: number }>;

const imageUrl = (chatId: string, seq: number, index: number) => withBasePath(`/api/seelie/chats/${chatId}/images/${seq}/${index}`);

export function Timeline() {
  const chatId = useSeelie((s) => s.chatId);
  const messages = useSeelie((s) => s.messages);
  const tools = useSeelie((s) => s.tools);
  const partial = useSeelie((s) => s.partial);
  const pending = useSeelie((s) => s.pending);
  const run = useSeelie((s) => s.run);

  const results = useMemo(() => {
    const map: Results = new Map();
    for (const m of messages) if (m.message.role === "toolResult") map.set(m.message.toolCallId, { result: m.message, seq: m.seq });
    return map;
  }, [messages]);

  const active = !!run && ACTIVE_RUN.includes(run.status);
  const working = Object.values(tools).some((t) => t.runId === run?.id && (t.status === "running" || t.status === "awaiting"));
  const partialHasContent = !!partial?.content.some((c) => (c.type === "text" ? c.text : c.type === "thinking" ? c.thinking : true));

  return (
    <div className="space-y-5 pb-4">
      {messages.map((m) =>
        m.message.role === "user" ? (
          <UserBubble key={m.seq} entry={m} chatId={chatId} />
        ) : m.message.role === "assistant" ? (
          <Reply key={m.seq} message={m.message} tools={tools} results={results} chatId={chatId} />
        ) : null,
      )}
      {pending ? <UserBubble pending={pending} chatId={chatId} /> : null}
      {partial && partialHasContent ? <Reply message={partial} tools={tools} results={results} chatId={chatId} streaming /> : null}
      {active && !partialHasContent && !working ? (
        <div className="flex items-center gap-2.5 py-1">
          <Spinner size="1.1rem" />
          <span className="muted text-sm">{run.status === "waiting" ? "Waiting for your answer…" : "Seelie is working…"}</span>
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
  /** Where it plays from, for a clip or a sound. */
  src: string | null;
}

function attachmentOf(text: string): Attachment | null {
  const m = ATTACHED.exec(text.trim());
  if (!m) return null;
  try {
    const a = JSON.parse(m[1]) as { ref?: string; kind?: string; name?: string };
    const id = /^asset:(\d+)$/.exec(a.ref ?? "")?.[1];
    if (!id) return null;
    const plays = a.kind === "video" || a.kind === "audio";
    return { name: a.name ?? `asset:${id}`, kind: a.kind ?? "file", src: plays ? withBasePath(`/api/seelie/assets/${id}`) : null };
  } catch {
    return null;
  }
}

function UserBubble({ entry, pending, chatId }: { entry?: ChatMessage; pending?: { text: string; images: DraftImage[]; clips: DraftClip[] }; chatId: string | null }) {
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
    <div className={cn("flex flex-col items-end gap-1.5", pending && "opacity-80")}>
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

/* -------------------------------------------------------------------------- */
/* Seelie's reply                                                             */
/* -------------------------------------------------------------------------- */

const Reply = memo(function Reply({
  message,
  tools,
  results,
  chatId,
  streaming = false,
}: {
  message: AssistantMessage;
  tools: Record<string, ToolRow>;
  results: Results;
  chatId: string | null;
  streaming?: boolean;
}) {
  const showThinking = useSeelie((s) => s.showThinking);
  const last = message.content.length - 1;
  return (
    <div className="space-y-3">
      {message.content.map((block, i) => {
        if (block.type === "thinking") {
          if (!showThinking || !block.thinking.trim()) return null;
          return <Thinking key={i} text={block.thinking} live={streaming && i === last} />;
        }
        if (block.type === "text") return block.text.trim() ? <Markdown key={i} text={block.text} /> : null;
        if (block.name === "helpers") {
          return <HelpersCard key={block.id} call={block} row={tools[block.id]} result={results.get(block.id)} tools={tools} chatId={chatId} />;
        }
        return <ToolCard key={block.id} call={block} row={tools[block.id]} result={results.get(block.id)} chatId={chatId} />;
      })}
      {message.stopReason === "error" ? (
        <Notice tone="danger">{message.errorMessage || "The model returned an error."}</Notice>
      ) : message.stopReason === "aborted" ? (
        <p className="muted text-xs">Stopped.</p>
      ) : null}
    </div>
  );
});

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(live);
  useEffect(() => setOpen(live), [live]);
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)} className="muted flex items-center gap-1.5 text-xs font-medium hover:text-[var(--text)]">
        <Sparkles className={cn("h-3.5 w-3.5", live && "animate-pulse")} style={{ color: "var(--accent)" }} />
        {live ? "Thinking…" : "Thought it through"}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="muted mt-1.5 border-l-2 pl-3 text-[13px]" style={{ borderColor: "var(--border-strong)" }}>
          <Markdown text={text} className="text-[13px]" />
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
/* Tool cards                                                                 */
/* -------------------------------------------------------------------------- */

const KIND: Record<ToolKind, { Icon: LucideIcon; asks: string }> = {
  read: { Icon: Database, asks: "" },
  write: { Icon: PencilLine, asks: "This changes the OMS." },
  market: { Icon: ShoppingBag, asks: "This changes Amazon." },
  store: { Icon: Globe, asks: "This changes paribelle.in." },
  publish: { Icon: Send, asks: "This posts publicly." },
  spend: { Icon: Camera, asks: "This uses the image model's limited budget." },
  ads: { Icon: Megaphone, asks: "This can spend money on Meta ads." },
  forget: { Icon: Eraser, asks: "This deletes something Seelie remembers for you." },
};

function humanize(name: string) {
  return name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function duration(row: ToolRow) {
  if (!row.startedAt || !row.endedAt) return null;
  const ms = new Date(row.endedAt).getTime() - new Date(row.startedAt).getTime();
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function StatusIcon({ row }: { row: ToolRow }) {
  switch (row.status) {
    case "queued":
    case "running":
      return <Spinner size="0.95rem" />;
    case "awaiting":
      return <Hand className="h-4 w-4" style={{ color: "var(--warn)" }} />;
    case "done":
      return <Check className="h-4 w-4" style={{ color: "var(--ok)" }} />;
    case "denied":
      return <Ban className="h-4 w-4" style={{ color: "var(--muted-2)" }} />;
    case "error":
      return <X className="h-4 w-4" style={{ color: "var(--danger)" }} />;
  }
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

function ToolCard({ call, row: maybeRow, result, chatId }: { call: ToolCall; row?: ToolRow; result?: { result: ToolResultMessage; seq: number }; chatId: string | null }) {
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
  const out = readResult(result?.result);
  const video = videoOf(out?.data);
  const pictures = picturesOf(out?.data);
  const { Icon } = KIND[row.kind];
  const took = duration(row);

  return (
    <div className="surface-2 overflow-hidden" style={awaiting ? { borderColor: "color-mix(in srgb, var(--warn) 45%, transparent)" } : undefined}>
      {/* On a phone the summary goes under the name; from `sm` up, beside it. */}
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left">
        <Icon className="h-4 w-4 shrink-0" style={{ color: row.kind === "read" ? "var(--muted)" : "var(--accent-ink)" }} />
        <span className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-2.5">
          <span className="block truncate text-[13px] font-medium sm:shrink-0 sm:overflow-visible">{row.label}</span>
          <span className="muted block truncate text-xs sm:min-w-0 sm:flex-1">{row.status === "running" && row.progress ? row.progress : row.summary}</span>
        </span>
        {took ? <span className="shrink-0 text-[11px] tabular-nums" style={{ color: "var(--muted-2)" }}>{took}</span> : null}
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          <StatusIcon row={row} />
        </span>
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-180")} style={{ color: "var(--muted-2)" }} />
      </button>

      {awaiting ? <Approval row={row} /> : null}

      {video ? (
        <div className="px-3 pb-3">
          <video src={video.src} poster={video.poster} controls playsInline preload="metadata" className="max-h-[28rem] w-auto max-w-full rounded-xl bg-black" />
          <VideoActions video={video} />
        </div>
      ) : null}

      {pictures.length ? <Pictures pictures={pictures} /> : null}

      {open || awaiting ? (
        <div className="space-y-2.5 border-t px-3 py-2.5" style={{ borderColor: "var(--border)" }}>
          <Section title={awaiting ? "What it will do" : "Asked"}>
            <Args args={row.args} />
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
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers: parts of a request worked on at the same time                      */
/* -------------------------------------------------------------------------- */

const HELPER_ICON: Record<HelperState["status"], React.ReactNode> = {
  working: <Spinner size="0.95rem" />,
  done: <Check className="h-4 w-4" style={{ color: "var(--ok)" }} />,
  error: <X className="h-4 w-4" style={{ color: "var(--danger)" }} />,
  stopped: <Ban className="h-4 w-4" style={{ color: "var(--muted-2)" }} />,
};

/** A helpers call: each helper with its model, how it's doing, its steps (asking like any other) and its answer. */
function HelpersCard({
  call,
  row,
  result,
  tools,
  chatId,
}: {
  call: ToolCall;
  row?: ToolRow;
  result?: { result: ToolResultMessage; seq: number };
  tools: Record<string, ToolRow>;
  chatId: string | null;
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
  const shown = row ?? { status: result ? (result.result.isError ? "error" : "done") : "queued", summary: null, progress: null };
  const took = row ? duration(row) : null;

  return (
    <div className="surface-2 overflow-hidden">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left">
        <Users className="h-4 w-4 shrink-0" style={{ color: "var(--accent-ink)" }} />
        <span className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-2.5">
          <span className="block truncate text-[13px] font-medium sm:shrink-0 sm:overflow-visible">Helpers</span>
          <span className="muted block truncate text-xs sm:min-w-0 sm:flex-1">
            {live && shown.progress ? shown.progress : `${helpers.length} at once: ${helpers.map((h) => h.title).join(", ")}`}
          </span>
        </span>
        {took ? <span className="shrink-0 text-[11px] tabular-nums" style={{ color: "var(--muted-2)" }}>{took}</span> : null}
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">{row ? <StatusIcon row={row} /> : live ? <Spinner size="0.95rem" /> : null}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-180")} style={{ color: "var(--muted-2)" }} />
      </button>
      <div className="space-y-3 border-t px-3 py-2.5" style={{ borderColor: "var(--border)" }}>
        {helpers.map((h, i) => (
          <Helper
            key={i}
            helper={h.status === "working" && !live ? { ...h, status: "stopped" } : h}
            steps={steps.filter((t) => t.helper === i)}
            open={open}
            chatId={chatId}
          />
        ))}
      </div>
    </div>
  );
}

function Helper({ helper: h, steps, open, chatId }: { helper: HelperState; steps: ToolRow[]; open: boolean; chatId: string | null }) {
  const [answer, setAnswer] = useState(false);
  // Steps show while it works, when one waits for an answer, and when the card is opened.
  const showSteps = open || h.status === "working" || steps.some((t) => t.status === "awaiting");
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">{HELPER_ICON[h.status]}</span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{h.title}</span>
        {h.model ? (
          <span className="muted hidden shrink-0 text-[11px] sm:inline">
            {h.model}
            {h.thinking ? ` · ${h.thinking}` : ""}
          </span>
        ) : null}
        {!showSteps && steps.length ? <span className="muted shrink-0 text-[11px]">{steps.length === 1 ? "1 step" : `${steps.length} steps`}</span> : null}
        {h.answer ? (
          <button type="button" onClick={() => setAnswer((v) => !v)} className="muted flex shrink-0 items-center gap-0.5 text-xs hover:text-[var(--text)]">
            Answer
            <ChevronDown className={cn("h-3 w-3 transition-transform", answer && "rotate-180")} />
          </button>
        ) : null}
      </div>
      {showSteps && steps.length ? (
        <div className="ml-[7px] mt-1.5 space-y-1.5 border-l-2 pl-3" style={{ borderColor: "var(--border)" }}>
          {steps.map((t) => (
            <ToolCard
              key={t.callId}
              call={{ type: "toolCall", id: t.callId, name: t.tool, arguments: (t.args ?? {}) as ToolCall["arguments"] }}
              row={t}
              result={t.result ? { result: t.result, seq: -1 } : undefined}
              chatId={chatId}
            />
          ))}
        </div>
      ) : null}
      {answer && h.answer ? (
        <div className="muted ml-[7px] mt-1.5 border-l-2 pl-3" style={{ borderColor: "var(--border-strong)" }}>
          <Markdown text={h.answer} className="text-[13px]" />
        </div>
      ) : null}
    </div>
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

/** What a photo tool made, each with Download (the full file). */
function Pictures({ pictures }: { pictures: CardPicture[] }) {
  return (
    // Three across a phone's width; fixed-size tiles from `sm` up.
    <div className="grid grid-cols-3 gap-2 px-3 pb-3 sm:flex sm:flex-wrap sm:gap-2.5">
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

function Approval({ row }: { row: ToolRow }) {
  const decide = useSeelie((s) => s.decide);
  return (
    // On a phone Deny and Approve share the card's width, big enough for a thumb.
    <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2.5" style={{ borderColor: "var(--border)", background: "var(--warn-soft)" }}>
      <p className="min-w-0 basis-full text-[13px] sm:flex-1">
        <span className="font-medium">Seelie is asking first.</span> <span className="muted">{KIND[row.kind].asks}</span>
      </p>
      <div className="flex w-full items-center gap-2 sm:w-auto sm:shrink-0 sm:flex-wrap">
        {row.kind === "write" ? (
          <button type="button" className="btn shrink-0 px-2.5 py-2 text-xs sm:py-1.5" onClick={() => void decide(row, true, true)}>
            Always in this chat
          </button>
        ) : null}
        <button type="button" className="btn btn-white flex-1 px-3 py-2 text-[13px] sm:flex-none sm:py-1.5" onClick={() => void decide(row, false)}>
          Deny
        </button>
        <button type="button" className="btn btn-blue flex-1 px-3 py-2 text-[13px] sm:flex-none sm:py-1.5" onClick={() => void decide(row, true)}>
          Approve
        </button>
      </div>
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
