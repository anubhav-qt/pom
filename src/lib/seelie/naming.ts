import "server-only";

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { seelieChats } from "@/db/schema";

import { generateContent, HELPER_MODEL } from "./gemini";

/**
 * Seelie names its chats. A new chat shows the start of its first message at once;
 * a quick helper call then gives it a short name from what was asked. A first message
 * that says too little ("hi") is named again from the first reply. A name the user
 * gave the chat is never replaced: the update only lands while the title is still the
 * one Seelie put there.
 */

const MAX_TITLE = 60;
const SKIP = "SKIP";

/** The start of the first message, shown until Seelie has named the chat. */
export function provisionalTitle(text: string, fallback: string) {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return fallback;
  return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 3).trimEnd()}…` : line;
}

const INSTRUCTION = `You name chats in Seelie, the AI agent of Paribelle's order management system (an Indian women's ethnic wear brand selling on Amazon, Flipkart, Meesho, Myntra and paribelle.in).
Answer with only the chat's name: 2 to 6 words, sentence case, no quotes, no full stop, no emoji. Name the task or subject, the way a person would label the chat in a list (e.g. "Restock plan for Anarkali kurtas", "Flipkart returns this week", "Reel for the yellow set").
Keep product names, SKUs, order ids and marketplace names as written. Write in the language the user wrote in.
If the conversation doesn't yet say what it's about (a greeting, a thank you), answer ${SKIP}.`;

function clean(answer: string) {
  const line = answer.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const title = line
    .replace(/^(title|name)\s*:\s*/i, "")
    .replace(/^["'“‘*_`]+|["'”’*_`.]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title || title.toUpperCase() === SKIP) return null;
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 3).trimEnd()}…` : title;
}

/**
 * A name for the chat from its first message (and the first reply, when there is one),
 * or null when it says too little or the helper model can't be reached.
 */
async function suggestTitle(input: { message: string; attachments: string | null; reply?: string }) {
  const lines = [
    `User: ${input.message.slice(0, 4000) || "(no text)"}`,
    ...(input.attachments ? [`(The user attached ${input.attachments}.)`] : []),
    ...(input.reply ? [`Seelie: ${input.reply.slice(0, 3000)}`] : []),
  ];
  try {
    const { text } = await generateContent(
      HELPER_MODEL,
      {
        systemInstruction: { parts: [{ text: INSTRUCTION }] },
        contents: [{ role: "user", parts: [{ text: lines.join("\n\n") }] }],
      },
      { signal: new AbortController().signal, timeoutMs: 30_000 },
    );
    return clean(text);
  } catch (err) {
    console.warn("[seelie] naming the chat failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Name a chat whose title is still `current` (the one Seelie set). Returns the new
 * title when it landed, null when the model passed or the user renamed it meanwhile.
 */
export async function nameChat(
  chatId: string,
  current: string,
  input: { message: string; attachments: string | null; reply?: string },
): Promise<string | null> {
  const title = await suggestTitle(input);
  if (!title || title === current) return null;
  const done = await db
    .update(seelieChats)
    .set({ title })
    .where(and(eq(seelieChats.id, chatId), eq(seelieChats.title, current)))
    .returning({ id: seelieChats.id })
    .catch(() => []);
  return done.length ? title : null;
}
