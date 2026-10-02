import type { AssistantMessage, Message } from "@paribelle/pi-ai";

import type { ChatMessage } from "./types";

/**
 * How much of the model's context window a chat fills: what the model reported for
 * its latest call (the prompt it read, the system prompt and tools included, plus what
 * it wrote back, less the thoughts Gemini doesn't send again), and an estimate for
 * whatever came after it (tool results, the next message). Types only, so the screen
 * can use it.
 */

const CHARS_PER_TOKEN = 4;
/** Gemini counts a photo at about 1,100 to 1,300 tokens. */
const IMAGE_TOKENS = 1_200;
/** About half a minute of video with sound, at roughly 300 tokens a second. */
const VIDEO_TOKENS = 9_000;

function blockTokens(content: Exclude<Message, AssistantMessage>["content"]): number {
  if (typeof content === "string") return Math.ceil(content.length / CHARS_PER_TOKEN);
  let tokens = 0;
  for (const block of content) {
    if (block.type === "text") tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN);
    else if (block.type === "image") tokens += IMAGE_TOKENS;
    else if (block.type === "video") tokens += VIDEO_TOKENS;
  }
  return tokens;
}

function estimate(message: Message): number {
  if (message.role === "assistant") {
    let chars = 0;
    for (const block of message.content) {
      if (block.type === "text") chars += block.text.length;
      else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments ?? {}).length;
    }
    return Math.ceil(chars / CHARS_PER_TOKEN);
  }
  if (message.role === "user" || message.role === "toolResult") return blockTokens(message.content);
  return 0;
}

/**
 * Tokens the chat takes up now: what the next message will be sent with, before it.
 * Null until the model has answered once (only it knows what the system prompt and tools take).
 */
export function contextTokens(messages: readonly ChatMessage[]): number | null {
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i].message;
    if (m.role !== "assistant" || m.stopReason === "aborted" || m.stopReason === "error") continue;
    const u = m.usage;
    if (u && u.input + u.cacheRead + u.cacheWrite > 0) {
      last = i;
      break;
    }
  }
  if (last < 0) return null;
  const u = (messages[last].message as AssistantMessage).usage;
  let tokens = u.input + u.cacheRead + u.cacheWrite + Math.max(0, u.output - (u.reasoning ?? 0));
  for (let i = last + 1; i < messages.length; i++) tokens += estimate(messages[i].message);
  return tokens;
}

/** 1234 → "1.2k", 1048576 → "1M". */
export function formatTokens(n: number) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}
