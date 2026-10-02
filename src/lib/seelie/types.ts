/**
 * What Seelie's screen and its server share: the shapes of a chat, a tool call and
 * the events a run streams. Types only, so client components can import them.
 */
import type { AssistantMessage, Message } from "@paribelle/pi-ai";

/**
 * What a tool does, which decides whether it asks first.
 *  - read:   looks things up; never asks.
 *  - write:  changes the OMS; asks unless the chat auto-approves.
 *  - market: changes a marketplace (Amazon); always asks.
 *  - store:  changes paribelle.in; always asks.
 *  - publish: posts to a social account (Instagram); always asks.
 *  - spend:  uses the image model's capped budget (a photoshoot); always asks.
 *  - ads:    can spend money on Meta ads (start, restart, a bigger budget); always asks.
 *  - forget: deletes something the user told Seelie to remember; always asks.
 */
export type ToolKind = "read" | "write" | "market" | "store" | "publish" | "spend" | "ads" | "forget";

/** Kinds that ask even when the chat auto-approves. */
export const ALWAYS_ASK: readonly ToolKind[] = ["market", "store", "publish", "spend", "ads", "forget"];

export type ToolStatus = "queued" | "awaiting" | "denied" | "running" | "done" | "error";
export type Approval = "auto" | "approved" | "denied";
export type RunStatus = "running" | "waiting" | "done" | "error" | "aborted" | "interrupted";

export const ACTIVE_RUN: readonly RunStatus[] = ["running", "waiting"];

/** One tool call as the timeline shows it. */
export interface ToolRow {
  runId: string;
  callId: string;
  tool: string;
  label: string;
  kind: ToolKind;
  args: unknown;
  summary: string | null;
  status: ToolStatus;
  approval: Approval | null;
  decidedBy: string | null;
  decidedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** The latest progress line while it runs (not kept once it ends). */
  progress?: string | null;
}

/** A transcript entry: pi's message and where it sits. */
export interface ChatMessage {
  seq: number;
  runId: string | null;
  message: Message;
  createdAt: string;
}

export interface ChatSummary {
  id: string;
  title: string;
  pinned: boolean;
  updatedAt: string;
  /** A run is going in it right now. */
  active: boolean;
  /** A routine replies in it. */
  routine: boolean;
}

export interface RunInfo {
  id: string;
  status: RunStatus;
  model: string;
  thinking: string;
  error: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface ChatView {
  id: string;
  title: string;
  model: string | null;
  thinking: string | null;
  autoApprove: boolean;
  pinned: boolean;
  messages: ChatMessage[];
  tools: ToolRow[];
  runs: RunInfo[];
  /** The run still going, which the screen follows. */
  activeRun: RunInfo | null;
  /** The reply being streamed in it, as far as it has got. */
  partial: AssistantMessage | null;
}

/** What a run's stream carries, one JSON object per SSE `data:` line. */
export type StreamEvent =
  | { t: "run"; run: RunInfo; chatId: string }
  | { t: "msg"; m: ChatMessage }
  /** The reply being written, whole; null once it is final (a `msg` follows). */
  | { t: "partial"; message: AssistantMessage | null }
  /** Text or thinking added to block `i` of the current partial. */
  | { t: "delta"; i: number; k: "text" | "thinking"; d: string }
  | { t: "tool"; row: ToolRow }
  | { t: "status"; status: RunStatus }
  | { t: "end"; status: RunStatus; error: string | null }
  /** The title the chat was given. */
  | { t: "title"; title: string };

export interface ImageInput {
  /** base64, no data: prefix */
  data: string;
  mimeType: string;
}

export interface StartRunInput {
  chatId?: string | null;
  text: string;
  images?: ImageInput[];
  /** Clips and sounds uploaded for this message (seelie_assets ids). */
  assets?: number[];
  model?: string;
  thinking?: string;
  /** Sent by a routine (its name and schedule in words), not typed by the owner. */
  routine?: { name: string; schedule: string; manual: boolean };
}
