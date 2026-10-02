import "server-only";

import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";

import { db } from "@/db";
import { seelieMemories, type User } from "@/db/schema";

/**
 * What a person told Seelie to remember ("remember that…", "from now on…"): their own,
 * read into every chat they have with Seelie until they delete it (in Seelie's settings,
 * or by asking Seelie, which asks before it forgets).
 */

export const MAX_MEMORY = 500;
export const MAX_MEMORIES = 100;

export interface MemoryView {
  id: number;
  text: string;
  createdAt: string;
  updatedAt: string;
}

/** Something the person can fix (too long, too many): shown to them or the model as is. */
export class MemoryError extends Error {}

function view(r: typeof seelieMemories.$inferSelect): MemoryView {
  return { id: r.id, text: r.text, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

function clean(text: string) {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) throw new MemoryError("There's nothing to remember.");
  if (t.length > MAX_MEMORY) throw new MemoryError(`A memory is at most ${MAX_MEMORY} characters; this is ${t.length}. Split it or say it shorter.`);
  return t;
}

const sameText = (text: string) => sql`lower(${seelieMemories.text}) = lower(${text})`;

export async function listMemories(user: Pick<User, "id">): Promise<MemoryView[]> {
  const rows = await db
    .select()
    .from(seelieMemories)
    .where(eq(seelieMemories.userId, user.id))
    .orderBy(asc(seelieMemories.createdAt), asc(seelieMemories.id));
  return rows.map(view);
}

/** Saves a memory; the same words again return the one already kept. */
export async function addMemory(user: Pick<User, "id">, text: string, chatId?: string | null): Promise<{ memory: MemoryView; existed: boolean }> {
  const t = clean(text);
  const [dup] = await db.select().from(seelieMemories).where(and(eq(seelieMemories.userId, user.id), sameText(t))).limit(1);
  if (dup) return { memory: view(dup), existed: true };
  const [{ n }] = await db.select({ n: count() }).from(seelieMemories).where(eq(seelieMemories.userId, user.id));
  if (n >= MAX_MEMORIES) throw new MemoryError(`Seelie keeps up to ${MAX_MEMORIES} memories each, and this is full. Delete some in Seelie's settings (Memories) first.`);
  const [row] = await db.insert(seelieMemories).values({ userId: user.id, text: t, chatId: chatId ?? null }).returning();
  return { memory: view(row), existed: false };
}

export async function updateMemory(user: Pick<User, "id">, id: number, text: string): Promise<MemoryView> {
  const t = clean(text);
  const [dup] = await db
    .select({ id: seelieMemories.id })
    .from(seelieMemories)
    .where(and(eq(seelieMemories.userId, user.id), ne(seelieMemories.id, id), sameText(t)))
    .limit(1);
  if (dup) throw new MemoryError("That's already remembered word for word.");
  const [row] = await db
    .update(seelieMemories)
    .set({ text: t, updatedAt: new Date() })
    .where(and(eq(seelieMemories.id, id), eq(seelieMemories.userId, user.id)))
    .returning();
  if (!row) throw new MemoryError(`There's no memory ${id}.`);
  return view(row);
}

/** Deletes this person's memories with these ids; returns what went. */
export async function deleteMemories(user: Pick<User, "id">, ids: number[]): Promise<MemoryView[]> {
  if (!ids.length) return [];
  const rows = await db
    .delete(seelieMemories)
    .where(and(eq(seelieMemories.userId, user.id), inArray(seelieMemories.id, ids)))
    .returning();
  return rows.map(view);
}

/** This person's memories with these ids (others' never show). */
export async function memoriesById(user: Pick<User, "id">, ids: number[]): Promise<MemoryView[]> {
  if (!ids.length) return [];
  const rows = await db
    .select()
    .from(seelieMemories)
    .where(and(eq(seelieMemories.userId, user.id), inArray(seelieMemories.id, ids)))
    .orderBy(asc(seelieMemories.id));
  return rows.map(view);
}

/** The system prompt's part: how memory works, and everything this person asked Seelie to keep. */
export function memorySection(user: Pick<User, "name">, memories: MemoryView[]) {
  const lines = [
    `Memory (${user.name}'s own, kept across every chat until they delete it):`,
    `- When ${user.name} asks you to remember something ("remember…", "don't forget…", "from now on…", "always…", "never…", "keep in mind…", "note that…"), save it with memory remember straight away: one line that stands on its own, in their words, naming who or what it's about (not "it" or "that"). Then say in a few words that you'll remember it.`,
    "- Save only what they asked you to keep, never things you noticed yourself. Something to do on a schedule is a routine, not a memory.",
    "- Follow what's remembered in every reply without being reminded; when a newer request clashes with a memory, do what they ask now and offer to change the memory.",
    "- To forget (\"forget that\", \"you don't need to remember…\"), call memory forget with the ids below; the card asks them first. To change one, memory update.",
    "- Never say you'll remember something without saving it, and never claim to remember something that isn't listed here. They can see and edit every memory in Seelie's settings (Memories).",
  ];
  lines.push(
    memories.length
      ? [`What ${user.name} asked you to remember (id: text):`, ...memories.map((m) => `- [${m.id}] ${m.text}`)].join("\n")
      : `${user.name} hasn't asked you to remember anything yet.`,
  );
  return lines.join("\n");
}
