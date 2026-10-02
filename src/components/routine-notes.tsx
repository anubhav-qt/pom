"use client";

import { CalendarClock, ShieldAlert } from "lucide-react";
import { useCallback, useState } from "react";

import { routineNotesAction, routineSeenAction } from "@/app/(app)/seelie/actions";
import type { RoutineNotes as Notes } from "@/lib/seelie/routines";
import { whenLabel } from "@/lib/seelie/schedule";
import { useSeelie } from "@/lib/stores/seelie-store";

import { CornerNote, useCurrentScreen, useOpenSeelie, usePoll } from "./corner-note";

/**
 * Notes anywhere in the OMS about Seelie's routines:
 * - a run waits for an approval: every time the OMS is opened, until it's decided
 *   (closing it hides it until the next load);
 * - a run finished: once, until the owner opens its chat or closes the note (on any
 *   device: the server remembers what was seen).
 * Not for the chat open on Seelie's screen right now: that's already in view.
 */

const POLL_MS = 2 * 60_000;

const ENDED: Record<string, string> = {
  done: "ran",
  error: "failed",
  aborted: "was stopped",
  interrupted: "was cut off by a restart",
};

const quoted = (names: string[]) => (names.length === 1 ? `“${names[0]}”` : `${names.length} routines`);

export function RoutineNotes() {
  const openSeelie = useOpenSeelie();
  const screen = useCurrentScreen();
  const openChat = useSeelie((s) => s.chatId);
  const [notes, setNotes] = useState<Notes | null>(null);
  // Waiting runs closed on this load.
  const [closed, setClosed] = useState<string[]>([]);

  const check = useCallback(async () => {
    const n = await routineNotesAction();
    setNotes(n);
    return n;
  }, []);
  usePoll(check, POLL_MS);

  if (!notes) return null;
  const inView = (chatId: string) => screen === "seelie" && chatId === openChat;
  const waiting = notes.waiting.filter((w) => !closed.includes(w.runId) && !inView(w.chatId));
  const ran = notes.ran.filter((r) => !inView(r.chatId));

  async function seen(ids: number[]) {
    setNotes((n) => (n ? { ...n, ran: n.ran.filter((r) => !ids.includes(r.routineId)) } : n));
    await Promise.all(ids.map((id) => routineSeenAction(id).catch(() => {})));
  }

  return (
    <>
      {waiting.length ? (
        <CornerNote
          icon={<ShieldAlert />}
          title={`${quoted(waiting.map((w) => w.name))} ${waiting.length === 1 ? "is" : "are"} waiting for your approval`}
          action={{ label: "Open", onClick: () => void openSeelie(waiting[0].chatId) }}
          onClose={() => setClosed((c) => [...c, ...waiting.map((w) => w.runId)])}
        >
          {waiting.length > 1 ? waiting.map((w) => w.name).join(", ") : "Seelie won't go on until you approve or deny the change."}
        </CornerNote>
      ) : null}
      {ran.length ? (
        <CornerNote
          icon={<CalendarClock />}
          title={ran.length === 1 ? `${quoted([ran[0].name])} ${ENDED[ran[0].status] ?? "ran"}` : `${ran.length} routines ran`}
          action={{
            label: "Open",
            onClick: () => {
              void seen([ran[0].routineId]);
              void openSeelie(ran[0].chatId);
            },
          }}
          onClose={() => void seen(ran.map((r) => r.routineId))}
        >
          {ran.length === 1 ? whenLabel(ran[0].endedAt) : ran.map((r) => `${r.name}${r.status === "done" ? "" : ` (${ENDED[r.status] ?? r.status})`}`).join(", ")}
        </CornerNote>
      ) : null}
    </>
  );
}
