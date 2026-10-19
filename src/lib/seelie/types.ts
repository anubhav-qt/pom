/**
 * What Seelie's screen and its server share: the shapes of a chat, a tool call and
 * the events a run streams. Types only, so client components can import them.
 */
import type { AssistantMessage, Message, ToolResultMessage } from "@paribelle/pi-ai";

/**
 * What a tool does, which decides whether it asks first and what its step is tagged with.
 *  - read:   looks things up.
 *  - write:  changes the OMS.
 *  - market: changes a marketplace (Amazon).
 *  - store:  changes paribelle.in.
 *  - publish: posts to a social account (Instagram); asks.
 *  - spend:  uses the image model's capped budget (a photoshoot); asks.
 *  - ads:    can spend money on Meta ads (start, restart, a bigger budget); asks.
 *  - forget: deletes something the user told Seelie to remember.
 */
export type ToolKind = "read" | "write" | "market" | "store" | "publish" | "spend" | "ads" | "forget";

/** The only kinds that wait for an OK (owner, 2026-10-19): posts, ad spend and new images. Everything else runs. */
export const ASKS: readonly ToolKind[] = ["publish", "spend", "ads"];

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
  /** A helper's step: the helpers call that started the helper, and which helper (0-based). */
  parent?: string | null;
  helper?: number | null;
  /** A helper's step: what the tool returned (helpers' messages aren't in the chat). */
  result?: ToolResultMessage | null;
  /** A helpers call: each helper as it goes. */
  helpers?: HelperState[] | null;
}

/** One helper of a helpers call. */
export interface HelperState {
  title: string;
  /** The model and thinking level it runs on. */
  model: string;
  thinking: string;
  status: "working" | "done" | "error" | "stopped";
  /** Its answer to Seelie, once it's done. */
  answer: string | null;
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

/* -------------------------------------------------------------------------- */
/* The job's plan                                                             */
/* -------------------------------------------------------------------------- */

/** The plan tool (tools/plan.ts): its calls draw the job's checklist instead of a step of their own. */
export const PLAN_TOOL = "plan";

export type PlanStepStatus = "pending" | "active" | "done" | "skipped";

export interface PlanStep {
  text: string;
  /** One or two words for the phone's progress bar. */
  short?: string;
  status: PlanStepStatus;
  /** Waits for the owner's OK (a post, ad spend, a photoshoot). */
  asks?: boolean;
}

/** A plan call's arguments: the whole list as it stands. */
export interface PlanArgs {
  title?: string;
  steps: PlanStep[];
  /** With the last update: what the owner may want next, as buttons. */
  next?: string[];
}

/** How long each thinking block took (ms, by its index in the message's content), kept on assistant messages. */
export interface ThinkingTimes {
  thinkingMs?: Record<string, number>;
}

/* -------------------------------------------------------------------------- */
/* Approval cards                                                             */
/* -------------------------------------------------------------------------- */

/** A picture or video on a card, and where the screen shows it from. */
export interface CardMedia {
  /** video:12@3, asset:5, chat:2, or an Instagram post's id. */
  ref: string;
  kind: "video" | "image";
  /** The picture, or the video file. */
  src: string | null;
  poster?: string | null;
  seconds?: number;
}

export interface AdRoom {
  cap: number | null;
  spentThisMonth: number;
  committed: number;
  /** What a new or bigger budget may be at most. */
  room: number;
}

/** What an approval shows, by what's asked: what goes out, what it costs, what's left. */
export type ApprovalCard =
  | {
      type: "post";
      post: "reel" | "photo" | "carousel" | "story";
      account: string | null;
      items: CardMedia[];
      caption: string;
      collaborators: string[];
      shareToFeed: boolean;
      aiLabel: boolean;
      /** A library song in the video: Instagram may mute it. */
      song: string | null;
    }
  | {
      type: "ad";
      name: string;
      objective: string;
      creative: CardMedia | null;
      /** Promoting a post that's already up (its media id). */
      post: string | null;
      text: string | null;
      headline: string | null;
      link: string | null;
      budget: number;
      currency: string;
      days: number | null;
      until: string | null;
      audience: string;
      placements: string;
      room: AdRoom | null;
      balance: number | null;
    }
  | {
      type: "ad-change";
      action: "resume" | "raise_budget" | "extend" | "archive";
      what: string;
      /** The budget now, when Meta says. */
      was: number | null;
      budget: number | null;
      end: string | null;
      currency: string;
      room: AdRoom | null;
      balance: number | null;
    }
  | {
      type: "shoot";
      title: string;
      /** Our own photo of the product, the one results are checked against. */
      product: CardMedia | null;
      looks: { id: string; line: string }[];
      images: number;
      left: number | null;
      capacity: number | null;
      /** When the image budget is back (ISO), if it runs out. */
      comesBack: string | null;
      blocked: boolean;
    };

/** What the owner may change on an approval before saying yes. */
export interface ApprovalEdits {
  caption?: string;
  shareToFeed?: boolean;
  budget?: number;
  days?: number;
  lookIds?: string[];
}

/* -------------------------------------------------------------------------- */
/* @ in the box                                                               */
/* -------------------------------------------------------------------------- */

/** A product or order picked with @: shown with its picture, sent as a token Seelie can't mistake. */
export interface Mention {
  kind: "product" | "order";
  label: string;
  sub: string;
  image: string | null;
  /** What goes in the message, e.g. @[Blue cotton kurta](product:PB-KU-101). */
  token: string;
}

/** `@[label](kind:id)` in a message. */
export const MENTION = /@\[([^\]\n]{1,80})\]\((product|order):([^)\s]{1,80})\)/g;

/* -------------------------------------------------------------------------- */
/* Reactions                                                                  */
/* -------------------------------------------------------------------------- */

/** A thumbs up or down, and maybe a note, on a video or shoot Seelie made or on one of its replies. */
export type ReactionInput =
  | { on: "video" | "shoot"; id: number; liked: boolean | null; note?: string | null }
  | { on: "reply"; chatId: string; seq: number; liked: boolean | null; note?: string | null; remember?: boolean };

/** Kept on an assistant message once the owner reacts to it. */
export interface Reaction {
  liked: boolean | null;
  note?: string | null;
  /** The note was saved as a memory. */
  remembered?: boolean;
  at: string;
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

/** A message sent while Seelie works: it reads it before its next step. */
export interface SteerInput {
  text: string;
  images?: ImageInput[];
}

/** Ends a message sent mid-reply, for the model only: the chat leaves it out of the bubble. */
export const STEER_NOTE = "(Sent while you were working: take it into account and carry on with the job.)";
