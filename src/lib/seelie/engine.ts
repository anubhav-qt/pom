import "server-only";

import os from "node:os";

import { Agent, type AgentEvent, type AgentTool, type BeforeToolCallResult } from "@paribelle/pi-agent";
import {
  streamSimple,
  Type,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Model,
  type Message,
  type TextContent,
  type ToolResultMessage,
  type TSchema,
  type Usage,
  type UserMessage,
  type VideoContent,
} from "@paribelle/pi-ai";
import { and, asc, eq, inArray, isNull, isNotNull, sql } from "drizzle-orm";

import { db } from "@/db";
import { seelieAssets, seelieChats, seelieMessages, seelieRoutines, seelieRuns, seelieToolCalls, users, type User } from "@/db/schema";

import { effectiveThinking, getCatalog, resolveModel } from "./catalog";
import { DEFAULT_THINKING, requireSeelieConfig } from "./config";
import { summarySection } from "./compact";
import { HELPER_MAX_CALLS, helperModel, helperSection, helpersReport, helpersSection, helpersTool, type HelperJob } from "./helpers";
import { assetSummary } from "./media/files";
import { hydrateVideos } from "./media/watch";
import { nameChat, provisionalTitle } from "./naming";
import { buildSystemPrompt } from "./prompt";
import { toolsFor } from "./tools";
import { kindOf, ToolError, type SeelieTool, type ToolContext } from "./tools/types";
import {
  ACTIVE_RUN,
  ALWAYS_ASK,
  type Approval,
  type ChatMessage,
  type HelperState,
  type RunInfo,
  type RunStatus,
  type StartRunInput,
  type StreamEvent,
  type ToolKind,
  type ToolRow,
  type ToolStatus,
} from "./types";

/**
 * Seelie's runs. A run is one reply: the model streaming, calling tools, waiting on
 * approvals, until it stops. It executes in the process that received the message,
 * inside that request's context (so tools can use the signed-in user), detached
 * from the connection: closing the tab doesn't stop it.
 *
 * Everything is mirrored to Postgres as it happens (messages when they finish, tool
 * calls as they change, the reply being written every ~400 ms), so any process can
 * show a run, approve its changes or stop it. The process that holds a run streams
 * it token by token; the others follow the database.
 */

const OWNER = `${os.hostname()}:${process.pid}`;
/** A run whose heartbeat is older than this died with its process. */
const STALE_MS = 30_000;
const PARTIAL_FLUSH_MS = 400;
const CONTROL_MS = 1_000;
const TOOL_TEXT_MAX = 60_000;
/** The most tool calls one reply may make; past it, calls are refused and the model wraps up. */
const MAX_TOOL_CALLS = 80;
/** How long a reply's end waits for the chat's name. */
const NAMING_WAIT_MS = 6_000;
/** How long a finished run stays in memory for followers that arrive late. */
const LINGER_MS = 60_000;

type Listener = (event: StreamEvent) => void;

interface LiveRun {
  id: string;
  chatId: string;
  user: User;
  info: RunInfo;
  agent: Agent;
  partial: AssistantMessage | null;
  partialDirty: boolean;
  /** This run's messages, the user's included, as stored. */
  messages: ChatMessage[];
  tools: Map<string, ToolRow>;
  listeners: Set<Listener>;
  /** Approvals waited on: resolve(true) approved, (false) denied, (null) stopped. */
  waiters: Map<string, (approved: boolean | null) => void>;
  /** Decisions that arrived before the run got to waiting on them. */
  decided: Map<string, boolean>;
  autoApprove: boolean;
  abortRequested: boolean;
  nextSeq: number;
  /** Everything the chat has said, for tools that need the attached images. */
  history: Message[];
  timers: NodeJS.Timeout[];
  lastToolSnapshot: number;
  /** Watch copies made for this run's turns, by ref (base64). */
  watchCache: Map<string, string>;
  /** The model takes video and sound. */
  canWatch: boolean;
  /** A new chat being named: the title it shows now and the first naming under way. */
  naming: { title: string; message: string; attachments: string | null; first: Promise<string | null> } | null;
  /** What helpers start from: Seelie's system prompt (without this run's own parts), its tools, and the model to fall back on. */
  basePrompt: string;
  seelieTools: SeelieTool[];
  toolMap: Map<string, SeelieTool>;
  model: Model<Api>;
}

/** A helper's place: the helpers call that started it, and which helper it is there. */
interface Scope {
  parent: string;
  helper: number;
}

/** A helper's calls get ids of their own: models number calls per reply, so two helpers can name theirs alike. */
const scopedId = (scope: Scope | undefined, callId: string) => (scope ? `${scope.parent}~${scope.helper}~${callId}` : callId);

const registry: Map<string, LiveRun> = ((globalThis as { __seelieRuns?: Map<string, LiveRun> }).__seelieRuns ??= new Map());

export class SeelieRunError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "SeelieRunError";
  }
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

function runInfo(row: typeof seelieRuns.$inferSelect): RunInfo {
  return {
    id: row.id,
    status: row.status as RunStatus,
    model: row.model,
    thinking: row.thinking,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** A stored tool call as the screen shows it. */
export function toolRowFrom(
  row: typeof seelieToolCalls.$inferSelect,
  labels: Map<string, string>,
  deciderName: string | null,
): ToolRow {
  return {
    runId: row.runId,
    callId: row.callId,
    tool: row.tool,
    label: labels.get(row.tool) ?? row.tool,
    kind: row.kind as ToolKind,
    args: row.args,
    summary: row.summary,
    status: row.status as ToolStatus,
    approval: (row.approval as Approval | null) ?? null,
    decidedBy: deciderName,
    decidedAt: iso(row.decidedAt),
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    ...(row.parentCallId ? { parent: row.parentCallId, helper: row.helper, result: (row.result as ToolResultMessage | null) ?? null } : {}),
    ...(row.helpers ? { helpers: row.helpers as HelperState[] } : {}),
  };
}

/**
 * A transcript entry for the screen: images keep their place but not their bytes
 * (the screen loads them from /api/seelie/chats/[id]/images/[seq]/[index]); videos
 * never carry bytes outside a turn (their ref says where the screen plays them from).
 */
export function leanEntry(entry: ChatMessage): ChatMessage {
  const { message } = entry;
  if (message.role === "assistant" || typeof message.content === "string") return entry;
  if (!message.content.some((c) => c.type === "image" || c.type === "video")) return entry;
  const content = message.content.map((c) => (c.type === "image" || c.type === "video" ? { ...c, data: "" } : c));
  return { ...entry, message: { ...message, content } as Message };
}

/** A message as the chat keeps it: video blocks keep their ref, not their bytes (watch.ts remakes them). */
function storable(message: Message): Message {
  if (message.role === "assistant" || typeof message.content === "string") return message;
  if (!message.content.some((c) => c.type === "video" && c.data)) return message;
  const content = message.content.map((c) => (c.type === "video" ? { ...c, data: "" } : c));
  return { ...message, content } as Message;
}

function emit(run: LiveRun, event: StreamEvent) {
  for (const listener of run.listeners) {
    try {
      listener(event);
    } catch {
      // A follower that went away; its stream cleans itself up.
    }
  }
}

async function saveTool(run: LiveRun, row: ToolRow, extra: { decidedBy?: number | null } = {}) {
  emit(run, { t: "tool", row });
  await db
    .update(seelieToolCalls)
    .set({
      status: row.status,
      approval: row.approval,
      ...(extra.decidedBy !== undefined ? { decidedBy: extra.decidedBy } : {}),
      decidedAt: row.decidedAt ? new Date(row.decidedAt) : null,
      startedAt: row.startedAt ? new Date(row.startedAt) : null,
      endedAt: row.endedAt ? new Date(row.endedAt) : null,
      ...(row.result !== undefined ? { result: row.result } : {}),
      ...(row.helpers !== undefined ? { helpers: row.helpers } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(seelieToolCalls.runId, run.id), eq(seelieToolCalls.callId, row.callId)))
    .catch(() => {});
}

async function setStatus(run: LiveRun, status: RunStatus) {
  if (run.info.status === status) return;
  run.info = { ...run.info, status };
  emit(run, { t: "status", status });
  await db.update(seelieRuns).set({ status }).where(eq(seelieRuns.id, run.id)).catch(() => {});
}

async function saveMessage(run: LiveRun, full: Message): Promise<ChatMessage> {
  const message = storable(full);
  const seq = run.nextSeq++;
  const createdAt = new Date();
  await db.insert(seelieMessages).values({ chatId: run.chatId, runId: run.id, seq, role: message.role, message, createdAt });
  const entry: ChatMessage = { seq, runId: run.id, message, createdAt: createdAt.toISOString() };
  run.messages.push(entry);
  return entry;
}

/* -------------------------------------------------------------------------- */
/* Approvals                                                                  */
/* -------------------------------------------------------------------------- */

function needsApproval(kind: ToolKind, autoApprove: boolean) {
  if (kind === "read") return false;
  if (ALWAYS_ASK.includes(kind)) return true;
  return !autoApprove;
}

/** Apply a decision already written to the database to the run in memory. */
function applyDecision(run: LiveRun, callId: string, approved: boolean, by: { id: number; name: string } | null) {
  const row = run.tools.get(callId);
  if (row && row.status === "awaiting") {
    const now = new Date().toISOString();
    const next: ToolRow = {
      ...row,
      approval: approved ? "approved" : "denied",
      status: approved ? "queued" : "denied",
      decidedBy: by?.name ?? row.decidedBy,
      decidedAt: now,
      endedAt: approved ? null : now,
    };
    run.tools.set(callId, next);
    emit(run, { t: "tool", row: next });
  }
  const waiter = run.waiters.get(callId);
  if (waiter) {
    run.waiters.delete(callId);
    waiter(approved);
  } else {
    run.decided.set(callId, approved);
  }
}

function waitForDecision(run: LiveRun, callId: string, signal?: AbortSignal): Promise<boolean | null> {
  const early = run.decided.get(callId);
  if (early !== undefined) {
    run.decided.delete(callId);
    return Promise.resolve(early);
  }
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    run.waiters.set(callId, resolve);
    signal?.addEventListener(
      "abort",
      () => {
        if (run.waiters.get(callId) === resolve) run.waiters.delete(callId);
        resolve(null);
      },
      { once: true },
    );
  });
}

function anyAwaiting(run: LiveRun) {
  for (const row of run.tools.values()) if (row.status === "awaiting") return true;
  return false;
}

async function beforeToolCall(run: LiveRun, callId: string, signal?: AbortSignal, scope?: Scope): Promise<BeforeToolCallResult | undefined> {
  let made = 0;
  for (const r of run.tools.values()) if (scope ? r.parent === scope.parent && r.helper === scope.helper : !r.parent) made++;
  if (scope && made > HELPER_MAX_CALLS) {
    return {
      block: true,
      reason: `You have made ${HELPER_MAX_CALLS} tool calls, the most a helper may. Answer with what you have and say what's left.`,
    };
  }
  if (!scope && made > MAX_TOOL_CALLS) {
    return {
      block: true,
      reason: `This reply has already made ${MAX_TOOL_CALLS} tool calls, the most one reply may. Answer with what you have and say what's left; the user can ask you to carry on.`,
    };
  }
  const row = run.tools.get(callId);
  if (!row || row.status !== "awaiting") return undefined;

  // Auto-approve may have been switched on since the call was made.
  if (row.kind === "write" && run.autoApprove) {
    const next: ToolRow = { ...row, status: "queued", approval: "auto" };
    run.tools.set(callId, next);
    await saveTool(run, next);
    return undefined;
  }

  await setStatus(run, "waiting");
  const approved = await waitForDecision(run, callId, signal);
  if (!anyAwaiting(run)) await setStatus(run, "running");
  if (approved === null) return { block: true, reason: "Stopped before this was approved." };
  if (!approved) {
    return {
      block: true,
      reason: "The user denied this. Don't try it again unless they ask; say what it would have done if that helps.",
    };
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                      */
/* -------------------------------------------------------------------------- */

function capText(text: string) {
  return text.length > TOOL_TEXT_MAX
    ? `${text.slice(0, TOOL_TEXT_MAX)}\n… cut at ${TOOL_TEXT_MAX} of ${text.length} characters. Narrow the request (filters, fewer fields, a limit) to see the rest.`
    : text;
}

function chatImages(run: LiveRun): ImageContent[] {
  const images: ImageContent[] = [];
  for (const message of run.history) {
    if (message.role !== "user" || typeof message.content === "string") continue;
    for (const block of message.content) if (block.type === "image") images.push(block);
  }
  return images;
}

/**
 * What an approval card leads with: the model's own one-line, plain-words account of the
 * change ("Put the blue kurta on paribelle.in for ₹1,499"), for whoever approves it, who may
 * not read code. The exact call stays one tap below it.
 */
const ASK = "ask";
const askSchemas = new WeakMap<SeelieTool, TSchema>();

function withAsk(tool: SeelieTool): TSchema {
  const schema = tool.parameters as TSchema & { type?: string; properties?: Record<string, TSchema>; required?: string[] };
  if (tool.kind === "read" || schema.type !== "object" || !schema.properties || ASK in schema.properties) return schema;
  let out = askSchemas.get(tool);
  if (!out) {
    const ask = Type.String({
      maxLength: 200,
      description:
        "For the person approving this, who may not be technical: one short sentence in everyday words saying what will happen, e.g. \"Put the blue cotton kurta on paribelle.in as a draft for ₹1,499\". No ids, codes, field names or jargon." +
        (typeof tool.kind === "function" ? " Needed when this call changes something; leave it out when it only reads." : ""),
    });
    // A fixed kind always asks; one worked out from the arguments may only read.
    out = { ...schema, properties: { ...schema.properties, [ASK]: ask }, required: typeof tool.kind === "string" ? [...(schema.required ?? []), ASK] : schema.required };
    askSchemas.set(tool, out);
  }
  return out;
}

/** The arguments as the tool itself takes them (without `ask`). */
function withoutAsk(params: unknown) {
  if (!params || typeof params !== "object" || !(ASK in params)) return params;
  const { [ASK]: _, ...rest } = params as Record<string, unknown>;
  return rest;
}

function agentTool(run: LiveRun, tool: SeelieTool, scope?: Scope): AgentTool {
  const sequential = tool.kind !== "read";
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: withAsk(tool),
    ...(sequential ? { executionMode: "sequential" as const } : {}),
    execute: async (modelCallId, params, signal, onUpdate) => {
      const toolCallId = scopedId(scope, modelCallId);
      const row = run.tools.get(toolCallId);
      if (row) {
        const next: ToolRow = {
          ...row,
          status: "running",
          startedAt: new Date().toISOString(),
          approval: row.approval ?? (row.kind === "read" ? null : "auto"),
          progress: null,
        };
        run.tools.set(toolCallId, next);
        await saveTool(run, next);
      }
      const ctx: ToolContext = {
        user: run.user,
        chatId: run.chatId,
        runId: run.id,
        signal: signal ?? new AbortController().signal,
        progress: (text) => {
          const current = run.tools.get(toolCallId);
          if (!current) return;
          const next = { ...current, progress: text };
          run.tools.set(toolCallId, next);
          emit(run, { t: "tool", row: next });
          onUpdate?.({ content: [{ type: "text", text }], details: undefined });
        },
        chatImages: async () => chatImages(run),
        canWatch: run.canWatch,
      };
      try {
        const out = await tool.execute(withoutAsk(params) as never, ctx);
        const text = [out.text, out.data === undefined ? null : JSON.stringify(out.data)].filter(Boolean).join("\n") || "Done.";
        const content: (TextContent | ImageContent | VideoContent)[] = [
          { type: "text", text: capText(text) },
          ...(out.images ?? []),
          ...(out.videos ?? []),
        ];
        return { content, details: undefined, isError: out.error === true };
      } catch (err) {
        if (err instanceof ToolError) throw err;
        console.error(`[seelie] ${tool.name} failed`, err);
        throw err;
      }
    },
  };
}

/** Tool rows for every call in a finished assistant message, so every card shows at once. */
async function recordToolCalls(run: LiveRun, message: AssistantMessage, tools: Map<string, SeelieTool>, scope?: Scope) {
  const calls = message.content.filter((c) => c.type === "toolCall");
  if (calls.length === 0) return;
  const rows: ToolRow[] = [];
  for (const call of calls) {
    const tool = tools.get(call.name);
    let kind: ToolKind = "read";
    let summary: string | null = null;
    if (tool) {
      try {
        kind = kindOf(tool, withoutAsk(call.arguments));
      } catch {
        kind = typeof tool.kind === "string" ? tool.kind : "write";
      }
      try {
        summary = (await tool.summary(withoutAsk(call.arguments) as never, { user: run.user })) || null;
      } catch {
        // Arguments it can't summarise: the card shows them as they are.
      }
    }
    const asks = needsApproval(kind, run.autoApprove);
    rows.push({
      runId: run.id,
      callId: scopedId(scope, call.id),
      tool: call.name,
      label: tool?.label ?? call.name,
      kind,
      args: call.arguments,
      summary,
      status: asks ? "awaiting" : "queued",
      approval: !asks && kind !== "read" ? "auto" : null,
      decidedBy: null,
      decidedAt: null,
      startedAt: null,
      endedAt: null,
      ...(scope ? { parent: scope.parent, helper: scope.helper } : {}),
    });
  }
  await db
    .insert(seelieToolCalls)
    .values(
      rows.map((r) => ({
        runId: run.id,
        chatId: run.chatId,
        callId: r.callId,
        tool: r.tool,
        kind: r.kind,
        args: r.args,
        summary: r.summary,
        status: r.status,
        approval: r.approval,
        parentCallId: r.parent ?? null,
        helper: r.helper ?? null,
      })),
    )
    .onConflictDoNothing();
  for (const row of rows) {
    run.tools.set(row.callId, row);
    emit(run, { t: "tool", row });
  }
  if (rows.some((r) => r.status === "awaiting")) await setStatus(run, "waiting");
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

function snapshot(run: LiveRun, message: AssistantMessage) {
  run.partial = message;
  run.partialDirty = true;
  emit(run, { t: "partial", message: structuredClone(message) });
}

function onEvent(run: LiveRun, tools: Map<string, SeelieTool>, prompt: UserMessage) {
  return async (event: AgentEvent) => {
    switch (event.type) {
      case "message_start": {
        if (event.message.role === "assistant") snapshot(run, event.message as AssistantMessage);
        return;
      }
      case "message_update": {
        const e = event.assistantMessageEvent;
        const message = event.message as AssistantMessage;
        run.partial = message;
        run.partialDirty = true;
        if (e.type === "text_delta" || e.type === "thinking_delta") {
          emit(run, { t: "delta", i: e.contentIndex, k: e.type === "text_delta" ? "text" : "thinking", d: e.delta });
        } else if (e.type === "toolcall_delta") {
          // Arguments arrive as JSON fragments; a whole snapshot now and then keeps the card current.
          const now = Date.now();
          if (now - run.lastToolSnapshot > 250) {
            run.lastToolSnapshot = now;
            snapshot(run, message);
          }
        } else if (e.type === "text_start" || e.type === "thinking_start" || e.type === "toolcall_start" || e.type === "toolcall_end") {
          snapshot(run, message);
        }
        return;
      }
      case "message_end": {
        const message = event.message as Message;
        if (message.role === "system" || message === prompt) return;
        if (message.role === "user") {
          run.history.push(message);
        }
        if (message.role === "assistant") {
          run.partial = null;
          run.partialDirty = true;
          emit(run, { t: "partial", message: null });
        }
        if (message.role === "assistant" || message.role === "toolResult" || message.role === "user") {
          const entry = await saveMessage(run, message);
          emit(run, { t: "msg", m: leanEntry(entry) });
        }
        if (message.role === "assistant") await recordToolCalls(run, message, tools);
        return;
      }
      case "tool_execution_end":
        return endTool(run, event.toolCallId, event.isError);
      default:
        return;
    }
  };
}

async function endTool(run: LiveRun, callId: string, isError: boolean) {
  const row = run.tools.get(callId);
  if (!row) return;
  const now = new Date().toISOString();
  const status: ToolStatus = row.status === "denied" ? "denied" : isError ? "error" : "done";
  const next: ToolRow = { ...row, status, endedAt: now, startedAt: row.startedAt ?? now, progress: null };
  run.tools.set(row.callId, next);
  await saveTool(run, next);
}

function sumUsage(messages: Message[]): Usage | null {
  let total: Usage | null = null;
  for (const message of messages) {
    // A helpers call's result carries what its helpers used.
    if (message.role !== "assistant" && message.role !== "toolResult") continue;
    const u = message.usage;
    if (!u) continue;
    total ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    total.input += u.input;
    total.output += u.output;
    total.cacheRead += u.cacheRead;
    total.cacheWrite += u.cacheWrite;
    total.totalTokens += u.totalTokens;
    if (u.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + u.reasoning;
  }
  return total;
}

async function finish(run: LiveRun, failure?: unknown) {
  for (const timer of run.timers) clearInterval(timer);
  run.timers = [];
  for (const [callId, waiter] of run.waiters) {
    run.waiters.delete(callId);
    waiter(null);
  }

  const last = [...run.messages].reverse().find((m) => m.message.role === "assistant")?.message as AssistantMessage | undefined;
  let status: RunStatus = "done";
  let error: string | null = null;
  if (failure) {
    status = "error";
    error = failure instanceof Error ? failure.message : String(failure);
  } else if (run.abortRequested || last?.stopReason === "aborted") {
    status = "aborted";
  } else if (last?.stopReason === "error") {
    status = "error";
    error = last.errorMessage ?? "The model answered with an error.";
  }

  // Anything left unfinished ends with the run.
  const now = new Date().toISOString();
  for (const row of run.tools.values()) {
    if (row.status === "awaiting" || row.status === "queued" || row.status === "running") {
      const next: ToolRow = { ...row, status: row.status === "awaiting" ? "denied" : "error", endedAt: now, progress: null };
      run.tools.set(row.callId, next);
      await saveTool(run, next);
    }
  }

  run.partial = null;
  run.info = { ...run.info, status, error, endedAt: now };
  await db
    .update(seelieRuns)
    .set({ status, error, partial: null, endedAt: new Date(now), usage: sumUsage(run.messages.map((m) => m.message)), heartbeatAt: new Date() })
    .where(eq(seelieRuns.id, run.id))
    .catch(() => {});
  await db.update(seelieChats).set({ updatedAt: new Date() }).where(eq(seelieChats.id, run.chatId)).catch(() => {});

  // The name is usually there long before; a slow one lands in the database and the chat list picks it up.
  await Promise.race([renameFromReply(run, last), new Promise((r) => setTimeout(r, NAMING_WAIT_MS))]);

  emit(run, { t: "end", status, error });
  run.listeners.clear();
  setTimeout(() => {
    if (registry.get(run.id) === run) registry.delete(run.id);
  }, LINGER_MS).unref?.();
}

/** A new chat its first message couldn't name ("hi") is named from the reply. */
async function renameFromReply(run: LiveRun, last: AssistantMessage | undefined) {
  const naming = run.naming;
  if (!naming) return;
  run.naming = null;
  if (await naming.first) return;
  const reply = last?.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
  if (!reply) return;
  const title = await nameChat(run.chatId, naming.title, { message: naming.message, attachments: naming.attachments, reply });
  if (title) emit(run, { t: "title", title });
}

/** Mirror the reply being written, keep the heartbeat, and pick up what other processes decided. */
function startTimers(run: LiveRun) {
  run.timers.push(
    setInterval(() => {
      if (!run.partialDirty) return;
      run.partialDirty = false;
      db.update(seelieRuns)
        .set({ partial: run.partial })
        .where(eq(seelieRuns.id, run.id))
        .catch(() => {});
    }, PARTIAL_FLUSH_MS),
  );

  let busy = false;
  run.timers.push(
    setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const [control] = await db
          .update(seelieRuns)
          .set({ heartbeatAt: new Date() })
          .where(eq(seelieRuns.id, run.id))
          .returning({ abortRequested: seelieRuns.abortRequested });
        if (control?.abortRequested && !run.abortRequested) {
          run.abortRequested = true;
          run.agent.abort();
        }
        if (run.waiters.size > 0) {
          const [chat] = await db
            .select({ autoApprove: seelieChats.autoApprove })
            .from(seelieChats)
            .where(eq(seelieChats.id, run.chatId));
          run.autoApprove = chat?.autoApprove ?? run.autoApprove;
          const decided = await db
            .select({ callId: seelieToolCalls.callId, approval: seelieToolCalls.approval, by: users.id, name: users.name })
            .from(seelieToolCalls)
            .leftJoin(users, eq(users.id, seelieToolCalls.decidedBy))
            .where(
              and(
                eq(seelieToolCalls.runId, run.id),
                inArray(seelieToolCalls.callId, [...run.waiters.keys()]),
                isNotNull(seelieToolCalls.approval),
              ),
            );
          for (const d of decided) {
            applyDecision(run, d.callId, d.approval !== "denied", d.by ? { id: d.by, name: d.name ?? "" } : null);
          }
        }
      } catch {
        // The next tick tries again.
      } finally {
        busy = false;
      }
    }, CONTROL_MS),
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** The helpers tool as the reply's agent runs it. */
function helpersAgentTool(run: LiveRun): AgentTool {
  return {
    name: helpersTool.name,
    label: helpersTool.label,
    description: helpersTool.description,
    parameters: helpersTool.parameters,
    execute: async (toolCallId, params, signal) => {
      const row = run.tools.get(toolCallId);
      if (row) {
        const next: ToolRow = { ...row, status: "running", startedAt: new Date().toISOString(), progress: null };
        run.tools.set(toolCallId, next);
        await saveTool(run, next);
      }
      return runHelpers(run, toolCallId, (params as { jobs: HelperJob[] }).jobs, signal ?? new AbortController().signal);
    },
  };
}

/** Run every job at once, each as a helper; the reply reads back their answers. */
async function runHelpers(run: LiveRun, callId: string, jobs: HelperJob[], signal: AbortSignal) {
  const picked = await Promise.all(jobs.map((job) => helperModel(job.thinking, run.model)));
  const states: HelperState[] = jobs.map((job, i) => ({
    title: job.title,
    model: picked[i].model.name,
    thinking: picked[i].thinking,
    status: "working",
    answer: null,
  }));
  const publish = async () => {
    const row = run.tools.get(callId);
    if (!row) return;
    const done = states.filter((h) => h.status !== "working").length;
    const next: ToolRow = { ...row, helpers: states.map((h) => ({ ...h })), progress: done ? `${done} of ${states.length} done` : null };
    run.tools.set(callId, next);
    await saveTool(run, next);
  };
  await publish();

  const used: Message[] = [];
  await Promise.all(
    jobs.map(async (job, i) => {
      const out = await runHelper(run, { parent: callId, helper: i }, job, jobs.length, picked[i], signal).catch((err: unknown) => {
        console.error("[seelie] helper failed", err);
        return { status: "error" as const, answer: `It failed: ${err instanceof Error ? err.message : String(err)}`, messages: [] as Message[] };
      });
      states[i] = { ...states[i], status: out.status, answer: out.answer };
      used.push(...out.messages);
      await publish();
    }),
  );

  const content: TextContent[] = [{ type: "text", text: capText(helpersReport(states)) }];
  return {
    content,
    details: { helpers: states },
    usage: sumUsage(used) ?? undefined,
    isError: states.every((h) => h.status === "error"),
  };
}

/** One helper: its own agent with Seelie's tools (not helpers), its steps shown under the helpers call. */
async function runHelper(
  run: LiveRun,
  scope: Scope,
  job: HelperJob,
  total: number,
  pick: { model: Model<Api>; thinking: string },
  signal: AbortSignal,
): Promise<{ status: HelperState["status"]; answer: string | null; messages: Message[] }> {
  if (signal.aborted) return { status: "stopped", answer: null, messages: [] };
  const config = requireSeelieConfig();
  const agent = new Agent({
    initialState: {
      systemPrompt: [run.basePrompt, helperSection(job, scope.helper, total)].join("\n\n"),
      model: pick.model,
      thinkingLevel: pick.thinking as never,
      tools: run.seelieTools.map((t) => agentTool(run, t, scope)),
      messages: [],
    },
    streamFn: streamSimple,
    getApiKey: () => config.apiKey,
    sessionId: `${run.chatId}:${scope.parent}:${scope.helper}`,
    toolExecution: "parallel",
    beforeToolCall: (ctx, s) => beforeToolCall(run, scopedId(scope, ctx.toolCall.id), s, scope),
    transformContext: (messages) => hydrateVideos(messages, run.watchCache),
  });
  agent.subscribe(async (event) => {
    if (event.type === "message_end") {
      const message = event.message as Message;
      if (message.role === "assistant") await recordToolCalls(run, message, run.toolMap, scope);
      if (message.role === "toolResult") {
        // Its result stays on its row: a helper's messages aren't part of the chat.
        const id = scopedId(scope, message.toolCallId);
        const row = run.tools.get(id);
        if (row) {
          const next: ToolRow = { ...row, result: { ...message, content: message.content.filter((c) => c.type === "text") } };
          run.tools.set(id, next);
          await saveTool(run, next);
        }
      }
    } else if (event.type === "tool_execution_end") {
      await endTool(run, scopedId(scope, event.toolCallId), event.isError);
    }
  });

  const stop = () => agent.abort();
  signal.addEventListener("abort", stop, { once: true });
  try {
    await agent.prompt({ role: "user", content: [{ type: "text", text: job.task }], timestamp: Date.now() });
  } finally {
    signal.removeEventListener("abort", stop);
  }

  const messages = agent.state.messages as Message[];
  const last = [...messages].reverse().find((m): m is AssistantMessage => m.role === "assistant");
  const text =
    last?.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim() || null;
  if (signal.aborted || last?.stopReason === "aborted") return { status: "stopped", answer: text, messages };
  if (!last || last.stopReason === "error") return { status: "error", answer: text ?? last?.errorMessage ?? "The model answered with an error.", messages };
  return { status: "done", answer: text, messages };
}

/* -------------------------------------------------------------------------- */
/* Starting a run                                                             */
/* -------------------------------------------------------------------------- */

/** Mark runs whose process died as interrupted (and their open tool calls as ended). */
export async function reapStaleRuns(chatId: string) {
  const stale = await db
    .select({ id: seelieRuns.id })
    .from(seelieRuns)
    .where(
      and(
        eq(seelieRuns.chatId, chatId),
        inArray(seelieRuns.status, [...ACTIVE_RUN]),
        sql`${seelieRuns.heartbeatAt} < now() - make_interval(secs => ${STALE_MS / 1000})`,
      ),
    );
  const ids = stale.map((r) => r.id).filter((id) => !registry.has(id));
  if (ids.length === 0) return;
  await db
    .update(seelieRuns)
    .set({ status: "interrupted", partial: null, endedAt: new Date(), error: "The server restarted while this was running." })
    .where(inArray(seelieRuns.id, ids));
  await db
    .update(seelieToolCalls)
    .set({ status: "error", endedAt: new Date(), updatedAt: new Date() })
    .where(and(inArray(seelieToolCalls.runId, ids), inArray(seelieToolCalls.status, ["awaiting", "queued", "running"])));
}

/** What Seelie is told when a routine sends the message instead of the owner. */
function routineSection(r: NonNullable<StartRunInput["routine"]>) {
  return [
    `This message is the routine "${r.name}" (${r.schedule}, India time), ${r.manual ? "started by hand from the routines list" : "sent on its schedule"}; nobody is watching as you reply, and earlier runs of it are above in this chat.`,
    "- Do the job and report it the way the owner would want to read it later: lead with what matters or changed since the last run, with the numbers.",
    "- Changes that ask (and, unless this routine auto-approves, changes to the OMS) wait as approval cards until the owner opens the chat; make the call anyway, don't hold the report back for it, and say in the reply what's waiting.",
    "- If something stops the job (a tool failing, a missing connection), say so plainly so the owner can fix it before the next run.",
  ].join("\n");
}

export interface StartedRun {
  chatId: string;
  runId: string;
}

/** Start a reply to `input` in its chat (a new chat when none is given). */
export async function startRun(user: User, input: StartRunInput): Promise<StartedRun> {
  const config = requireSeelieConfig();
  const text = (input.text ?? "").trim();
  const images = (input.images ?? []).filter((i) => i.data && /^image\/(png|jpeg|webp|gif)$/.test(i.mimeType)).slice(0, 12);
  const assetIds = [...new Set(input.assets ?? [])].filter((id) => Number.isInteger(id) && id > 0).slice(0, 8);
  if (!text && images.length === 0 && assetIds.length === 0) throw new SeelieRunError("Say something first.");

  const catalog = await getCatalog();
  const modelId = input.model && catalog.models.some((m) => m.id === input.model) ? input.model : catalog.defaultModel;
  const model = await resolveModel(modelId);
  if (!model) throw new SeelieRunError(`${modelId} isn't available from the connected accounts.`, 409);
  if (images.length > 0 && !model.input.includes("image")) {
    throw new SeelieRunError(`${model.name} can't see images. Pick another model or send text only.`);
  }
  const thinking = effectiveThinking(model, input.thinking ?? DEFAULT_THINKING);

  // The chat: an existing one of this user's, or a new one.
  let chatId = input.chatId ?? null;
  let autoApprove = false;
  let isNew = false;
  // A compacted chat (compact.ts): Seelie reads the summary in place of the messages up to `through`.
  let compacted: { summary: string; through: number } | null = null;
  if (chatId) {
    const [chat] = await db.select().from(seelieChats).where(eq(seelieChats.id, chatId)).limit(1);
    if (!chat || chat.userId !== user.id) throw new SeelieRunError("That chat doesn't exist.", 404);
    autoApprove = chat.autoApprove;
    isNew = !chat.title;
    if (chat.summary && chat.summaryThrough !== null) compacted = { summary: chat.summary, through: chat.summaryThrough };
    await reapStaleRuns(chatId);
    const [active] = await db
      .select({ id: seelieRuns.id })
      .from(seelieRuns)
      .where(and(eq(seelieRuns.chatId, chatId), inArray(seelieRuns.status, [...ACTIVE_RUN])))
      .limit(1);
    if (active) throw new SeelieRunError("Seelie is still replying in this chat. Stop it or wait.", 409);
  } else {
    autoApprove = input.autoApprove === true;
    const [chat] = await db
      .insert(seelieChats)
      .values({ userId: user.id, title: "", model: modelId, thinking, autoApprove })
      .returning({ id: seelieChats.id });
    chatId = chat.id;
    isNew = true;
  }

  // Clips and sounds attached: uploaded first (POST /api/seelie/assets), named here.
  const assets = assetIds.length ? await db.select().from(seelieAssets).where(inArray(seelieAssets.id, assetIds)) : [];
  if (assets.length !== assetIds.length || assets.some((a) => a.userId !== user.id || (a.chatId !== null && a.chatId !== chatId))) {
    throw new SeelieRunError("An attached file isn't there any more. Attach it again.", 404);
  }
  if (assets.length) {
    await db
      .update(seelieAssets)
      .set({ chatId })
      .where(and(inArray(seelieAssets.id, assetIds), isNull(seelieAssets.chatId)));
  }

  const [runRow] = await db
    .insert(seelieRuns)
    .values({ chatId, userId: user.id, status: "running", model: modelId, thinking, owner: OWNER })
    .returning();

  const historyRows = await db
    .select({ seq: seelieMessages.seq, message: seelieMessages.message })
    .from(seelieMessages)
    .where(eq(seelieMessages.chatId, chatId))
    .orderBy(asc(seelieMessages.seq));
  const history = historyRows.map((r) => r.message as Message);
  const nextSeq = (historyRows.at(-1)?.seq ?? 0) + 1;
  const keepAfter = compacted?.through ?? 0;
  const modelHistory = historyRows.filter((r) => r.seq > keepAfter).map((r) => r.message as Message);

  const prompt: UserMessage = {
    role: "user",
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...images.map((i) => ({ type: "image" as const, data: i.data, mimeType: i.mimeType })),
      ...assets.flatMap((a) => [
        { type: "text" as const, text: `Attached: ${JSON.stringify(assetSummary(a))}` },
        ...(a.kind === "video" || a.kind === "audio"
          ? [{ type: "video" as const, data: "", mimeType: a.kind === "audio" ? "audio/mpeg" : "video/mp4", ref: `asset:${a.id}` }]
          : []),
      ]),
    ],
    timestamp: Date.now(),
  };

  const seelieTools = toolsFor(user);
  const toolMap = new Map<string, SeelieTool>([...seelieTools, helpersTool as unknown as SeelieTool].map((t) => [t.name, t]));
  const basePrompt = await buildSystemPrompt(user, seelieTools);

  const run: LiveRun = {
    id: runRow.id,
    chatId,
    user,
    info: runInfo(runRow),
    agent: undefined as unknown as Agent,
    partial: null,
    partialDirty: false,
    messages: [],
    tools: new Map(),
    listeners: new Set(),
    waiters: new Map(),
    decided: new Map(),
    autoApprove,
    abortRequested: false,
    nextSeq,
    history: [...history, prompt],
    timers: [],
    lastToolSnapshot: 0,
    watchCache: new Map(),
    canWatch: model.input.includes("video"),
    naming: null,
    basePrompt,
    seelieTools,
    toolMap,
    model,
  };

  const systemPrompt = [
    basePrompt,
    helpersSection(),
    input.routine ? routineSection(input.routine) : "",
    compacted ? summarySection(compacted.summary) : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  run.agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: thinking,
      tools: [...seelieTools.map((t) => agentTool(run, t)), helpersAgentTool(run)],
      messages: modelHistory,
    },
    streamFn: streamSimple,
    getApiKey: () => config.apiKey,
    sessionId: chatId,
    toolExecution: "parallel",
    beforeToolCall: (ctx, signal) => beforeToolCall(run, ctx.toolCall.id, signal),
    // Clips the model watches go with each turn as bytes; the chat keeps only their refs.
    transformContext: (messages) => hydrateVideos(messages, run.watchCache),
  });
  run.agent.subscribe(onEvent(run, toolMap, prompt));
  registry.set(run.id, run);

  // The message first, so the screen has it before anything streams.
  const entry = await saveMessage(run, prompt);
  const title = provisionalTitle(text, images.length ? "Photos" : "Clips");
  await db
    .update(seelieChats)
    .set({
      updatedAt: new Date(),
      model: modelId,
      thinking,
      ...(isNew ? { title } : {}),
    })
    .where(eq(seelieChats.id, chatId));
  if (isNew) {
    queueMicrotask(() => emit(run, { t: "title", title }));
    // Seelie names the chat while it replies; the start of the message stands in meanwhile.
    const attachments =
      [
        images.length ? `${images.length} photo${images.length > 1 ? "s" : ""}` : null,
        ...assets.map((a) => `a ${a.kind === "audio" ? "sound" : a.kind} "${a.name}"`),
      ]
        .filter(Boolean)
        .join(", ") || null;
    const naming = { title, message: text, attachments };
    run.naming = {
      ...naming,
      first: nameChat(chatId, title, naming).then((named) => {
        if (named) emit(run, { t: "title", title: named });
        return named;
      }),
    };
  }
  void entry;

  startTimers(run);
  // Detached: the run outlives the request that started it.
  void run.agent
    .prompt(prompt)
    .then(() => finish(run))
    .catch((err: unknown) => finish(run, err));

  return { chatId, runId: run.id };
}

/* -------------------------------------------------------------------------- */
/* Controlling a run                                                          */
/* -------------------------------------------------------------------------- */

async function ownedRun(user: User, runId: string) {
  const [row] = await db
    .select({ run: seelieRuns, chatUser: seelieChats.userId })
    .from(seelieRuns)
    .innerJoin(seelieChats, eq(seelieChats.id, seelieRuns.chatId))
    .where(eq(seelieRuns.id, runId))
    .limit(1);
  if (!row || row.chatUser !== user.id) throw new SeelieRunError("That reply doesn't exist.", 404);
  return row.run;
}

export async function stopRun(user: User, runId: string) {
  await ownedRun(user, runId);
  await db.update(seelieRuns).set({ abortRequested: true }).where(eq(seelieRuns.id, runId));
  const run = registry.get(runId);
  if (run && !run.abortRequested) {
    run.abortRequested = true;
    for (const [callId, waiter] of run.waiters) {
      run.waiters.delete(callId);
      waiter(null);
    }
    run.agent.abort();
  }
}

/**
 * Approve or deny a change Seelie is waiting on. `alwaysThisChat` also switches
 * the chat to auto-approve and approves its other waiting changes to the OMS
 * (changes to a marketplace or paribelle.in still ask one by one).
 */
export async function decideToolCall(
  user: User,
  input: { runId: string; callId: string; approve: boolean; alwaysThisChat?: boolean },
) {
  const runRow = await ownedRun(user, input.runId);
  const now = new Date();
  const decided = await db
    .update(seelieToolCalls)
    .set({
      approval: input.approve ? "approved" : "denied",
      status: input.approve ? "queued" : "denied",
      decidedBy: user.id,
      decidedAt: now,
      ...(input.approve ? {} : { endedAt: now }),
      updatedAt: now,
    })
    .where(
      and(
        eq(seelieToolCalls.runId, input.runId),
        eq(seelieToolCalls.callId, input.callId),
        eq(seelieToolCalls.status, "awaiting"),
        isNull(seelieToolCalls.approval),
      ),
    )
    .returning({ callId: seelieToolCalls.callId });

  const run = registry.get(input.runId);
  const by = { id: user.id, name: user.name };
  if (decided.length > 0 && run) applyDecision(run, input.callId, input.approve, by);

  if (input.approve && input.alwaysThisChat) {
    await db.update(seelieChats).set({ autoApprove: true }).where(eq(seelieChats.id, runRow.chatId));
    // A routine's switch is its chat's.
    await db.update(seelieRoutines).set({ autoApprove: true }).where(eq(seelieRoutines.chatId, runRow.chatId));
    const others = await db
      .update(seelieToolCalls)
      .set({ approval: "approved", status: "queued", decidedBy: user.id, decidedAt: now, updatedAt: now })
      .where(
        and(
          eq(seelieToolCalls.runId, input.runId),
          eq(seelieToolCalls.kind, "write"),
          eq(seelieToolCalls.status, "awaiting"),
          isNull(seelieToolCalls.approval),
        ),
      )
      .returning({ callId: seelieToolCalls.callId });
    if (run) {
      run.autoApprove = true;
      for (const o of others) applyDecision(run, o.callId, true, by);
    }
  }
  return { ok: decided.length > 0 };
}

/** Switch a run's chat to auto-approve (or back), telling the run if this process holds it. */
export function setLiveAutoApprove(chatId: string, on: boolean) {
  for (const run of registry.values()) if (run.chatId === chatId) run.autoApprove = on;
}

/* -------------------------------------------------------------------------- */
/* Following a run                                                            */
/* -------------------------------------------------------------------------- */

const encoder = new TextEncoder();

/**
 * The run as a server-sent event stream: what happened since message `after`, then
 * everything as it happens until the run ends. Served token by token when this
 * process holds the run, else from the database every 400 ms.
 */
export async function followRun(user: User, runId: string, after: number): Promise<ReadableStream<Uint8Array>> {
  const runRow = await ownedRun(user, runId);
  const chatId = runRow.chatId;
  let close: () => void = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (event: StreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const ping = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          closed = true;
        }
      }, 15_000);
      close = () => {
        if (closed) return;
        closed = true;
        clearInterval(ping);
        try {
          controller.close();
        } catch {
          // Already closed by the client.
        }
      };

      const run = registry.get(runId);
      if (run) {
        send({ t: "run", run: run.info, chatId });
        for (const m of run.messages) if (m.seq > after) send({ t: "msg", m: leanEntry(m) });
        for (const row of run.tools.values()) send({ t: "tool", row });
        if (run.partial) send({ t: "partial", message: structuredClone(run.partial) });
        if (!ACTIVE_RUN.includes(run.info.status)) {
          send({ t: "end", status: run.info.status, error: run.info.error });
          close();
          return;
        }
        const listener: Listener = (event) => {
          send(event);
          if (event.t === "end") {
            run.listeners.delete(listener);
            close();
          }
        };
        run.listeners.add(listener);
        const prevClose = close;
        close = () => {
          run.listeners.delete(listener);
          prevClose();
        };
        return;
      }

      void pollDatabase(runId, chatId, after, send, () => closed).finally(close);
    },
    cancel() {
      close();
    },
  });
}

async function pollDatabase(
  runId: string,
  chatId: string,
  after: number,
  send: (e: StreamEvent) => void,
  isClosed: () => boolean,
) {
  let lastSeq = after;
  let lastToolAt = new Date(0);
  let lastPartial = "";
  let lastStatus = "";
  const deciders = new Map<number, string>();
  const { toolLabels } = await import("./tools");
  const labels = toolLabels();

  for (let first = true; !isClosed(); first = false) {
    const [run] = await db.select().from(seelieRuns).where(eq(seelieRuns.id, runId)).limit(1);
    if (!run) return;
    if (first) send({ t: "run", run: runInfo(run), chatId });

    const msgs = await db
      .select()
      .from(seelieMessages)
      .where(and(eq(seelieMessages.chatId, chatId), sql`${seelieMessages.seq} > ${lastSeq}`))
      .orderBy(asc(seelieMessages.seq));
    for (const m of msgs) {
      lastSeq = m.seq;
      send({ t: "msg", m: leanEntry({ seq: m.seq, runId: m.runId, message: m.message as Message, createdAt: m.createdAt.toISOString() }) });
    }

    const rows = await db
      .select()
      .from(seelieToolCalls)
      .where(and(eq(seelieToolCalls.runId, runId), sql`${seelieToolCalls.updatedAt} > ${lastToolAt.toISOString()}`))
      .orderBy(asc(seelieToolCalls.id));
    for (const row of rows) {
      if (row.updatedAt > lastToolAt) lastToolAt = row.updatedAt;
      let name: string | null = null;
      if (row.decidedBy) {
        if (!deciders.has(row.decidedBy)) {
          const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.decidedBy));
          deciders.set(row.decidedBy, u?.name ?? "");
        }
        name = deciders.get(row.decidedBy) ?? null;
      }
      send({ t: "tool", row: toolRowFrom(row, labels, name) });
    }

    const partial = run.partial ? JSON.stringify(run.partial) : "";
    if (partial !== lastPartial) {
      lastPartial = partial;
      send({ t: "partial", message: (run.partial as AssistantMessage | null) ?? null });
    }

    let status = run.status as RunStatus;
    if (ACTIVE_RUN.includes(status) && Date.now() - run.heartbeatAt.getTime() > STALE_MS) {
      await reapStaleRuns(chatId);
      status = "interrupted";
    }
    if (status !== lastStatus) {
      lastStatus = status;
      if (ACTIVE_RUN.includes(status)) send({ t: "status", status });
    }
    if (!ACTIVE_RUN.includes(status)) {
      send({ t: "end", status, error: run.error ?? (status === "interrupted" ? "The server restarted while this was running." : null) });
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** Whether this process is running it (for the screen's "live" hint and tests). */
export function isLocalRun(runId: string) {
  return registry.has(runId);
}
