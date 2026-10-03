"use client";

import { CalendarClock, Clapperboard, IndianRupee, MoreHorizontal, Package, Pin, Plus, Settings2, Sparkles, SquarePen, TrendingUp, Undo2, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { DropdownMenu, type DropdownOption } from "@/components/dropdown-menu";
import { Modal } from "@/components/modal";
import { RailCrumb } from "@/components/rail-crumb";
import { Toggle } from "@/components/toggle";
import { CenteredSpinner, Empty } from "@/components/ui";
import { lastChatId, useSeelie } from "@/lib/stores/seelie-store";

import { Composer } from "./composer";
import { RoutinesModal } from "./routines";
import { SettingsModal } from "./settings";
import { Notice, Timeline } from "./timeline";

/**
 * Seelie's screen: the chats in the rail under the header, the open chat, and the
 * box to write in. Its state lives in `useSeelie`, so a reply keeps coming in while
 * another screen is up.
 */

const NEW = "__new";

/** Where the visible part of the page ends, in page coordinates: above the keyboard while it's up. */
function visibleBottom() {
  const vv = window.visualViewport;
  return vv ? vv.pageTop + vv.height : window.scrollY + window.innerHeight;
}

/**
 * Brings the page's end to the visible bottom. Scrolling to scrollHeight won't do on an iPhone:
 * with the keyboard up Safari scrolls the page past its end, leaving the box mid-screen over
 * blank space, so this moves by the difference instead (up as well as down).
 */
function toEnd(behavior: ScrollBehavior = "auto") {
  const gap = document.documentElement.scrollHeight - visibleBottom();
  if (Math.abs(gap) >= 1) window.scrollBy({ top: gap, behavior });
}

export function Seelie() {
  const status = useSeelie((s) => s.status);
  const chats = useSeelie((s) => s.chats);
  const chatId = useSeelie((s) => s.chatId);
  const title = useSeelie((s) => s.title);
  const pinned = useSeelie((s) => s.pinned);
  const autoApprove = useSeelie((s) => s.autoApprove);
  const loadingChat = useSeelie((s) => s.loadingChat);
  const messages = useSeelie((s) => s.messages);
  const tools = useSeelie((s) => s.tools);
  const partial = useSeelie((s) => s.partial);
  const pending = useSeelie((s) => s.pending);
  const error = useSeelie((s) => s.error);

  const [settings, setSettings] = useState(false);
  const [routines, setRoutines] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const s = useSeelie.getState();
    void s.loadChats();
    if (!s.status) void s.loadStatus().then(() => useSeelie.getState().loadLimits());
    // Back from another screen after a blip: catch up on what happened meanwhile.
    else if (s.status.online && s.chatId && !s.pending) void s.resume();
    if (s.chatId === null && !s.messages.length && !s.pending) {
      const last = lastChatId();
      if (last) void s.openChat(last);
    }
  }, []);

  // On Android the keyboard shrinks the page instead of covering it, so the box sits right on
  // it and the header stays put. Only here: other screens keep the bottom nav under the keyboard.
  useEffect(() => {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta || meta.content.includes("interactive-widget")) return;
    const before = meta.content;
    meta.content = `${before}, interactive-widget=resizes-content`;
    return () => {
      meta.content = before;
    };
  }, []);

  // Follow the reply down as it comes in, unless the reader has scrolled up to read;
  // then a button by the box takes them back down.
  const stick = useRef(true);
  const [behind, setBehind] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      stick.current = visibleBottom() >= document.documentElement.scrollHeight - 160;
      setBehind(!stick.current);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (!pending) return;
    stick.current = true;
    setBehind(false);
  }, [pending]);
  useEffect(() => {
    stick.current = true;
    setBehind(false);
  }, [chatId]);
  useEffect(() => {
    if (stick.current) toEnd();
  }, [messages, tools, partial, pending, loadingChat, error]);

  // When a phone's keyboard comes up or goes down, and once Safari has scrolled the box into
  // view (a pause in the viewport's scrolling), iOS can leave the page scrolled past its end:
  // the box floats mid-screen over blank space. Settle it.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let frame = 0;
    let pause = 0;
    const settle = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (stick.current || visibleBottom() > document.documentElement.scrollHeight + 1) toEnd();
      });
    };
    const settled = () => {
      clearTimeout(pause);
      pause = window.setTimeout(() => {
        if (visibleBottom() > document.documentElement.scrollHeight + 1) toEnd();
      }, 150);
    };
    vv.addEventListener("resize", settle);
    vv.addEventListener("scroll", settled);
    return () => {
      vv.removeEventListener("resize", settle);
      vv.removeEventListener("scroll", settled);
      cancelAnimationFrame(frame);
      clearTimeout(pause);
    };
  }, []);

  const empty = !chatId && !messages.length && !pending && !partial;
  const online = status?.online ?? true;

  // Seelie runs on the ThinkPad; for a moment now and then (catching up, restarting) the
  // page is answered from the cloud, where it's offline. Look again until it's back, then
  // pick the chat up where it was.
  useEffect(() => {
    if (online) return;
    const timer = setInterval(async () => {
      await useSeelie.getState().loadStatus();
      const s = useSeelie.getState();
      if (s.status?.online) {
        void s.loadLimits();
        void s.resume();
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [online]);
  const models = status?.catalog?.models.length ?? 0;
  const disabled = !status
    ? "Starting…"
    : status.error
      ? "Seelie can't reach its models right now."
      : !models
        ? "No model accounts are connected. Connect one in settings."
        : null;

  const options: DropdownOption[] = [
    { id: NEW, label: "New chat", icon: <Plus className="h-3.5 w-3.5 shrink-0" /> },
    ...(chats ?? []).map((c, i, all) => ({
      id: c.id,
      label: c.title || "Untitled chat",
      dividerBefore: i === 0 || (all[i - 1].pinned && !c.pinned),
      icon: c.active ? (
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" style={{ background: "var(--accent)" }} title="Replying" />
      ) : c.pinned ? (
        <Pin className="h-3 w-3 shrink-0" style={{ color: "var(--muted-2)" }} />
      ) : c.routine ? (
        <CalendarClock className="h-3 w-3 shrink-0" style={{ color: "var(--muted-2)" }} />
      ) : undefined,
    })),
  ];

  // Phones keep Routines in here (the rail has room for its icon from `sm` up).
  const chatMenu: DropdownOption[] = [
    { id: "routines", label: "Routines" },
    ...(chatId
      ? [
          { id: "rename", label: "Rename", dividerBefore: true },
          { id: "pin", label: pinned ? "Unpin" : "Pin to the top" },
          { id: "delete", label: "Delete", dividerBefore: true },
        ]
      : []),
  ];

  function onChatMenu(id: string) {
    const s = useSeelie.getState();
    if (id === "routines") return setRoutines(true);
    if (!chatId) return;
    if (id === "rename") setRenaming(true);
    else if (id === "pin") void s.pin(chatId, !pinned);
    else if (id === "delete") setDeleting(true);
  }

  return (
    <>
      <RailCrumb
        search={false}
        primary={{
          activeId: chatId ?? NEW,
          activeLabel: chatId ? title || "Untitled chat" : "New chat",
          options,
          onSelect: (id) => void useSeelie.getState().openChat(id === NEW ? null : id),
        }}
        actions={
          <>
            {/* Also before a chat's first message: the new chat starts with it. */}
            <div className="flex shrink-0" title="OMS edits run without asking in this chat. Amazon, paribelle.in, posts and ads always ask.">
              <Toggle
                className="items-center gap-2 sm:gap-3 [&>button]:mt-0"
                checked={autoApprove}
                onChange={(v) => void useSeelie.getState().setAutoApprove(v)}
                label={
                  <>
                    <span className="whitespace-nowrap text-[13px] sm:hidden">Auto-approve</span>
                    <span className="hidden sm:inline">Auto-approve OMS edits</span>
                  </>
                }
              />
            </div>
            {/* Phones: a new chat one tap away (from `sm` up the chat list is close enough). */}
            {!empty ? (
              <button
                type="button"
                className="nav-icon-btn h-8 w-8 sm:hidden"
                aria-label="New chat"
                onClick={() => void useSeelie.getState().openChat(null)}
              >
                <SquarePen className="h-[17px] w-[17px]" />
              </button>
            ) : null}
            <DropdownMenu
              align="right"
              className={chatId ? "relative shrink-0" : "relative shrink-0 sm:hidden"}
              trigger={
                <span className="nav-icon-btn h-8 w-8" aria-label="Chat options">
                  <MoreHorizontal className="h-[18px] w-[18px]" />
                </span>
              }
              options={chatMenu}
              activeId=""
              onSelect={onChatMenu}
            />
            <button type="button" className="nav-icon-btn hidden h-8 w-8 sm:flex" aria-label="Routines" title="Routines" onClick={() => setRoutines(true)}>
              <CalendarClock className="h-[18px] w-[18px]" />
            </button>
            <button type="button" className="nav-icon-btn h-8 w-8" aria-label="Seelie settings" onClick={() => setSettings(true)}>
              <Settings2 className="h-[18px] w-[18px]" />
            </button>
          </>
        }
      />

      {/* Tall enough that the box starts at the foot of the screen (on phones the spacer under it included). */}
      <div className="mx-auto flex min-h-[calc(100dvh-184px+env(safe-area-inset-bottom))] w-full max-w-3xl flex-col sm:min-h-[calc(100dvh-11rem)]">
        {/* A new chat's welcome sits in the middle of the space above the box. */}
        <div className={!loadingChat && online && empty ? "flex flex-1 flex-col justify-center py-4" : "flex-1 pt-4"}>
          {loadingChat ? (
            <CenteredSpinner />
          ) : !online && !messages.length && !pending ? (
            <Empty title="Seelie is away for a moment" hint="Seelie runs on the ThinkPad, which isn't answering right now. This page reconnects by itself." />
          ) : empty ? (
            <Welcome name={status?.me.name ?? ""} owner={status?.me.owner ?? false} canSend={!disabled} />
          ) : (
            <Timeline />
          )}
          {error ? (
            <div className="pb-3">
              <Notice tone="danger" onClose={() => useSeelie.getState().clearError()}>
                {error}
              </Notice>
            </div>
          ) : null}
        </div>

        {!online ? (
          !messages.length && !pending ? null : (
            <p className="muted sticky bottom-[calc(56px+env(safe-area-inset-bottom))] py-4 text-center text-xs sm:bottom-0" style={{ background: "var(--bg)" }}>
              Seelie is away for a moment (it runs on the ThinkPad). Reconnecting…
            </p>
          )
        ) : (
          <>
            {status?.error ? (
              <Notice tone="warn">
                {status.error}{" "}
                <button type="button" className="font-medium underline" onClick={() => void useSeelie.getState().loadStatus(true)}>
                  Try again
                </button>
              </Notice>
            ) : null}
            <Composer
              disabled={disabled}
              onOpenSettings={() => setSettings(true)}
              onJump={
                behind && !empty
                  ? () => {
                      stick.current = true;
                      toEnd("smooth");
                    }
                  : undefined
              }
            />
          </>
        )}
        {/* Phones: room below the docked box for the nav bar under it (the page's own bottom
            padding is less), so the box never has to ride up over the latest message. */}
        <div aria-hidden className="dock-spacer h-[calc(56px+env(safe-area-inset-bottom)-2rem)] shrink-0 sm:hidden" />
      </div>

      {settings ? <SettingsModal onClose={() => setSettings(false)} /> : null}
      {routines ? <RoutinesModal onClose={() => setRoutines(false)} /> : null}
      {renaming && chatId ? <RenameModal chatId={chatId} title={title} onClose={() => setRenaming(false)} /> : null}
      {deleting && chatId ? <DeleteModal chatId={chatId} title={title} onClose={() => setDeleting(false)} /> : null}
    </>
  );
}

/** A new chat: a greeting and four things to ask in one tap, all on one screen. */
function Welcome({ name, owner, canSend }: { name: string; owner: boolean; canSend: boolean }) {
  const first = name.split(/\s+/)[0];
  const ideas: { label: string; ask: string; icon: LucideIcon; send?: false }[] = [
    { label: "Orders to pack", ask: "How many orders are waiting to be packed?", icon: Package },
    { label: "Returns to check in", ask: "Which returns still need checking in?", icon: Undo2 },
    { label: "Best sellers", ask: "What sold best in the last 30 days?", icon: TrendingUp },
    // A reel needs its photos first: it waits in the box.
    owner
      ? { label: "Make a reel", ask: "Make a reel from these photos", icon: Clapperboard, send: false }
      : { label: "Amazon payouts", ask: "How much has Amazon paid us this month?", icon: IndianRupee },
  ];
  return (
    <div className="flex flex-col items-center px-1 text-center sm:px-2">
      <div
        className="mb-3 flex h-10 w-10 items-center justify-center rounded-full"
        style={{ background: "radial-gradient(circle at 35% 30%, var(--accent-soft), transparent 70%)", border: "1px solid var(--border)" }}
      >
        <Sparkles className="h-[18px] w-[18px]" style={{ color: "var(--accent)" }} />
      </div>
      <h1 className="text-xl font-semibold tracking-tight">{first ? `Hi ${first}, what can I do?` : "What can I do?"}</h1>
      <div className="mt-5 grid w-full max-w-md grid-cols-2 gap-2">
        {ideas.map(({ label, ask, icon: Icon, send }) => (
          <button
            key={label}
            type="button"
            disabled={!canSend}
            onClick={() => {
              const s = useSeelie.getState();
              s.setDraft(ask);
              if (send !== false) void s.send();
            }}
            className="flex items-center gap-2.5 rounded-xl border px-3 py-3 text-left text-sm font-medium transition-colors hover:bg-[var(--accent-soft)] disabled:opacity-50"
            style={{ borderColor: "var(--border)", background: "var(--panel)" }}
          >
            <Icon className="h-4 w-4 shrink-0" style={{ color: "var(--accent)" }} />
            <span className="min-w-0 leading-snug">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function RenameModal({ chatId, title, onClose }: { chatId: string; title: string; onClose: () => void }) {
  const [value, setValue] = useState(title);
  return (
    <Modal title="Rename chat" onClose={onClose} width="28rem">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          void useSeelie.getState().rename(chatId, value);
          onClose();
        }}
      >
        <input className="input text-base sm:text-sm" value={value} onChange={(e) => setValue(e.target.value)} maxLength={120} autoFocus />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!value.trim()}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteModal({ chatId, title, onClose }: { chatId: string; title: string; onClose: () => void }) {
  return (
    <Modal title="Delete chat" onClose={onClose} width="28rem">
      <p className="text-sm">
        Delete <span className="font-medium">{title || "this chat"}</span> and everything in it? This can&apos;t be undone.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          style={{ color: "var(--danger)", fontWeight: 600 }}
          onClick={() => {
            void useSeelie.getState().remove(chatId);
            onClose();
          }}
        >
          Delete
        </button>
      </div>
    </Modal>
  );
}
