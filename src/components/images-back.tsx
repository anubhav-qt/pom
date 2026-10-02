"use client";

import { Camera } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { imageResetAction } from "@/app/(app)/seelie/actions";
import type { ImageReset } from "@/lib/seelie/studio/budget";

import { CornerNote, useOpenSeelie } from "./corner-note";

/**
 * A small note anywhere in the OMS when the image model's limit has reset: photoshoots
 * can run again. Once per reset (remembered in this browser), and only for a reset in
 * the last few hours, so a new device doesn't bring up an old one. "Open Seelie" opens
 * the chat whose shoot has looks waiting, if there is one.
 */

const SEEN_KEY = "seelie.imagesBackSeen";
const FRESH_MS = 6 * 3600_000;
const POLL_MS = 5 * 60_000;

function seen(): string | null {
  try {
    return window.localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function markSeen(at: string) {
  try {
    window.localStorage.setItem(SEEN_KEY, at);
  } catch {
    // Private mode: it shows again on the next load, which is fine.
  }
}

export function ImagesBack() {
  const openSeelie = useOpenSeelie();
  const [reset, setReset] = useState<ImageReset | null>(null);
  // The reset this page closed the note for (a later reset shows again).
  const [closed, setClosed] = useState<string | null>(null);

  const check = useCallback(async () => {
    // null: Seelie isn't set up on this server; undefined: the check failed this time.
    const r = await imageResetAction().catch(() => undefined);
    if (r !== undefined) setReset(r);
    return r;
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const tick = async () => {
      const r = await check();
      if (!live || r === null) return;
      // Look again just after the limit lifts, or in a while.
      const until = r?.blockedUntil ? new Date(r.blockedUntil).getTime() - Date.now() + 5_000 : POLL_MS;
      timer = setTimeout(() => void tick(), Math.max(5_000, Math.min(until, POLL_MS)));
    };
    void tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check]);

  const back = reset?.cameBack ?? null;
  if (!back || closed === back || seen() === back || Date.now() - new Date(back).getTime() > FRESH_MS) return null;

  function close() {
    markSeen(back!);
    setClosed(back);
  }

  async function open() {
    close();
    await openSeelie(reset?.waitingChat ?? null);
  }

  const waiting = reset?.waiting ?? 0;
  return (
    <CornerNote icon={<Camera />} title="Photoshoots are back" action={{ label: "Open Seelie", onClick: () => void open() }} onClose={close}>
      The image limit has reset, so Seelie can make new photos again.
      {waiting ? ` ${waiting === 1 ? "1 look is" : `${waiting} looks are`} waiting for it.` : ""}
    </CornerNote>
  );
}
