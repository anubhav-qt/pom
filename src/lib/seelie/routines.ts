import "server-only";

import { and, asc, desc, eq, gt, inArray, isNotNull, lte, sql } from "drizzle-orm";

import { db } from "@/db";
import { seelieChats, seelieRoutines, seelieRuns, users, type User } from "@/db/schema";

import { getCatalog } from "./catalog";
import { compactIfLong } from "./compact";
import { seelieConfig } from "./config";
import { reapStaleRuns, SeelieRunError, startRun, type StartedRun } from "./engine";
import { checkSchedule, describeSchedule, nextRun, whenLabel, type RoutineSchedule } from "./schedule";
import { ACTIVE_RUN, type RunStatus } from "./types";

/**
 * Seelie's routines: a message it gets on a schedule, each run replying in the routine's
 * own chat (made at the first run). The ThinkPad's sync service calls /api/cron/seelie
 * every minute; runDueRoutines starts the ones due. A time missed by more than
 * MISSED_MS (the ThinkPad off, Seelie offline) is skipped, not caught up; a time that
 * comes while the last run still waits on an approval is skipped too.
 */

const MISSED_MS = 12 * 3600_000;
const MAX_ROUTINES = 30;
const MAX_PROMPT = 4_000;
/** How long a finished run's "ran" note stays up when nobody has seen it. */
const NOTE_FRESH_MS = 3 * 86_400_000;

export interface RoutineInput {
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  model?: string | null;
  thinking?: string | null;
  autoApprove?: boolean;
  enabled?: boolean;
}

export interface RoutineView {
  id: number;
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  /** The schedule in words. */
  when: string;
  model: string | null;
  thinking: string | null;
  autoApprove: boolean;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  /** The last run's state: running, waiting (on an approval), done, error… */
  lastStatus: RunStatus | null;
  /** Why the last time didn't run. */
  lastNote: string | null;
  chatId: string | null;
}

type Row = typeof seelieRoutines.$inferSelect;

function view(r: Row, lastStatus: RunStatus | null): RoutineView {
  const schedule = r.schedule as RoutineSchedule;
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    schedule,
    when: describeSchedule(schedule),
    model: r.model,
    thinking: r.thinking,
    autoApprove: r.autoApprove,
    enabled: r.enabled,
    nextRunAt: r.nextRunAt?.toISOString() ?? null,
    lastRunAt: r.lastRunAt?.toISOString() ?? null,
    lastStatus,
    lastNote: r.lastNote,
    chatId: r.chatId,
  };
}

async function ownRoutine(user: User, id: number) {
  const [row] = await db.select().from(seelieRoutines).where(eq(seelieRoutines.id, id)).limit(1);
  if (!row || row.userId !== user.id) throw new SeelieRunError("That routine doesn't exist.", 404);
  return row;
}

function clean(input: RoutineInput) {
  const name = input.name.replace(/\s+/g, " ").trim().slice(0, 80);
  const prompt = input.prompt.trim();
  if (!name) throw new SeelieRunError("Give the routine a name.");
  if (!prompt) throw new SeelieRunError("Say what Seelie should do each time.");
  if (prompt.length > MAX_PROMPT) throw new SeelieRunError(`Keep what Seelie should do under ${MAX_PROMPT} characters.`);
  let schedule: RoutineSchedule;
  try {
    schedule = checkSchedule(input.schedule);
  } catch (err) {
    throw new SeelieRunError(err instanceof Error ? err.message : "That schedule doesn't work.");
  }
  return { name, prompt, schedule };
}

/* -------------------------------------------------------------------------- */
/* The list and its changes                                                   */
/* -------------------------------------------------------------------------- */

export async function listRoutines(user: User): Promise<RoutineView[]> {
  const rows = await db
    .select({ routine: seelieRoutines, lastStatus: seelieRuns.status, heartbeat: seelieRuns.heartbeatAt })
    .from(seelieRoutines)
    .leftJoin(seelieRuns, eq(seelieRuns.id, seelieRoutines.lastRunId))
    .where(eq(seelieRoutines.userId, user.id))
    .orderBy(asc(seelieRoutines.name), asc(seelieRoutines.id));
  return rows.map(({ routine, lastStatus, heartbeat }) => {
    // A run whose process died reads as interrupted (the chat's own view reaps it).
    const stale = lastStatus && ACTIVE_RUN.includes(lastStatus as RunStatus) && heartbeat && Date.now() - heartbeat.getTime() > 30_000;
    return view(routine, stale ? "interrupted" : ((lastStatus as RunStatus | null) ?? null));
  });
}

export async function saveRoutine(user: User, input: RoutineInput & { id?: number | null }): Promise<RoutineView> {
  const { name, prompt, schedule } = clean(input);
  const now = new Date();
  const fields = {
    name,
    prompt,
    schedule,
    model: input.model?.trim() || null,
    thinking: input.thinking?.trim() || null,
    autoApprove: input.autoApprove ?? false,
    enabled: input.enabled ?? true,
    updatedAt: now,
  };
  const nextRunAt = fields.enabled ? nextRun(schedule, now) : null;

  if (input.id) {
    const before = await ownRoutine(user, input.id);
    const [row] = await db
      .update(seelieRoutines)
      .set({ ...fields, nextRunAt, lastNote: before.enabled === fields.enabled ? before.lastNote : null })
      .where(eq(seelieRoutines.id, input.id))
      .returning();
    // The routine's switch is its chat's switch.
    if (row.chatId) await db.update(seelieChats).set({ autoApprove: row.autoApprove }).where(eq(seelieChats.id, row.chatId));
    return view(row, null);
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(seelieRoutines)
    .where(eq(seelieRoutines.userId, user.id));
  if (count >= MAX_ROUTINES) throw new SeelieRunError(`That's ${MAX_ROUTINES} routines already. Delete one first.`);
  const [row] = await db
    .insert(seelieRoutines)
    .values({ ...fields, userId: user.id, nextRunAt, createdAt: now })
    .returning();
  return view(row, null);
}

export async function setRoutineEnabled(user: User, id: number, enabled: boolean) {
  const row = await ownRoutine(user, id);
  await db
    .update(seelieRoutines)
    .set({ enabled, nextRunAt: enabled ? nextRun(row.schedule as RoutineSchedule, new Date()) : null, lastNote: null, updatedAt: new Date() })
    .where(eq(seelieRoutines.id, id));
}

/** The routine goes; its chat stays, as an ordinary chat. */
export async function deleteRoutine(user: User, id: number) {
  await ownRoutine(user, id);
  await db.delete(seelieRoutines).where(eq(seelieRoutines.id, id));
}

/** Kept in step with a chat's auto-approve switch, flipped in the chat. */
export async function routineAutoApprove(chatId: string, on: boolean) {
  await db.update(seelieRoutines).set({ autoApprove: on }).where(eq(seelieRoutines.chatId, chatId));
}

/* -------------------------------------------------------------------------- */
/* Running                                                                    */
/* -------------------------------------------------------------------------- */

/** A run of `r` in its chat (made now if it has none), compacted first if it has grown long. */
async function startRoutine(r: Row, manual: boolean): Promise<StartedRun> {
  const [user] = await db.select().from(users).where(eq(users.id, r.userId)).limit(1);
  if (!user || !user.active) throw new SeelieRunError("Its owner's account is switched off.");

  let chatId = r.chatId;
  if (chatId) {
    await reapStaleRuns(chatId);
    const [active] = await db
      .select({ status: seelieRuns.status })
      .from(seelieRuns)
      .where(and(eq(seelieRuns.chatId, chatId), inArray(seelieRuns.status, [...ACTIVE_RUN])))
      .limit(1);
    if (active) {
      throw new SeelieRunError(
        active.status === "waiting" ? "The last run is still waiting for your approval." : "The last run is still going.",
        409,
      );
    }
    await db.update(seelieChats).set({ autoApprove: r.autoApprove }).where(eq(seelieChats.id, chatId));
  } else {
    const [chat] = await db
      .insert(seelieChats)
      .values({ userId: r.userId, title: r.name, model: r.model, thinking: r.thinking, autoApprove: r.autoApprove })
      .returning({ id: seelieChats.id });
    chatId = chat.id;
    await db.update(seelieRoutines).set({ chatId }).where(eq(seelieRoutines.id, r.id));
  }

  const catalog = await getCatalog();
  const model = catalog.models.find((m) => m.id === r.model) ?? catalog.models.find((m) => m.id === catalog.defaultModel);
  if (model) {
    await compactIfLong(chatId, model.contextWindow, AbortSignal.timeout(200_000)).catch((err: unknown) =>
      console.error("[seelie] compacting", chatId, err),
    );
  }

  const started = await startRun(user, {
    chatId,
    text: r.prompt,
    model: r.model ?? undefined,
    thinking: r.thinking ?? undefined,
    routine: { name: r.name, schedule: describeSchedule(r.schedule as RoutineSchedule), manual },
  });
  await db
    .update(seelieRoutines)
    .set({ lastRunAt: new Date(), lastRunId: started.runId, lastNote: null })
    .where(eq(seelieRoutines.id, r.id));
  return started;
}

/** Run it now, outside its schedule (which carries on as it was). */
export async function runRoutineNow(user: User, id: number): Promise<StartedRun> {
  if (!seelieConfig()) throw new SeelieRunError("Seelie is offline on this server.", 503);
  return startRoutine(await ownRoutine(user, id), true);
}

export interface DueResult {
  id: number;
  name: string;
  outcome: "started" | "skipped" | "failed";
  note?: string;
}

/**
 * Start every routine that's due. Each is claimed by moving its next time on first, so
 * two calls at once (or two processes) never start the same one twice.
 */
export async function runDueRoutines(now = new Date()): Promise<DueResult[]> {
  if (!seelieConfig()) return [];
  const due = await db
    .select()
    .from(seelieRoutines)
    .where(and(eq(seelieRoutines.enabled, true), isNotNull(seelieRoutines.nextRunAt), lte(seelieRoutines.nextRunAt, now)))
    .orderBy(asc(seelieRoutines.nextRunAt))
    .limit(20);

  const results: DueResult[] = [];
  for (const r of due) {
    const slot = r.nextRunAt!;
    let next: Date | null = null;
    let schedule: RoutineSchedule | null = null;
    try {
      schedule = checkSchedule(r.schedule);
      next = nextRun(schedule, now);
    } catch {
      // A schedule that no longer reads: switched off, with a note, rather than retried every minute.
    }
    const claimed = await db
      .update(seelieRoutines)
      .set(next ? { nextRunAt: next } : { enabled: false, nextRunAt: null, lastNote: "Its schedule couldn't be read, so it was switched off. Edit it." })
      .where(and(eq(seelieRoutines.id, r.id), eq(seelieRoutines.nextRunAt, slot)))
      .returning({ id: seelieRoutines.id });
    if (!claimed.length || !schedule) continue;

    const note = async (text: string) => {
      await db.update(seelieRoutines).set({ lastNote: text }).where(eq(seelieRoutines.id, r.id));
    };
    if (now.getTime() - slot.getTime() > MISSED_MS) {
      const text = `Missed ${whenLabel(slot)}: Seelie was offline then.`;
      await note(text);
      results.push({ id: r.id, name: r.name, outcome: "skipped", note: text });
      continue;
    }
    try {
      await startRoutine(r, false);
      results.push({ id: r.id, name: r.name, outcome: "started" });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      const busy = err instanceof SeelieRunError && err.status === 409;
      const text = `${busy ? "Skipped" : "Couldn't run"} ${whenLabel(slot)}: ${why}`;
      await note(text);
      if (!busy) console.error("[seelie] routine", r.id, err);
      results.push({ id: r.id, name: r.name, outcome: busy ? "skipped" : "failed", note: text });
    }
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/* Notes anywhere in the OMS                                                  */
/* -------------------------------------------------------------------------- */

export interface RoutineNotes {
  /** Runs that finished since the owner last saw them. */
  ran: { routineId: number; runId: string; name: string; chatId: string; status: RunStatus; endedAt: string }[];
  /** Routines whose run waits on an approval. */
  waiting: { routineId: number; runId: string; name: string; chatId: string }[];
}

export async function routineNotes(user: User): Promise<RoutineNotes> {
  const rows = await db
    .select({
      id: seelieRoutines.id,
      name: seelieRoutines.name,
      chatId: seelieRoutines.chatId,
      seen: seelieRoutines.seenRunId,
      runId: seelieRuns.id,
      status: seelieRuns.status,
      endedAt: seelieRuns.endedAt,
      heartbeat: seelieRuns.heartbeatAt,
    })
    .from(seelieRoutines)
    .innerJoin(seelieRuns, eq(seelieRuns.id, seelieRoutines.lastRunId))
    .where(and(eq(seelieRoutines.userId, user.id), isNotNull(seelieRoutines.chatId), gt(seelieRuns.startedAt, new Date(Date.now() - NOTE_FRESH_MS))))
    .orderBy(desc(seelieRuns.startedAt));

  const notes: RoutineNotes = { ran: [], waiting: [] };
  for (const r of rows) {
    let status = r.status as RunStatus;
    let endedAt = r.endedAt;
    // A run whose process died (a restart) ended there, whatever it was doing.
    if (ACTIVE_RUN.includes(status) && Date.now() - r.heartbeat.getTime() > 30_000) {
      status = "interrupted";
      endedAt = r.heartbeat;
    }
    if (status === "waiting") {
      notes.waiting.push({ routineId: r.id, runId: r.runId, name: r.name, chatId: r.chatId! });
    } else if (!ACTIVE_RUN.includes(status) && endedAt && r.seen !== r.runId) {
      notes.ran.push({ routineId: r.id, runId: r.runId, name: r.name, chatId: r.chatId!, status, endedAt: endedAt.toISOString() });
    }
  }
  return notes;
}

/** The owner has seen these runs (closed their note, or opened the chat). */
export async function markRoutinesSeen(user: User, which: { routineId?: number; chatId?: string }) {
  const where = which.routineId ? eq(seelieRoutines.id, which.routineId) : which.chatId ? eq(seelieRoutines.chatId, which.chatId) : null;
  if (!where) return;
  await db
    .update(seelieRoutines)
    .set({ seenRunId: sql`${seelieRoutines.lastRunId}` })
    .where(and(where, eq(seelieRoutines.userId, user.id)));
}
