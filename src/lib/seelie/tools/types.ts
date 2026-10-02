import type { ImageContent, Static, TSchema, VideoContent } from "@paribelle/pi-ai";

import type { User } from "@/db/schema";

import type { ToolKind } from "../types";

/** What a tool gets besides its arguments. */
export interface ToolContext {
  user: User;
  chatId: string;
  runId: string;
  signal: AbortSignal;
  /** A line for the tool card while it works ("Reading page 3 of 7"). */
  progress: (text: string) => void;
  /** Every image attached in this chat so far, oldest first (for reels, product photos). */
  chatImages: () => Promise<ImageContent[]>;
  /** The model takes video and sound (tools then send clips, not stills). */
  canWatch: boolean;
}

/** What a tool hands back: what the model reads, and optionally images it sees and clips it watches. */
export interface ToolOutput {
  /** Sent to the model as is, followed by `data` as JSON when there is some. */
  text?: string;
  data?: unknown;
  images?: ImageContent[];
  /** Clips or sounds with their bytes (media/watch.ts). The chat keeps only their refs. */
  videos?: VideoContent[];
  /** The tool ran but what it was asked can't be done; the model sees an error. */
  error?: boolean;
}

/**
 * One of Seelie's tools. Tools are broad, not one per button: each takes the
 * filters and options its job can use, and acts on many things at once.
 */
export interface SeelieTool<P extends TSchema = TSchema> {
  name: string;
  /** A few words for the tool card. */
  label: string;
  description: string;
  parameters: P;
  /** Fixed, or worked out from the arguments (a dry run only reads). */
  kind: ToolKind | ((args: Static<P>) => ToolKind);
  /** Owners only (staff don't get it). */
  ownerOnly?: boolean;
  /** Off when its feature is switched off or what it needs isn't set up. */
  enabled?: () => boolean;
  /** One line saying what this call will do, for the approval card. */
  summary: (args: Static<P>) => string;
  execute: (args: Static<P>, ctx: ToolContext) => Promise<ToolOutput>;
}

export function defineTool<P extends TSchema>(tool: SeelieTool<P>): SeelieTool<P> {
  return tool;
}

/** A tool's kind for these arguments. */
export function kindOf(tool: SeelieTool, args: unknown): ToolKind {
  return typeof tool.kind === "function" ? tool.kind(args as never) : tool.kind;
}

/** A tool refusing politely: the model reads the message as an error result. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}
