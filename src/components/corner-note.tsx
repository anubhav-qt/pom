"use client";

import { X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect } from "react";

import { withBasePath } from "@/lib/base-path";
import { resolveScreen, screenFromPath, useScreenNav } from "@/lib/stores/screen-nav";

/**
 * Small notes in the corner of any OMS screen (above the phone's nav bar): photoshoots
 * are back, a routine ran, a routine waits on an approval. CornerNotes stacks them;
 * each note is a CornerNote.
 */

export function CornerNotes({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed right-4 z-40 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2 bottom-[calc(56px+env(safe-area-inset-bottom)+0.75rem)] sm:bottom-4">
      {children}
    </div>
  );
}

export function CornerNote({
  icon,
  title,
  children,
  action,
  onClose,
}: {
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  action?: { label: string; onClick: () => void };
  onClose: () => void;
}) {
  return (
    <div role="status" className="panel p-3.5" style={{ boxShadow: "var(--shadow-md)", animation: "rise-in 0.28s var(--ease-apple)" }}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 [&>svg]:h-4 [&>svg]:w-4" style={{ color: "var(--accent)" }}>
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{title}</p>
          {children ? <div className="muted mt-0.5 text-xs">{children}</div> : null}
          {action ? (
            <button type="button" className="btn btn-primary mt-2 px-2.5 py-1 text-xs" onClick={action.onClick}>
              {action.label}
            </button>
          ) : null}
        </div>
        <button type="button" className="btn -mr-1 -mt-1 p-1" aria-label="Dismiss" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/** Go to Seelie (a client-side screen, swapped in place as the top switch does it), opening `chatId` if given. */
export function useOpenSeelie() {
  const pathname = usePathname();
  return useCallback(
    async (chatId: string | null) => {
      if (chatId) {
        const { useSeelie } = await import("@/lib/stores/seelie-store");
        void useSeelie.getState().openChat(chatId);
      }
      const nav = useScreenNav.getState();
      if (resolveScreen(pathname, nav.override) === "seelie") return;
      window.history.pushState(null, "", withBasePath("/seelie"));
      nav.setOverride(screenFromPath(pathname) === "seelie" ? null : "seelie");
    },
    [pathname],
  );
}

/** The screen showing now ("seelie", "orders"…). */
export function useCurrentScreen() {
  const pathname = usePathname();
  const override = useScreenNav((s) => s.override);
  return resolveScreen(pathname, override);
}

/**
 * Call `check` now, every `everyMs`, and when the tab comes back into view; it stops
 * for good when `check` answers null (the feature isn't set up on this server).
 */
export function usePoll(check: () => Promise<unknown>, everyMs: number) {
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const r = await check().catch(() => undefined);
      if (!live || r === null) return;
      timer = setTimeout(() => void tick(), everyMs);
    };
    void tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check, everyMs]);
}
