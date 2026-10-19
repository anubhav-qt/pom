import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { db } from "@/db";
import { seelieChats, seelieMessages, seelieShoots, seelieVideos, type User } from "@/db/schema";

import { addMemory } from "./memories";
import type { Reaction, ReactionInput } from "./types";

/**
 * The owner's thumbs and notes on what Seelie made or said. A video's or a shoot's verdict
 * goes where Seelie already reads it (liked, notes: video_library and photoshoot show it);
 * a reply's stays on the message, and a note marked "remember" becomes a memory.
 */

export class ReactionError extends Error {}

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 1000) || null;

export async function react(user: User, input: ReactionInput) {
  const note = clean(input.note);
  if (input.on !== "reply") {
    const table = input.on === "video" ? seelieVideos : seelieShoots;
    const [row] = await db.select({ userId: table.userId }).from(table).where(eq(table.id, input.id)).limit(1);
    if (!row) throw new ReactionError(`That ${input.on === "video" ? "video" : "shoot"} isn't there any more.`);
    if (row.userId !== null && row.userId !== user.id && user.role !== "owner") throw new ReactionError("That isn't yours to rate.");
    await db
      .update(table)
      .set({ liked: input.liked, ...(input.note !== undefined ? { notes: note } : {}), updatedAt: new Date() })
      .where(eq(table.id, input.id));
    return;
  }

  const [chat] = await db.select({ userId: seelieChats.userId }).from(seelieChats).where(eq(seelieChats.id, input.chatId)).limit(1);
  if (!chat || chat.userId !== user.id) throw new ReactionError("That chat doesn't exist.");
  let remembered = false;
  if (input.remember && note) {
    await addMemory(user, note, input.chatId);
    remembered = true;
  }
  const reaction: Reaction = { liked: input.liked, note, ...(remembered ? { remembered } : {}), at: new Date().toISOString() };
  const done = await db
    .update(seelieMessages)
    .set({ message: sql`jsonb_set(${seelieMessages.message}, '{reaction}', ${JSON.stringify(reaction)}::jsonb, true)` })
    .where(and(eq(seelieMessages.chatId, input.chatId), eq(seelieMessages.seq, input.seq), eq(seelieMessages.role, "assistant")))
    .returning({ id: seelieMessages.id });
  if (!done.length) throw new ReactionError("That reply isn't there any more.");
}
