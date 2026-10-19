"use client";

import { AlertTriangle, Sparkles } from "lucide-react";
import { useEffect } from "react";

import { useSeelie } from "@/lib/stores/seelie-store";

import { CornerNote, useCurrentScreen, useOpenSeelie } from "./corner-note";

/**
 * "Seelie is done" anywhere in the OMS: a reply that ended while the owner was on another
 * screen (the reply keeps streaming there) gets a note that opens its chat. Seelie's own
 * screen needs none; a note older than half an hour goes quietly.
 */

const ENDED: Record<string, string> = {
  done: "is done",
  error: "stopped with an error",
  aborted: "was stopped",
  interrupted: "was cut off by a restart",
};

const STALE_MS = 30 * 60_000;

export function SeelieNotes() {
  const screen = useCurrentScreen();
  const finished = useSeelie((s) => s.finished);
  const openSeelie = useOpenSeelie();

  // Back on Seelie's screen, the chat shows it.
  useEffect(() => {
    if (screen === "seelie" && finished) useSeelie.getState().clearFinished();
  }, [screen, finished]);

  if (!finished || screen === "seelie" || Date.now() - finished.at > STALE_MS) return null;
  const ok = finished.status === "done";
  return (
    <CornerNote
      icon={ok ? <Sparkles /> : <AlertTriangle />}
      title={`Seelie ${ENDED[finished.status] ?? "is done"}`}
      action={{
        label: "Open",
        onClick: () => {
          useSeelie.getState().clearFinished();
          void openSeelie(finished.chatId);
        },
      }}
      onClose={() => useSeelie.getState().clearFinished()}
    >
      {finished.title || "Your chat"}
    </CornerNote>
  );
}
