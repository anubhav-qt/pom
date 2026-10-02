"use client";

import { Camera, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { imageResetAction } from "@/app/(app)/seelie/actions";
import { withBasePath } from "@/lib/base-path";
import { resolveScreen, screenFromPath, useScreenNav } from "@/lib/stores/screen-nav";
import type { ImageReset } from "@/lib/seelie/studio/budget";

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
  const pathname = usePathname();
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
    if (reset?.waitingChat) {
      const { useSeelie } = await import("@/lib/stores/seelie-store");
      void useSeelie.getState().openChat(reset.waitingChat);
    }
    // Seelie is a client-side screen: swapped in place, as the top switch does it.
    const nav = useScreenNav.getState();
    if (resolveScreen(pathname, nav.override) === "seelie") return;
    window.history.pushState(null, "", withBasePath("/seelie"));
    nav.setOverride(screenFromPath(pathname) === "seelie" ? null : "seelie");
  }

  const waiting = reset?.waiting ?? 0;
  return (
    <div
      role="status"
      className="panel fixed right-4 z-40 w-[min(22rem,calc(100vw-2rem))] p-3.5 bottom-[calc(56px+env(safe-area-inset-bottom)+0.75rem)] sm:bottom-4"
      style={{ boxShadow: "var(--shadow-md)" }}
    >
      <div className="flex items-start gap-3">
        <Camera className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--accent)" }} />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Photoshoots are back</p>
          <p className="muted mt-0.5 text-xs">
            The image limit has reset, so Seelie can make new photos again.
            {waiting ? ` ${waiting === 1 ? "1 look is" : `${waiting} looks are`} waiting for it.` : ""}
          </p>
          <button type="button" className="btn btn-primary mt-2 px-2.5 py-1 text-xs" onClick={() => void open()}>
            Open Seelie
          </button>
        </div>
        <button type="button" className="btn -mr-1 -mt-1 p-1" aria-label="Dismiss" onClick={close}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
