import type { AssistantMessage, ImageContent, TextContent, ToolCall, ToolResultMessage } from "@paribelle/pi-ai";

import { BASE_PATH } from "@/lib/base-path";
import { ACTIVE_RUN, PLAN_TOOL, STEER_NOTE, type ChatMessage, type PlanArgs, type PlanStepStatus, type RunInfo, type ThinkingTimes, type ToolKind, type ToolRow } from "@/lib/seelie/types";
import type { PendingSend } from "@/lib/stores/seelie-store";

/**
 * The chat as the screen draws it, worked out once per change (no React here): each request
 * with everything Seelie did for it (its thoughts, tool calls, what it said between them,
 * messages sent while it worked), its plan with each call under the step it belongs to, what
 * it made and changed, and the reply it closed with.
 */

export type Results = Map<string, { result: ToolResultMessage; seq: number }>;

export type Item =
  | { type: "thinking"; key: string; text: string; ms: number | null; live: boolean }
  | { type: "tool"; key: string; call: ToolCall }
  | { type: "text"; key: string; text: string }
  /** A message the owner sent while Seelie worked. */
  | { type: "steer"; key: string; entry?: ChatMessage; pending?: PendingSend }
  | { type: "error"; key: string; text: string }
  | { type: "stopped"; key: string };

/** A plan step as drawn: its own state, "ask" while one of its calls waits for a yes, "ended" if the reply ended on it. */
export type StepState = PlanStepStatus | "ask" | "ended";

export interface JobStep {
  text: string;
  short: string;
  state: StepState;
  asks: boolean;
  items: Item[];
}

export interface Plan {
  title: string | null;
  steps: JobStep[];
  next: string[];
  /** Steps done or skipped. */
  finished: number;
}

export interface Turn {
  key: string;
  ask: { entry?: ChatMessage; pending?: PendingSend } | null;
  runId: string | null;
  /** Everything after the request, in order (plan calls left out: they're the plan). */
  items: Item[];
  /** Up to the last step (the job), and the closing reply after it. */
  work: Item[];
  /** The assistant message it ends with (seq null while it's being written). */
  reply: { text: string; seq: number | null } | null;
  plan: Plan | null;
  /** Tool calls made (helpers' own steps included). */
  calls: number;
  live: boolean;
  /** How it ended, for a turn that has. */
  ended: "done" | "stopped" | "error" | null;
  startedAt: number | null;
  endedAt: number | null;
  /** Seconds thought, all blocks together. */
  thoughtMs: number;
}

/* -------------------------------------------------------------------------- */
/* Building turns                                                             */
/* -------------------------------------------------------------------------- */

const isPlan = (c: ToolCall) => c.name === PLAN_TOOL;

function planArgs(c: ToolCall): PlanArgs | null {
  const a = c.arguments as Partial<PlanArgs> | undefined;
  if (!a || !Array.isArray(a.steps) || !a.steps.length) return null;
  const steps = a.steps
    .filter((s) => s && typeof s.text === "string")
    .map((s) => ({ text: s.text, short: typeof s.short === "string" ? s.short : undefined, status: (["pending", "active", "done", "skipped"] as const).includes(s.status) ? s.status : "pending", asks: s.asks === true }));
  if (!steps.length) return null;
  return { title: typeof a.title === "string" ? a.title : undefined, steps, next: Array.isArray(a.next) ? a.next.filter((n): n is string => typeof n === "string" && !!n.trim()) : [] };
}

/** The step the work after a plan call belongs to: the active one, else the first not done. */
function activeIndex(p: PlanArgs) {
  const active = p.steps.findIndex((s) => s.status === "active");
  if (active >= 0) return active;
  const open = p.steps.findIndex((s) => s.status === "pending");
  return open >= 0 ? open : p.steps.length - 1;
}

/** A message sent mid-reply, as typed: the note for the model is left out. */
export function userText(entry: ChatMessage): string {
  const m = entry.message;
  if (m.role !== "user") return "";
  if (typeof m.content === "string") return m.content;
  return m.content
    .filter((c): c is TextContent => c.type === "text" && c.text !== STEER_NOTE)
    .map((c) => c.text)
    .join("\n");
}

export interface TurnInput {
  messages: ChatMessage[];
  tools: Record<string, ToolRow>;
  partial: AssistantMessage | null;
  pending: PendingSend | null;
  steering: PendingSend | null;
  run: RunInfo | null;
  showThinking: boolean;
}

export function buildTurns({ messages, tools, partial, pending, steering, run, showThinking }: TurnInput): Turn[] {
  const turns: Turn[] = [];
  // Set in `open` (a closure), so not narrowed to null here.
  let turn = null as Turn | null;
  // The plan as it stands in the current turn, and which step the work is on.
  let plan: PlanArgs | null = null;
  let stepOf = new Map<string, number>();
  let at = 0;

  // Each turn's latest plan and the step each of its items went under.
  const plans = new Map<Turn, { plan: PlanArgs; stepOf: Map<string, number> }>();

  const open = (ask: Turn["ask"], runId: string | null, key: string) => {
    turn = { key, ask, runId, items: [], work: [], reply: null, plan: null, calls: 0, live: false, ended: null, startedAt: null, endedAt: null, thoughtMs: 0 };
    turns.push(turn);
    plan = null;
    stepOf = new Map();
    at = 0;
  };

  const add = (item: Item) => {
    if (!turn) open(null, null, `t:${item.key}`);
    turn!.items.push(item);
    stepOf.set(item.key, at);
  };

  const reply = (message: AssistantMessage, seq: number | null, streaming: boolean) => {
    const calls = message.content.filter((c): c is ToolCall => c.type === "toolCall");
    const updates = calls.filter(isPlan).map(planArgs).filter((p): p is PlanArgs => p !== null);
    // The message's own plan update says where its work goes (its thinking included).
    if (updates.length) {
      plan = updates[updates.length - 1];
      at = activeIndex(plan);
    }
    const times = (message as AssistantMessage & ThinkingTimes).thinkingMs ?? {};
    const end = message.content.length - 1;
    const id = seq ?? "live";
    message.content.forEach((block, i) => {
      if (block.type === "thinking") {
        const ms = typeof times[i] === "number" ? times[i] : null;
        if (turn && ms) turn.thoughtMs += ms;
        const live = streaming && i === end;
        // "Thought for 12 s" shows even when the thinking itself is hidden; its words only with the toggle on.
        const text = showThinking ? block.thinking : "";
        if (text.trim() || live || ms) add({ type: "thinking", key: `${id}:${i}`, text, ms, live });
      } else if (block.type === "text") {
        if (block.text.trim()) add({ type: "text", key: `${id}:${i}`, text: block.text });
      } else if (!isPlan(block)) {
        add({ type: "tool", key: block.id, call: block });
      }
    });
    if (message.stopReason === "error") add({ type: "error", key: `${id}:error`, text: message.errorMessage || "The model returned an error." });
    else if (message.stopReason === "aborted") add({ type: "stopped", key: `${id}:stopped` });
    if (turn && plan) plans.set(turn, { plan, stepOf });
  };

  for (const m of messages) {
    const role = m.message.role;
    if (role === "user") {
      const current = turn as Turn | null;
      if (current && m.runId && current.runId === m.runId) add({ type: "steer", key: `s:${m.seq}`, entry: m });
      else open({ entry: m }, m.runId, `u:${m.seq}`);
    } else if (role === "assistant") {
      reply(m.message as AssistantMessage, m.seq, false);
    }
  }
  if (pending) open({ pending }, null, "pending");
  else if (steering) add({ type: "steer", key: "steering", pending: steering });
  if (partial) reply(partial, null, true);

  const activeRun = run && ACTIVE_RUN.includes(run.status) ? run : null;
  turns.forEach((t, i) => {
    const p = plans.get(t);
    if (p) t.plan = finishPlan(p.plan, t, p.stepOf);
    finishTurn(t, tools, i === turns.length - 1 && (!!activeRun || !!pending), run);
  });
  return turns;
}

function finishPlan(p: PlanArgs, turn: Turn, stepOf: Map<string, number>): Plan {
  const steps: JobStep[] = p.steps.map((s) => ({ text: s.text, short: s.short?.trim() || shortOf(s.text), state: s.status, asks: s.asks === true, items: [] }));
  for (const item of turn.items) {
    const i = Math.min(stepOf.get(item.key) ?? 0, steps.length - 1);
    steps[i].items.push(item);
  }
  return { title: p.title?.trim() || null, steps, next: p.next ?? [], finished: steps.filter((s) => s.state === "done" || s.state === "skipped").length };
}

/** One or two words for the phone's progress bar when the plan gave none. */
function shortOf(text: string) {
  const words = text.replace(/[^\p{L}\p{N}\s-]/gu, "").split(/\s+/).filter(Boolean);
  return words.slice(0, 2).join(" ") || text.slice(0, 12);
}

function finishTurn(t: Turn, tools: Record<string, ToolRow>, live: boolean, run: RunInfo | null) {
  t.live = live;
  if (!t.runId && live && run) t.runId = run.id;
  // The work is everything up to the last step; Seelie's words after it are the reply.
  let last = -1;
  t.items.forEach((it, i) => {
    if (it.type === "tool" || it.type === "steer") last = i;
  });
  const tail = t.items.slice(last + 1);
  const texts = tail.filter((it): it is Extract<Item, { type: "text" }> => it.type === "text");
  t.work = [...t.items.slice(0, last + 1), ...tail.filter((it) => it.type !== "text")];
  t.reply = texts.length ? { text: texts.map((x) => x.text).join("\n\n"), seq: Number(texts[texts.length - 1].key.split(":")[0]) || null } : null;
  if (t.plan && texts.length) {
    const said = new Set(texts.map((x) => x.key));
    for (const step of t.plan.steps) step.items = step.items.filter((it) => !said.has(it.key));
  }

  const ids = new Set(t.items.flatMap((it) => (it.type === "tool" ? [it.call.id] : [])));
  const rows = Object.values(tools).filter((r) => ids.has(r.callId) || (r.parent ? ids.has(r.parent) : false));
  t.calls = ids.size + rows.filter((r) => r.parent).length;
  const starts = rows.flatMap((r) => (r.startedAt ? [Date.parse(r.startedAt)] : []));
  const ends = rows.flatMap((r) => (r.endedAt ? [Date.parse(r.endedAt)] : []));
  const asked = t.ask?.entry ? Date.parse(t.ask.entry.createdAt) : null;
  t.startedAt = asked ?? (starts.length ? Math.min(...starts) : null);
  t.endedAt = live ? null : ends.length ? Math.max(...ends) : null;

  const stopped = t.items.some((it) => it.type === "stopped");
  const failed = t.items.some((it) => it.type === "error");
  t.ended = live ? null : stopped ? "stopped" : failed ? "error" : "done";

  if (t.plan) {
    for (const step of t.plan.steps) {
      const waiting = step.items.some((it) => it.type === "tool" && (tools[it.call.id]?.status === "awaiting" || rows.some((r) => r.parent === it.call.id && r.status === "awaiting")));
      if (waiting) step.state = "ask";
      else if (!live && step.state === "active") step.state = "ended";
    }
  }
}

/* -------------------------------------------------------------------------- */
/* What's happening now                                                       */
/* -------------------------------------------------------------------------- */

export interface Now {
  text: string;
  /** 0-1, when the running step says how far it is. */
  pct: number | null;
  asking: ToolRow | null;
}

/** How far a progress line says it is: "Rendering 40%", "Saving 3 of 8". */
export function percentOf(progress: string | null | undefined): number | null {
  if (!progress) return null;
  const pct = /(\d{1,3}(?:\.\d+)?)\s?%/.exec(progress);
  if (pct) return Math.min(1, Number(pct[1]) / 100);
  const of = /\b(\d+)\s+of\s+(\d+)\b/.exec(progress);
  if (of && Number(of[2]) > 0) return Math.min(1, Number(of[1]) / Number(of[2]));
  return null;
}

/** The rows of a turn's calls, helpers' steps included. */
export function rowsOf(turn: Turn, tools: Record<string, ToolRow>): ToolRow[] {
  const ids = new Set(turn.items.flatMap((it) => (it.type === "tool" ? [it.call.id] : [])));
  return Object.values(tools).filter((r) => ids.has(r.callId) || (r.parent ? ids.has(r.parent) : false));
}

export function nowOf(turn: Turn, tools: Record<string, ToolRow>): Now {
  const rows = rowsOf(turn, tools);
  const asking = rows.find((r) => r.status === "awaiting");
  if (asking) return { text: `Waiting for your OK: ${asking.label}`, pct: null, asking };
  const running = rows.filter((r) => r.status === "running" && r.tool !== "helpers").sort((a, b) => Date.parse(b.startedAt ?? "0") - Date.parse(a.startedAt ?? "0"))[0];
  const helpers = rows.find((r) => r.status === "running" && r.tool === "helpers");
  const busy = running ?? helpers;
  if (busy) return { text: `${busy.label}${busy.progress ? ` · ${busy.progress}` : ""}`, pct: percentOf(busy.progress), asking: null };
  const lastItem = turn.items[turn.items.length - 1];
  if (lastItem?.type === "thinking" && lastItem.live) return { text: "Thinking…", pct: null, asking: null };
  if (turn.live && turn.reply && lastItem?.type === "text") return { text: "Writing the reply…", pct: null, asking: null };
  return { text: "Working…", pct: null, asking: null };
}

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

/** What the tool returned: the text, and the data parsed back out of its last line. */
export function readResult(result: ToolResultMessage | undefined | null) {
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

/** A tool call's result: from the chat, or (a helper's step) from its row. */
export function resultOf(callId: string, results: Results, tools: Record<string, ToolRow>) {
  return results.get(callId)?.result ?? tools[callId]?.result ?? null;
}

/** A change's plain one-liner (the model's `ask`), and the arguments the tool itself takes. */
export function splitAsk(args: unknown): { ask: string | null; rest: unknown } {
  if (!args || typeof args !== "object" || Array.isArray(args) || !("ask" in args)) return { ask: null, rest: args };
  const { ask, ...rest } = args as Record<string, unknown>;
  return { ask: typeof ask === "string" && ask.trim() ? ask.trim() : null, rest };
}

export function humanize(name: string) {
  return name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** A row for a call the server hasn't sent one for (yet). */
export function rowFor(call: ToolCall, tools: Record<string, ToolRow>, results: Results): ToolRow {
  return (
    tools[call.id] ?? {
      runId: "",
      callId: call.id,
      tool: call.name,
      label: humanize(call.name),
      kind: "read",
      args: call.arguments,
      summary: null,
      status: results.get(call.id) ? (results.get(call.id)!.result.isError ? "error" : "done") : "queued",
      approval: null,
      decidedBy: null,
      decidedAt: null,
      startedAt: null,
      endedAt: null,
    }
  );
}

/** "12 s", "4 min", "1 h 5 min". */
export function lasted(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function took(row: ToolRow) {
  if (!row.startedAt || !row.endedAt) return null;
  const ms = Date.parse(row.endedAt) - Date.parse(row.startedAt);
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** Where a change lands, for its tag. */
export const PLACE: Record<ToolKind, string | null> = {
  read: null,
  write: "OMS",
  market: "Amazon",
  store: "paribelle.in",
  publish: "Instagram",
  spend: "Image budget",
  ads: "Meta ads",
  forget: "Memory",
};

/* -------------------------------------------------------------------------- */
/* What a job made                                                            */
/* -------------------------------------------------------------------------- */

export interface CardPicture {
  id: number;
  name: string;
  size?: string;
  /** What it was made from (asset:12, chat:2), for before and after. */
  from?: string;
}

export interface CardDocument {
  id: number;
  name: string;
  pages?: number;
  kb?: number;
  locked?: boolean;
}

export interface CardVideo {
  src: string;
  poster?: string;
  download?: string;
  title: string;
  /** video:12@3, for notes on it. */
  ref?: string;
  id?: number;
  liked?: boolean | null;
}

/** Sources of the pictures Seelie made (not the photos it was given, nor masks). */
const MADE = new Set(["photoshoot", "edited", "generated", "cutout"]);

/** The pictures a photo tool made, anywhere in its result (photo_edit's list, a shoot's results, a model sheet). */
export function picturesOf(data: unknown): CardPicture[] {
  const found = new Map<number, CardPicture>();
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || depth > 4 || found.size >= 24) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    const id = typeof o.ref === "string" ? /^asset:(\d+)$/.exec(o.ref)?.[1] : undefined;
    if (id && o.kind === "image" && typeof o.source === "string" && MADE.has(o.source)) {
      const from = typeof o.from === "string" ? o.from : Array.isArray(o.from) && typeof o.from[0] === "string" ? o.from[0] : undefined;
      found.set(Number(id), {
        id: Number(id),
        name: typeof o.name === "string" ? o.name : (o.ref as string),
        ...(typeof o.size === "string" ? { size: o.size } : {}),
        ...(from && /^(asset|chat):\d+$/.test(from) ? { from } : {}),
      });
      return;
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  walk(data, 0);
  return [...found.values()];
}

/** The PDFs a tool made, anywhere in its result (one, or a split's list). */
export function documentsOf(data: unknown): CardDocument[] {
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

const ours = (url: unknown): url is string =>
  typeof url === "string" && (url.startsWith(`${BASE_PATH}/api/reels/`) || url.startsWith(`${BASE_PATH}/api/seelie/videos/`));

/** A reel or a library video the tool made, played in its card. */
export function videoOf(data: unknown): CardVideo | null {
  if (!data || typeof data !== "object" || !("video" in data)) return null;
  const { video, poster, download, title, ref, version, liked } = data as Record<string, unknown>;
  if (!ours(video)) return null;
  const id = typeof ref === "string" ? Number(/^video:(\d+)/.exec(ref)?.[1]) || undefined : undefined;
  const v = typeof version === "number" ? version : Number(/[?&]v=(\d+)/.exec(video)?.[1]) || undefined;
  return {
    src: video,
    ...(ours(poster) ? { poster } : {}),
    ...(ours(download) ? { download } : {}),
    title: typeof title === "string" && title.trim() ? title.trim() : typeof ref === "string" ? ref : "Seelie video",
    ...(id ? { id, ref: `video:${id}${v ? `@${v}` : ""}` } : {}),
    ...(typeof liked === "boolean" ? { liked } : {}),
  };
}

export interface Made {
  videos: CardVideo[];
  pictures: CardPicture[];
  documents: CardDocument[];
}

/** What a run of items made, newest last: each video once (its latest render), pictures and PDFs once. */
export function madeBy(items: Item[], results: Results, tools: Record<string, ToolRow>): Made {
  const vids = new Map<string, CardVideo>();
  const pics = new Map<number, CardPicture>();
  const docs = new Map<number, CardDocument>();
  const take = (data: unknown) => {
    const v = videoOf(data);
    if (v) {
      const key = v.id ? `video:${v.id}` : v.src.split("?")[0];
      vids.delete(key);
      vids.set(key, v);
    }
    for (const p of picturesOf(data)) pics.set(p.id, p);
    for (const d of documentsOf(data)) docs.set(d.id, d);
  };
  for (const it of items) {
    if (it.type !== "tool") continue;
    take(readResult(resultOf(it.call.id, results, tools))?.data);
    // A helper's pictures and videos count too.
    if (it.call.name === "helpers") for (const r of Object.values(tools)) if (r.parent === it.call.id) take(readResult(r.result)?.data);
  }
  return { videos: [...vids.values()], pictures: [...pics.values()], documents: [...docs.values()] };
}

export const madeAnything = (m: Made) => m.videos.length + m.pictures.length + m.documents.length > 0;

/* -------------------------------------------------------------------------- */
/* What a job changed                                                         */
/* -------------------------------------------------------------------------- */

export type ChangeIcon = "price" | "new" | "remove" | "stock" | "post" | "ad" | "photo" | "video" | "memory" | "routine" | "page" | "order" | "edit";

export interface ChangeLine {
  name: string;
  url?: string;
  detail: string[];
}

export interface Change {
  key: string;
  row: ToolRow;
  where: string | null;
  icon: ChangeIcon;
  headline: string;
  lines: ChangeLine[];
  link: { href: string; label: string } | null;
  /** What Undo asks Seelie for; null where it can't be taken back (a post, images made). */
  undo: { label: string; say: string } | null;
}

const ICON: Record<string, ChangeIcon> = {
  store_update_products: "price",
  product_update: "price",
  store_create_products: "new",
  paribelle_add: "new",
  store_delete_products: "remove",
  push_stock: "stock",
  inventory: "stock",
  instagram_post: "post",
  ads_create: "ad",
  ads_manage: "ad",
  photoshoot: "photo",
  photo_edit: "photo",
  photo_publish: "photo",
  video_publish: "video",
  memory: "memory",
  routines: "routine",
  store_hero: "page",
  store_settings: "page",
  store_pages: "page",
  store_categories: "page",
  order_notes: "order",
  returns_update: "order",
  fulfilment: "order",
};

/** Changes that can't be taken back, or where Undo would mean nothing. */
const NO_UNDO = new Set(["instagram_post", "photoshoot", "sync_marketplace", "video_library", "songs", "memory"]);

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

function linesOf(data: unknown): ChangeLine[] {
  const list = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? ((data as Record<string, unknown>).changed ?? (data as Record<string, unknown>).created ?? (data as Record<string, unknown>).updated ?? (data as Record<string, unknown>).removed ?? null)
      : null;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 12).flatMap((x): ChangeLine[] => {
    if (!x || typeof x !== "object") return [];
    const o = x as Record<string, unknown>;
    const name = str(o.name) ?? str(o.title) ?? str(o.sku) ?? str(o.id);
    if (!name) return [];
    const changes = Array.isArray(o.changes) ? o.changes.filter((c): c is string => typeof c === "string") : typeof o.changes === "string" ? [o.changes] : [];
    const outcome = str(o.outcome);
    return [{ name, ...(str(o.url) ? { url: str(o.url)! } : {}), detail: [...changes, ...(outcome ? [outcome] : [])].slice(0, 6) }];
  });
}

function linkOf(tool: string, data: unknown): Change["link"] {
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;
  if (tool === "instagram_post" && str(o.link)) return { href: str(o.link)!, label: "Open the post" };
  if (str(o.adsManager)) return { href: str(o.adsManager)!, label: "Ads Manager" };
  const url = str(o.url) ?? str(o.link);
  return url && /^https:\/\//.test(url) ? { href: url, label: "Open" } : null;
}

/** Each change a turn made, as its card: what, where, and Undo. */
export function changesOf(items: Item[], tools: Record<string, ToolRow>, results: Results): Change[] {
  const out: Change[] = [];
  const consider = (row: ToolRow | undefined, result: ToolResultMessage | null) => {
    if (!row || row.kind === "read" || row.status !== "done" || row.tool === PLAN_TOOL) return;
    const { ask } = splitAsk(row.args);
    const data = readResult(result)?.data;
    const icon = ICON[row.tool] ?? (row.kind === "store" ? "page" : "edit");
    const headline = ask ?? row.summary ?? row.label;
    const undo = NO_UNDO.has(row.tool)
      ? null
      : row.tool === "ads_create"
        ? { label: "Pause the ad", say: `Pause the ad you just made (call ${row.callId}): ${headline}.` }
        : { label: "Undo", say: `Undo this change (${row.label}, call ${row.callId}): ${headline}. Put back exactly what it changed, using its result; ask me first only if it can't be undone exactly.` };
    out.push({ key: row.callId, row, where: PLACE[row.kind], icon, headline, lines: linesOf(data), link: linkOf(row.tool, data), undo });
  };
  for (const it of items) {
    if (it.type !== "tool") continue;
    consider(tools[it.call.id], resultOf(it.call.id, results, tools));
    if (it.call.name === "helpers") for (const r of Object.values(tools)) if (r.parent === it.call.id) consider(r, r.result ?? null);
  }
  return out;
}

/** The changes this whole chat made, newest first: for the "Made in this chat" strip's changes tab. */
export function chatChanges(turns: Turn[], tools: Record<string, ToolRow>, results: Results) {
  return turns.flatMap((t) => changesOf(t.items, tools, results)).reverse();
}

/** Every video, picture and PDF made in the chat, newest first. */
export function chatMade(turns: Turn[], results: Results, tools: Record<string, ToolRow>): Made {
  const all = madeBy(
    turns.flatMap((t) => t.items),
    results,
    tools,
  );
  return { videos: [...all.videos].reverse(), pictures: [...all.pictures].reverse(), documents: [...all.documents].reverse() };
}

/* -------------------------------------------------------------------------- */
/* Lookups                                                                    */
/* -------------------------------------------------------------------------- */

export type Shown = Item | { type: "lookups"; key: string; items: Extract<Item, { type: "tool" }>[] };

/** Lookups in a row (two or more reads that made nothing to show) fold into one "Looked up N things" line. */
export function foldLookups(items: Item[], tools: Record<string, ToolRow>, results: Results): Shown[] {
  const out: Shown[] = [];
  let run: Extract<Item, { type: "tool" }>[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ type: "lookups", key: `l:${run[0].key}`, items: run });
    else out.push(...run);
    run = [];
  };
  for (const it of items) {
    const row = it.type === "tool" ? tools[it.call.id] : undefined;
    const quiet =
      it.type === "tool" &&
      it.call.name !== "helpers" &&
      (row?.kind ?? "read") === "read" &&
      row?.status !== "error" &&
      row?.status !== "awaiting" &&
      !madeAnything(madeBy([it], results, tools));
    if (quiet) run.push(it as Extract<Item, { type: "tool" }>);
    else {
      flush();
      out.push(it);
    }
  }
  flush();
  return out;
}

/** Calls that try a tool again after it failed. */
export function retries(items: Item[], tools: Record<string, ToolRow>): Set<string> {
  const failed = new Set<string>();
  const again = new Set<string>();
  for (const it of items) {
    if (it.type !== "tool") continue;
    if (failed.has(it.call.name)) again.add(it.call.id);
    if (tools[it.call.id]?.status === "error") failed.add(it.call.name);
  }
  return again;
}
