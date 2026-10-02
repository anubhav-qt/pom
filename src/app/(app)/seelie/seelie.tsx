"use client";

import { MoreHorizontal, Pin, Plus, Settings2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { DropdownMenu, type DropdownOption } from "@/components/dropdown-menu";
import { Modal } from "@/components/modal";
import { RailCrumb } from "@/components/rail-crumb";
import { Toggle } from "@/components/toggle";
import { CenteredSpinner, Empty } from "@/components/ui";
import { lastChatId, useSeelie } from "@/lib/stores/seelie-store";

import { Composer } from "./composer";
import { SettingsModal } from "./settings";
import { Notice, Timeline } from "./timeline";

/**
 * Seelie's screen: the chats in the rail under the header, the open chat, and the
 * box to write in. Its state lives in `useSeelie`, so a reply keeps coming in while
 * another screen is up.
 */

const NEW = "__new";

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
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const s = useSeelie.getState();
    void s.loadChats();
    if (!s.status) void s.loadStatus().then(() => useSeelie.getState().loadLimits());
    if (s.chatId === null && !s.messages.length && !s.pending) {
      const last = lastChatId();
      if (last) void s.openChat(last);
    }
  }, []);

  // Follow the reply down as it comes in, unless the reader has scrolled up to read.
  const stick = useRef(true);
  useEffect(() => {
    const onScroll = () => {
      stick.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (pending) stick.current = true;
  }, [pending]);
  useEffect(() => {
    stick.current = true;
  }, [chatId]);
  useEffect(() => {
    if (stick.current) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [messages, tools, partial, pending, loadingChat, error]);

  const empty = !chatId && !messages.length && !pending && !partial;
  const online = status?.online ?? true;
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
      ) : undefined,
    })),
  ];

  const chatMenu: DropdownOption[] = chatId
    ? [
        { id: "rename", label: "Rename" },
        { id: "pin", label: pinned ? "Unpin" : "Pin to the top" },
        { id: "auto", label: autoApprove ? "Ask before OMS edits" : "Auto-approve OMS edits" },
        { id: "delete", label: "Delete", dividerBefore: true },
      ]
    : [];

  function onChatMenu(id: string) {
    const s = useSeelie.getState();
    if (!chatId) return;
    if (id === "rename") setRenaming(true);
    else if (id === "pin") void s.pin(chatId, !pinned);
    else if (id === "auto") void s.setAutoApprove(!autoApprove);
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
            {chatId ? (
              <Toggle
                className="hidden items-center sm:flex [&>button]:mt-0"
                checked={autoApprove}
                onChange={(v) => void useSeelie.getState().setAutoApprove(v)}
                label="Auto-approve OMS edits"
              />
            ) : null}
            {chatId ? (
              <DropdownMenu
                align="right"
                trigger={
                  <span className="nav-icon-btn h-8 w-8" aria-label="Chat options">
                    <MoreHorizontal className="h-[18px] w-[18px]" />
                  </span>
                }
                options={chatMenu}
                activeId=""
                onSelect={onChatMenu}
              />
            ) : null}
            <button type="button" className="nav-icon-btn h-8 w-8" aria-label="Seelie settings" onClick={() => setSettings(true)}>
              <Settings2 className="h-[18px] w-[18px]" />
            </button>
          </>
        }
      />

      <div className="mx-auto flex min-h-[calc(100dvh-13rem)] w-full max-w-3xl flex-col sm:min-h-[calc(100dvh-11rem)]">
        <div className="flex-1 pt-4">
          {loadingChat ? (
            <CenteredSpinner />
          ) : empty ? (
            online ? (
              <Welcome name={status?.me.name ?? ""} owner={status?.me.owner ?? false} canSend={!disabled} />
            ) : (
              <Empty title="Seelie is offline here" hint="Seelie runs on the ThinkPad. Open the OMS there to talk to it; your chats can still be read here." />
            )
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
          empty ? null : (
            <p className="muted sticky bottom-[calc(56px+env(safe-area-inset-bottom))] py-4 text-center text-xs sm:bottom-0">
              Seelie is offline here (it runs on the ThinkPad). Chats can still be read.
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
            <Composer disabled={disabled} onOpenSettings={() => setSettings(true)} />
          </>
        )}
      </div>

      {settings ? <SettingsModal onClose={() => setSettings(false)} /> : null}
      {renaming && chatId ? <RenameModal chatId={chatId} title={title} onClose={() => setRenaming(false)} /> : null}
      {deleting && chatId ? <DeleteModal chatId={chatId} title={title} onClose={() => setDeleting(false)} /> : null}
    </>
  );
}

function Welcome({ name, owner, canSend }: { name: string; owner: boolean; canSend: boolean }) {
  const first = name.split(/\s+/)[0];
  const ideas = [
    "How many orders are waiting to be packed?",
    "What sold best in the last 30 days?",
    "Which returns still need checking in?",
    "How much has Amazon paid us this month?",
    ...(owner ? ["Which Amazon items aren't on paribelle.in yet?", "Make a reel from these photos"] : []),
  ];
  return (
    <div className="flex flex-col items-center px-2 pb-6 pt-10 text-center sm:pt-16">
      <div
        className="mb-4 flex h-12 w-12 items-center justify-center rounded-full"
        style={{ background: "radial-gradient(circle at 35% 30%, var(--accent-soft), transparent 70%)", border: "1px solid var(--border)" }}
      >
        <Sparkles className="h-5 w-5" style={{ color: "var(--accent)" }} />
      </div>
      <h1 className="text-xl font-semibold tracking-tight">{first ? `Hi ${first}, what can I do?` : "What can I do?"}</h1>
      <p className="muted mt-1.5 max-w-md text-sm">
        Ask about orders, returns, money and stock, or tell Seelie what to change. It asks before it edits anything.
      </p>
      <div className="mt-6 grid w-full max-w-xl gap-2 sm:grid-cols-2">
        {ideas.map((idea) => (
          <button
            key={idea}
            type="button"
            disabled={!canSend}
            onClick={() => {
              const s = useSeelie.getState();
              s.setDraft(idea);
              // A reel needs its photos first: leave it in the box.
              if (!idea.startsWith("Make a reel")) void s.send();
            }}
            className="rounded-xl border px-3 py-2.5 text-left text-sm transition-colors hover:bg-[var(--accent-soft)] disabled:opacity-50"
            style={{ borderColor: "var(--border)", background: "var(--panel)" }}
          >
            {idea}
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
