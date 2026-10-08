import "server-only";

import type { Message } from "@paribelle/pi-ai";
import { and, asc, eq, gt, isNull } from "drizzle-orm";

import { db } from "@/db";
import { seelieChats, seelieMessages } from "@/db/schema";

import { contextTokens } from "./context";
import { generateContent, HELPER_MODEL } from "./gemini";
import type { ChatMessage } from "./types";

/**
 * A routine's chat grows by a run every time. Before a run, if the chat fills more than
 * COMPACT_AT of the model's window, the helper model sums up everything but the last
 * KEEP_RUNS runs; Seelie then reads that summary (in its instructions) and those runs word
 * for word. Conservative on purpose: it waits until the chat is well over half full, keeps
 * the recent runs whole, and asks for every number, decision and open question to be kept.
 * Nothing is deleted: the screen still shows every message.
 */

const COMPACT_AT = 0.6;
const KEEP_RUNS = 3;
/** One tool result's share of the transcript the helper reads. */
const RESULT_CHARS = 1_500;
/** The most of the transcript sent in one go (the oldest part is dropped first). */
const TRANSCRIPT_CHARS = 600_000;

const INSTRUCTION = `You compact the history of a chat between a shop owner and Seelie, the AI agent of PariBelle's order management system (an Indian women's ethnic wear brand). The chat is a routine: the same request runs on a schedule, and each run's reply is in the history.
Write the summary Seelie will read instead of these older messages. Keep, exactly as written: every number with its date or period (sales, spend, stock, counts, prices), product names, SKUs, order ids, ad and campaign ids; what was decided, approved or denied; what the owner asked for or corrected; anything still open or promised. Group it by run, oldest first, with each run's date. Drop greetings, repetition, and tool mechanics that don't matter later.
Plain text, no preamble. If an earlier summary is given, fold it in.`;

function textOf(message: Message): string {
  if (message.role === "assistant") {
    return message.content
      .map((c) => (c.type === "text" ? c.text : c.type === "toolCall" ? `[called ${c.name} ${JSON.stringify(c.arguments ?? {}).slice(0, 400)}]` : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof message.content === "string") return message.content;
  const parts = message.content.map((c) => (c.type === "text" ? c.text : c.type === "image" ? "[photo]" : "[clip]"));
  const text = parts.join("\n");
  return message.role === "toolResult" && text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)} …` : text;
}

function transcript(rows: { message: Message; createdAt: Date }[]) {
  const lines = rows.map(({ message, createdAt }) => {
    const who = message.role === "user" ? "Owner" : message.role === "assistant" ? "Seelie" : `Result of ${"toolName" in message ? message.toolName : "a tool"}`;
    return `${who} (${createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC): ${textOf(message)}`;
  });
  let text = lines.join("\n\n");
  if (text.length > TRANSCRIPT_CHARS) text = `… (older part left out)\n${text.slice(-TRANSCRIPT_CHARS)}`;
  return text;
}

/**
 * Compact the chat if it has grown past COMPACT_AT of `contextWindow`. Returns whether it
 * did; a failure leaves the chat as it was (the run goes ahead uncompacted).
 */
export async function compactIfLong(chatId: string, contextWindow: number, signal: AbortSignal): Promise<boolean> {
  const [chat] = await db
    .select({ summary: seelieChats.summary, through: seelieChats.summaryThrough })
    .from(seelieChats)
    .where(eq(seelieChats.id, chatId));
  if (!chat) return false;
  const through = chat.through ?? 0;

  const rows = await db
    .select({ seq: seelieMessages.seq, runId: seelieMessages.runId, message: seelieMessages.message, createdAt: seelieMessages.createdAt })
    .from(seelieMessages)
    .where(and(eq(seelieMessages.chatId, chatId), gt(seelieMessages.seq, through)))
    .orderBy(asc(seelieMessages.seq));
  const entries: ChatMessage[] = rows.map((r) => ({ seq: r.seq, runId: r.runId, message: r.message as Message, createdAt: r.createdAt.toISOString() }));
  const tokens = contextTokens(entries);
  if (tokens === null || tokens < contextWindow * COMPACT_AT) return false;

  // Keep the last KEEP_RUNS runs whole: from the first message of the oldest of them.
  const runs: string[] = [];
  for (const r of rows) if (r.runId && runs.at(-1) !== r.runId) runs.push(r.runId);
  if (runs.length <= KEEP_RUNS) return false;
  const keepFrom = rows.find((r) => r.runId === runs[runs.length - KEEP_RUNS])!.seq;
  const older = rows.filter((r) => r.seq < keepFrom);
  if (!older.length) return false;

  const input = [
    chat.summary ? `Earlier summary:\n${chat.summary}` : "",
    `Messages to fold in:\n${transcript(older.map((r) => ({ message: r.message as Message, createdAt: r.createdAt })))}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const { text } = await generateContent(
    HELPER_MODEL,
    { systemInstruction: { parts: [{ text: INSTRUCTION }] }, contents: [{ role: "user", parts: [{ text: input }] }] },
    { signal, timeoutMs: 180_000 },
  );
  const summary = text.trim();
  if (!summary) return false;
  // Only if nobody compacted it meanwhile.
  const done = await db
    .update(seelieChats)
    .set({ summary, summaryThrough: keepFrom - 1 })
    .where(and(eq(seelieChats.id, chatId), chat.through === null ? isNull(seelieChats.summaryThrough) : eq(seelieChats.summaryThrough, chat.through)))
    .returning({ id: seelieChats.id });
  return done.length > 0;
}

/** What Seelie reads in place of the compacted messages, for its instructions. */
export function summarySection(summary: string) {
  return `Earlier in this chat (compacted: the older runs, summed up; the owner still sees them in full, and the latest runs follow as they were):\n${summary}`;
}
