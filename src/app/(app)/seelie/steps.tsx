"use client";

import type { ToolCall } from "@paribelle/pi-ai";
import { Check, ChevronDown, CornerDownRight, RotateCw } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { ZoomImg } from "@/components/image-lightbox";
import { withBasePath } from "@/lib/base-path";
import type { HelperState, ToolKind, ToolRow } from "@/lib/seelie/types";
import { cn } from "@/lib/utils";

import { ApprovalCard } from "./cards";
import { Markdown } from "./markdown";
import { Documents, Pictures, VideoBlock } from "./media";
import { foldLookups, madeBy, PLACE, percentOf, readResult, resultOf, retries, rowFor, splitAsk, took, userText, type Item, type Results, type Shown, type StepState } from "./turns";

/**
 * A job's steps as lines, the way Claude Code shows them: a dot, the tool and what it was
 * asked, where it changed something, how long it took, and under it the outcome (a progress
 * bar while it runs, the error if it failed). Lookups in a row fold into one line; a step
 * waiting for a yes is its approval card.
 */

const imageUrl = (chatId: string, seq: number, index: number) => withBasePath(`/api/seelie/chats/${chatId}/images/${seq}/${index}`);

/** Where a change lands: OMS, Amazon, paribelle.in, Instagram… */
export function KindTag({ kind }: { kind: ToolKind }) {
  const place = PLACE[kind];
  if (!place) return null;
  return <span className={cn("sl-kt", kind === "store" && "k-store", (kind === "publish" || kind === "ads" || kind === "spend") && "k-ask")}>{place}</span>;
}

export function Bar({ pct, className }: { pct: number; className?: string }) {
  return (
    <span className={cn("sl-bar", className)}>
      <i style={{ width: `${Math.round(pct * 100)}%` }} />
    </span>
  );
}

/** A plan step's mark. */
export function PlanIcon({ state, small }: { state: StepState; small?: boolean }) {
  return (
    <span className={cn("sl-pi", state, small && "xs")} aria-label={state}>
      {state === "done" ? <Check className={small ? "h-2 w-2" : "h-2.5 w-2.5"} strokeWidth={3.4} /> : state === "ask" ? <span className="text-[10px] font-bold">!</span> : null}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Lines                                                                      */
/* -------------------------------------------------------------------------- */

interface Ctx {
  tools: Record<string, ToolRow>;
  results: Results;
  chatId: string | null;
}

/** A list of steps: lookups folded, retries marked. */
export function ItemLines({ items, ctx, className }: { items: Item[]; ctx: Ctx; className?: string }) {
  const shown: Shown[] = foldLookups(items, ctx.tools, ctx.results);
  const again = retries(items, ctx.tools);
  if (!shown.length) return null;
  return (
    <ul className={cn("sl-tls", className)}>
      {shown.map((s) => {
        switch (s.type) {
          case "lookups":
            return <LookupsLine key={s.key} items={s.items} ctx={ctx} />;
          case "tool":
            return s.call.name === "helpers" ? <HelpersLine key={s.key} call={s.call} ctx={ctx} /> : <ToolLine key={s.key} call={s.call} ctx={ctx} retry={again.has(s.call.id)} />;
          case "thinking":
            return (
              <li key={s.key}>
                <ThoughtLine text={s.text} ms={s.ms} live={s.live} />
              </li>
            );
          case "text":
            return (
              <li key={s.key} className="sl-say">
                <Markdown text={s.text} className="text-[13px]" />
              </li>
            );
          case "steer":
            return (
              <li key={s.key}>
                <SteerBubble text={s.entry ? userText(s.entry) : (s.pending?.text ?? "")} sending={!!s.pending} />
              </li>
            );
          case "error":
            return (
              <li key={s.key} className="sl-tl">
                <span className="sl-dot error" />
                <p className="text-[12.5px] leading-5" style={{ color: "var(--danger)" }}>
                  {s.text}
                </p>
              </li>
            );
          case "stopped":
            return (
              <li key={s.key} className="sl-tl">
                <span className="sl-dot denied" />
                <p className="muted text-[12.5px] leading-5">Stopped.</p>
              </li>
            );
        }
      })}
    </ul>
  );
}

/** A message the owner sent while Seelie worked, where Seelie read it. */
export function SteerBubble({ text, sending }: { text: string; sending?: boolean }) {
  return (
    <div className="flex items-start gap-1.5 text-[12.5px]">
      <CornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: "var(--accent)" }} />
      <span className="sl-steer">
        {text || "Photos"}
        <span className="ml-1.5 text-[10.5px] opacity-75">{sending ? "sending…" : "you, while it worked"}</span>
      </span>
    </div>
  );
}

/** "Thought for 12 s", opening to the thinking when it's shown. */
export const ThoughtLine = memo(function ThoughtLine({ text, ms, live }: { text: string; ms: number | null; live: boolean }) {
  const [open, setOpen] = useState(false);
  const [since] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live]);
  const secs = ms !== null ? Math.max(1, Math.round(ms / 1000)) : live ? Math.round((Date.now() - since) / 1000) : null;
  const label = live ? `Thinking…${secs ? ` ${secs} s` : ""}` : secs ? `Thought for ${secs} s` : "Thought it through";
  return (
    <div>
      <button type="button" className="sl-thought" onClick={() => text && setOpen((v) => !v)} aria-expanded={open} disabled={!text}>
        <span className={live ? "sl-shimmer" : undefined}>{label}</span>
        {text ? <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} /> : null}
      </button>
      {open && text ? (
        <div className="sl-thought-text">
          <Markdown text={text} className="text-[13px]" />
        </div>
      ) : null}
    </div>
  );
});

/** What a step was asked and what came back, for whoever wants it all. */
export function Details({ row, ctx }: { row: ToolRow; ctx?: Ctx }) {
  const { ask, rest } = splitAsk(row.args);
  const result = ctx ? resultOf(row.callId, ctx.results, ctx.tools) : null;
  const out = readResult(result);
  const seq = ctx?.results.get(row.callId)?.seq;
  return (
    <div className="surface-2 space-y-2.5 px-3 py-2.5">
      <Section title={row.status === "awaiting" ? "Exactly what it runs" : "Asked"}>
        {ask && row.summary ? <p className="mb-1.5 break-words font-mono text-[12px]">{row.summary}</p> : null}
        <Args args={rest} />
      </Section>
      {row.status === "denied" ? <p className="muted text-xs">Not allowed{row.decidedBy ? ` by ${row.decidedBy}` : ""}.</p> : null}
      {row.approval === "approved" && row.decidedBy ? <p className="muted text-xs">Approved by {row.decidedBy}.</p> : null}
      {out ? (
        <Section title={out.isError ? "Error" : "Result"}>
          {out.text ? <Pre text={out.text} tone={out.isError ? "danger" : undefined} /> : null}
          {out.data !== undefined ? <DataView data={out.data} /> : null}
          {out.images.length && ctx?.chatId && seq !== undefined && seq >= 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {out.images.map(({ index }) => (
                <ZoomImg key={index} src={imageUrl(ctx.chatId!, seq, index)} alt={`Image ${index}`} className="h-24 w-24 rounded-lg object-cover" />
              ))}
            </div>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}

/** One tool call: its line, its outcome, what it made, and (opened) the details. */
export const ToolLine = memo(function ToolLine({ call, ctx, retry }: { call: ToolCall; ctx: Ctx; retry?: boolean }) {
  const row = rowFor(call, ctx.tools, ctx.results);
  const [open, setOpen] = useState(false);
  if (row.status === "awaiting") {
    return (
      <li>
        <ApprovalCard row={row} />
      </li>
    );
  }
  const { ask } = splitAsk(row.args);
  const out = readResult(resultOf(call.id, ctx.results, ctx.tools));
  const made = madeBy([{ type: "tool", key: call.id, call }], ctx.results, ctx.tools);
  const pct = row.status === "running" ? percentOf(row.progress) : null;
  const error = row.status === "error" ? (out?.text.split("\n").find((l) => l.trim()) ?? "It failed.") : null;
  const line = row.status === "denied" ? "You said not now." : (ask ?? row.summary);
  return (
    <li className="sl-tl">
      <span className={cn("sl-dot", row.status)} />
      <div className="min-w-0">
        <button type="button" className="sl-tl-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <b>{row.label}</b>
          {line ? <span className="sl-arg">{line}</span> : null}
          <KindTag kind={row.kind} />
          {retry ? (
            <span className="sl-kt">
              <RotateCw className="h-2.5 w-2.5" /> Retry
            </span>
          ) : null}
          {row.status !== "running" && took(row) ? <span className="sl-took">{took(row)}</span> : null}
          <ChevronDown className={cn("sl-chev h-3 w-3 transition-transform", open && "rotate-180")} />
        </button>
        {row.status === "running" ? (
          <div className="sl-prog">
            <span className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">{row.progress ?? "Working…"}</span>
              {pct !== null ? <span className="tabular-nums">{Math.round(pct * 100)}%</span> : null}
            </span>
            {pct !== null ? <Bar pct={pct} /> : null}
          </div>
        ) : error ? (
          <div className="sl-res err">
            <span className="line-clamp-2">{error}</span>
          </div>
        ) : null}
        {made.videos.map((v) => (
          <div key={v.src} className="mt-2">
            <VideoBlock video={v} size="sm" />
          </div>
        ))}
        {made.pictures.length ? <Pictures pictures={made.pictures} small /> : null}
        {made.documents.length ? <Documents documents={made.documents} /> : null}
        {open ? (
          <div className="mt-2">
            <Details row={row} ctx={ctx} />
          </div>
        ) : null}
      </div>
    </li>
  );
});

/** Reads in a row as one line: "Looked up 4 things", opening to each. */
function LookupsLine({ items, ctx }: { items: Extract<Item, { type: "tool" }>[]; ctx: Ctx }) {
  const [open, setOpen] = useState(false);
  const rows = items.map((it) => rowFor(it.call, ctx.tools, ctx.results));
  const running = rows.some((r) => r.status === "running" || r.status === "queued");
  const labels = [...new Set(rows.map((r) => r.label))];
  return (
    <li className="sl-tl">
      <span className={cn("sl-dot", running ? "running" : "done")} />
      <div className="min-w-0">
        <button type="button" className="sl-tl-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <b>{running ? `Looking up ${items.length} things…` : `Looked up ${items.length} things`}</b>
          {!open ? <span className="sl-arg">{labels.join(", ")}</span> : null}
          <ChevronDown className={cn("sl-chev h-3 w-3 transition-transform", open && "rotate-180")} />
        </button>
        {open ? (
          <ul className="sl-tls mt-2">
            {items.map((it) => (
              <ToolLine key={it.key} call={it.call} ctx={ctx} />
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

const HELPER_DOT: Record<HelperState["status"], string> = { working: "running", done: "done", error: "error", stopped: "denied" };

/** A helpers call: each helper with its model, its latest step while it works and its answer once done. */
function HelpersLine({ call, ctx }: { call: ToolCall; ctx: Ctx }) {
  const row = ctx.tools[call.id];
  const result = ctx.results.get(call.id);
  const [open, setOpen] = useState(false);
  const live = !result && (!row || row.status === "running" || row.status === "queued");
  const jobs = ((call.arguments as { jobs?: { title?: string; thinking?: string }[] }).jobs ?? []).filter(Boolean);
  const fromResult = (result?.result.details as { helpers?: HelperState[] } | undefined)?.helpers;
  const helpers: HelperState[] =
    row?.helpers ?? fromResult ?? jobs.map((j) => ({ title: j.title ?? "Helper", model: "", thinking: j.thinking ?? "", status: live ? "working" : "stopped", answer: null }));
  const steps = Object.values(ctx.tools).filter((t) => t.parent === call.id);
  return (
    <li className="sl-tl">
      <span className={cn("sl-dot", live ? "running" : row?.status === "error" ? "error" : "done")} />
      <div className="min-w-0">
        <button type="button" className="sl-tl-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <b>Helpers</b>
          <span className="sl-arg">{helpers.length === 1 ? "1 helper" : `${helpers.length} at once`}</span>
          {row && !live && took(row) ? <span className="sl-took">{took(row)}</span> : null}
          <ChevronDown className={cn("sl-chev h-3 w-3 transition-transform", open && "rotate-180")} />
        </button>
        <ul className="sl-helpers">
          {helpers.map((h, i) => {
            const own = steps.filter((t) => t.helper === i);
            const asking = own.filter((t) => t.status === "awaiting");
            const latest = own.filter((t) => t.status !== "awaiting").at(-1);
            const status = h.status === "working" && !live ? "stopped" : h.status;
            return (
              <li key={i}>
                <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                  <span className={cn("sl-dot sm", HELPER_DOT[status])} />
                  <b className="font-semibold">{h.title}</b>
                  {h.model ? <span className="sl-arg">{h.model}</span> : null}
                </div>
                {asking.map((t) => (
                  <div key={t.callId} className="mt-1.5">
                    <ApprovalCard row={t} />
                  </div>
                ))}
                {open ? (
                  <ul className="sl-tls mt-1.5">
                    {own.map((t) => (
                      <ToolLine key={t.callId} call={{ type: "toolCall", id: t.callId, name: t.tool, arguments: (t.args ?? {}) as ToolCall["arguments"] }} ctx={ctx} />
                    ))}
                  </ul>
                ) : status === "working" && latest ? (
                  <div className="sl-res">
                    {latest.label}
                    {latest.status === "running" ? `${latest.progress ? `: ${latest.progress}` : "…"}` : ""}
                  </div>
                ) : h.answer ? (
                  <div className="sl-res">
                    <span className="line-clamp-2">{h.answer.replace(/\s+/g, " ")}</span>
                  </div>
                ) : null}
                {open && h.answer ? (
                  <div className="surface-2 muted mt-1.5 px-2.5 py-2">
                    <Markdown text={h.answer} className="text-[13px]" />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Details                                                                    */
/* -------------------------------------------------------------------------- */

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
          <dd className="min-w-0 whitespace-pre-wrap break-words">{typeof v === "object" && v !== null ? <span className="font-mono text-[12px]">{JSON.stringify(v, null, 2)}</span> : fmt(v)}</dd>
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
