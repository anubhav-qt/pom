import "server-only";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import { seelieChats, seelieMessages, seelieRuns, seelieToolCalls, users, type User } from "@/db/schema";
import type { AssistantMessage, Message } from "@paribelle/pi-ai";

import { leanEntry, reapStaleRuns, SeelieRunError, setLiveAutoApprove, toolRowFrom } from "./engine";
import { toolLabels } from "./tools";
import { ACTIVE_RUN, type ChatSummary, type ChatView, type RunInfo, type RunStatus } from "./types";

/** A user's chats and what the sidebar and the chat screen show of them. */

const SIDEBAR_LIMIT = 300;

async function ownChat(user: User, chatId: string) {
  const [chat] = await db.select().from(seelieChats).where(eq(seelieChats.id, chatId)).limit(1);
  if (!chat || chat.userId !== user.id) throw new SeelieRunError("That chat doesn't exist.", 404);
  return chat;
}

export async function listChats(user: User): Promise<ChatSummary[]> {
  const rows = await db
    .select({
      id: seelieChats.id,
      title: seelieChats.title,
      pinned: seelieChats.pinned,
      updatedAt: seelieChats.updatedAt,
      active: sql<boolean>`EXISTS (
        SELECT 1 FROM ${seelieRuns} r
        WHERE r.chat_id = ${seelieChats.id}
          AND r.status IN ('running', 'waiting')
          AND r.heartbeat_at > now() - interval '30 seconds'
      )`,
    })
    .from(seelieChats)
    .where(eq(seelieChats.userId, user.id))
    .orderBy(desc(seelieChats.pinned), desc(seelieChats.updatedAt))
    .limit(SIDEBAR_LIMIT);
  return rows.map((r) => ({ ...r, title: r.title || "New chat", updatedAt: r.updatedAt.toISOString() }));
}

export async function getChatView(user: User, chatId: string): Promise<ChatView> {
  const chat = await ownChat(user, chatId);
  await reapStaleRuns(chatId);

  const [messages, runs, tools] = await Promise.all([
    db.select().from(seelieMessages).where(eq(seelieMessages.chatId, chatId)).orderBy(asc(seelieMessages.seq)),
    db.select().from(seelieRuns).where(eq(seelieRuns.chatId, chatId)).orderBy(asc(seelieRuns.startedAt)),
    db
      .select({ row: seelieToolCalls, decider: users.name })
      .from(seelieToolCalls)
      .leftJoin(users, eq(users.id, seelieToolCalls.decidedBy))
      .where(eq(seelieToolCalls.chatId, chatId))
      .orderBy(asc(seelieToolCalls.id)),
  ]);

  const labels = toolLabels();
  const runInfos: RunInfo[] = runs.map((r) => ({
    id: r.id,
    status: r.status as RunStatus,
    model: r.model,
    thinking: r.thinking,
    error: r.error,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
  }));
  const activeRow = [...runs].reverse().find((r) => ACTIVE_RUN.includes(r.status as RunStatus)) ?? null;

  return {
    id: chat.id,
    title: chat.title || "New chat",
    model: chat.model,
    thinking: chat.thinking,
    autoApprove: chat.autoApprove,
    pinned: chat.pinned,
    messages: messages.map((m) =>
      leanEntry({ seq: m.seq, runId: m.runId, message: m.message as Message, createdAt: m.createdAt.toISOString() }),
    ),
    tools: tools.map((t) => toolRowFrom(t.row, labels, t.decider)),
    runs: runInfos,
    activeRun: activeRow ? (runInfos.find((r) => r.id === activeRow.id) ?? null) : null,
    partial: (activeRow?.partial as AssistantMessage | null) ?? null,
  };
}

export async function renameChat(user: User, chatId: string, title: string) {
  await ownChat(user, chatId);
  const clean = title.replace(/\s+/g, " ").trim().slice(0, 120);
  if (!clean) throw new SeelieRunError("Give it a name.");
  await db.update(seelieChats).set({ title: clean }).where(eq(seelieChats.id, chatId));
}

export async function pinChat(user: User, chatId: string, pinned: boolean) {
  await ownChat(user, chatId);
  await db.update(seelieChats).set({ pinned }).where(eq(seelieChats.id, chatId));
}

export async function setAutoApprove(user: User, chatId: string, on: boolean) {
  await ownChat(user, chatId);
  await db.update(seelieChats).set({ autoApprove: on }).where(eq(seelieChats.id, chatId));
  setLiveAutoApprove(chatId, on);
}

export async function deleteChats(user: User, chatIds: string[]) {
  if (chatIds.length === 0) return;
  for (const id of chatIds) await reapStaleRuns(id);
  const busy = await db
    .select({ id: seelieRuns.chatId })
    .from(seelieRuns)
    .innerJoin(seelieChats, eq(seelieChats.id, seelieRuns.chatId))
    .where(and(inArray(seelieRuns.chatId, chatIds), eq(seelieChats.userId, user.id), inArray(seelieRuns.status, [...ACTIVE_RUN])))
    .limit(1);
  if (busy.length) throw new SeelieRunError("Seelie is still replying in that chat. Stop it first.", 409);
  await db.delete(seelieChats).where(and(inArray(seelieChats.id, chatIds), eq(seelieChats.userId, user.id)));
}

/** One image from a chat's transcript: block `index` of message `seq`. */
export async function chatImage(user: User, chatId: string, seq: number, index: number) {
  await ownChat(user, chatId);
  const [row] = await db
    .select({ message: seelieMessages.message })
    .from(seelieMessages)
    .where(and(eq(seelieMessages.chatId, chatId), eq(seelieMessages.seq, seq)))
    .limit(1);
  const message = row?.message as Message | undefined;
  if (!message || message.role === "assistant" || typeof message.content === "string") return null;
  const block = message.content[index];
  if (!block || block.type !== "image") return null;
  return { bytes: Buffer.from(block.data, "base64"), mimeType: block.mimeType };
}
