"use client";

import type { AssistantMessage } from "@paribelle/pi-ai";
import { create } from "zustand";

import {
  autoApproveAction,
  chatAction,
  chatsAction,
  deleteChatsAction,
  limitsAction,
  pinChatAction,
  renameChatAction,
  statusAction,
  type SeelieStatus,
} from "@/app/(app)/seelie/actions";
import { MAX_CLIP_BYTES, uploadClip } from "@/app/(app)/seelie/upload";
import { withBasePath } from "@/lib/base-path";
import type { AccountLimits } from "@/lib/seelie/limits";
import { ACTIVE_RUN, type ChatMessage, type ChatSummary, type ImageInput, type RunInfo, type StreamEvent, type ToolRow } from "@/lib/seelie/types";

/**
 * Seelie's screen state, kept outside React so a reply keeps streaming while the
 * screen is swapped out (the top toggle unmounts it) and is all there on return.
 *
 * One chat is open at a time. Its transcript, tool calls and the reply being
 * written come from `chatAction` and then from the run's event stream; a chat
 * switch drops the stream (the run itself carries on on the server).
 */

export interface DraftImage extends ImageInput {
  /** An object URL for the thumbnail. */
  preview: string;
}

/** A clip or sound going with the message: uploaded as soon as it's picked. */
export interface DraftClip {
  key: string;
  name: string;
  kind: "video" | "audio";
  bytes: number;
  /** 0–1 while it uploads. */
  progress: number;
  /** Set once the server has it. */
  assetId: number | null;
  error: string | null;
  /** An object URL to play it before it's sent. */
  preview: string;
}

interface PendingSend {
  text: string;
  images: DraftImage[];
  clips: DraftClip[];
}

interface SeelieState {
  status: SeelieStatus | null;
  limits: AccountLimits[] | null;
  limitsError: string | null;
  chats: ChatSummary[] | null;

  chatId: string | null;
  title: string;
  autoApprove: boolean;
  pinned: boolean;
  loadingChat: boolean;
  messages: ChatMessage[];
  tools: Record<string, ToolRow>;
  partial: AssistantMessage | null;
  run: RunInfo | null;
  /** The message just sent, shown until the server's copy arrives. */
  pending: PendingSend | null;
  error: string | null;

  model: string | null;
  thinking: string | null;
  draft: string;
  draftImages: DraftImage[];
  draftClips: DraftClip[];
  showThinking: boolean;

  loadStatus: (force?: boolean) => Promise<void>;
  loadLimits: (force?: boolean) => Promise<void>;
  loadChats: () => Promise<void>;
  openChat: (chatId: string | null) => Promise<void>;
  send: () => Promise<void>;
  stop: () => Promise<void>;
  decide: (row: ToolRow, approve: boolean, alwaysThisChat?: boolean) => Promise<void>;
  setAutoApprove: (on: boolean) => Promise<void>;
  rename: (chatId: string, title: string) => Promise<void>;
  pin: (chatId: string, pinned: boolean) => Promise<void>;
  remove: (chatId: string) => Promise<void>;
  setModel: (model: string) => void;
  setThinking: (thinking: string) => void;
  setDraft: (text: string) => void;
  addImages: (images: DraftImage[]) => void;
  removeImage: (index: number) => void;
  addClips: (files: File[]) => void;
  removeClip: (key: string) => void;
  setShowThinking: (on: boolean) => void;
  clearError: () => void;
}

const SHOW_THINKING_KEY = "seelie.showThinking";
const LAST_CHAT_KEY = "seelie.lastChat";
const MAX_IMAGES = 12;
const MAX_CLIPS = 8;
/** Uploads under way, by clip key, so a removed clip stops sending. */
const uploads = new Map<string, AbortController>();

function readFlag(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode; nothing to keep.
  }
}

export function lastChatId() {
  try {
    return localStorage.getItem(LAST_CHAT_KEY);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* The stream                                                                 */
/* -------------------------------------------------------------------------- */

/** Bumped on every chat switch: events from an older stream are dropped. */
let generation = 0;
let streamAbort: AbortController | null = null;
let deltaQueue: Extract<StreamEvent, { t: "delta" }>[] = [];
let deltaFrame: number | null = null;

function lastSeq(messages: ChatMessage[]) {
  return messages.reduce((max, m) => Math.max(max, m.seq), 0);
}

function applyDelta(partial: AssistantMessage | null, e: Extract<StreamEvent, { t: "delta" }>): AssistantMessage | null {
  if (!partial) return partial;
  const content = [...partial.content];
  const block = content[e.i];
  if (!block) {
    content[e.i] = e.k === "text" ? { type: "text", text: e.d } : { type: "thinking", thinking: e.d };
  } else if (block.type === "text" && e.k === "text") {
    content[e.i] = { ...block, text: block.text + e.d };
  } else if (block.type === "thinking" && e.k === "thinking") {
    content[e.i] = { ...block, thinking: block.thinking + e.d };
  }
  return { ...partial, content };
}

export const useSeelie = create<SeelieState>((set, get) => {
  function flushDeltas() {
    deltaFrame = null;
    const queue = deltaQueue;
    deltaQueue = [];
    if (queue.length === 0) return;
    let partial = get().partial;
    for (const e of queue) partial = applyDelta(partial, e);
    set({ partial });
  }

  function apply(event: StreamEvent) {
    if (event.t === "delta") {
      deltaQueue.push(event);
      deltaFrame ??= requestAnimationFrame(flushDeltas);
      return;
    }
    if (deltaQueue.length) flushDeltas();
    const s = get();
    switch (event.t) {
      case "run": {
        const isNew = s.chatId !== event.chatId;
        set({ run: event.run, chatId: event.chatId });
        if (isNew) {
          remember(LAST_CHAT_KEY, event.chatId);
          void get().loadChats();
        }
        return;
      }
      case "msg": {
        const messages = s.messages.some((m) => m.seq === event.m.seq)
          ? s.messages.map((m) => (m.seq === event.m.seq ? event.m : m))
          : [...s.messages, event.m].sort((a, b) => a.seq - b.seq);
        set({ messages, ...(event.m.message.role === "user" ? { pending: null } : {}) });
        return;
      }
      case "partial":
        set({ partial: event.message });
        return;
      case "tool":
        set({ tools: { ...s.tools, [event.row.callId]: event.row } });
        return;
      case "status":
        if (s.run) set({ run: { ...s.run, status: event.status } });
        return;
      case "title":
        set({
          title: event.title,
          chats: s.chats?.map((c) => (c.id === s.chatId ? { ...c, title: event.title } : c)) ?? s.chats,
        });
        return;
      case "end":
        set({
          run: s.run ? { ...s.run, status: event.status, error: event.error, endedAt: new Date().toISOString() } : null,
          partial: null,
          pending: null,
          error: event.status === "error" || event.status === "interrupted" ? (event.error ?? "Seelie stopped with an error.") : null,
        });
        void get().loadChats();
        void get().loadLimits();
        return;
    }
  }

  /** Read a run's event stream until it ends; reconnect if the connection drops mid-run. */
  async function consume(response: Response, gen: number, runId: string, attempt = 0) {
    const reader = response.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    let ended = false;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (gen !== generation) {
          void reader.cancel();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let cut: number;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (!frame.startsWith("data: ")) continue;
          const event = JSON.parse(frame.slice(6)) as StreamEvent;
          if (event.t === "end") ended = true;
          apply(event);
        }
      }
    } catch {
      // Dropped connection or a chat switch; handled below.
    }
    if (ended || gen !== generation) return;
    const run = get().run;
    if (!run || run.id !== runId || !ACTIVE_RUN.includes(run.status) || attempt >= 30) return;
    await new Promise((r) => setTimeout(r, Math.min(1000 * (attempt + 1), 5000)));
    if (gen !== generation) return;
    await follow(runId, gen, attempt + 1);
  }

  async function follow(runId: string, gen: number, attempt = 0) {
    streamAbort?.abort();
    const abort = new AbortController();
    streamAbort = abort;
    try {
      const res = await fetch(withBasePath(`/api/seelie/runs/${runId}/stream?after=${lastSeq(get().messages)}`), {
        signal: abort.signal,
        cache: "no-store",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (gen === generation) set({ error: body?.error ?? `Couldn't follow the reply (${res.status}).` });
        return;
      }
      await consume(res, gen, runId, attempt);
    } catch {
      if (gen === generation && !abort.signal.aborted) await consume(new Response(null), gen, runId, attempt);
    }
  }

  function chooseModel(model: string | null, thinking: string | null) {
    const catalog = get().status?.catalog;
    if (!catalog) return { model, thinking };
    const found = catalog.models.find((m) => m.id === model) ?? catalog.models.find((m) => m.id === catalog.defaultModel) ?? catalog.models[0];
    if (!found) return { model: null, thinking: null };
    const levels = found.thinkingLevels;
    const want = thinking ?? catalog.defaultThinking;
    return { model: found.id, thinking: levels.includes(want as never) ? want : (levels.at(-1) ?? null) };
  }

  return {
    status: null,
    limits: null,
    limitsError: null,
    chats: null,
    chatId: null,
    title: "",
    autoApprove: false,
    pinned: false,
    loadingChat: false,
    messages: [],
    tools: {},
    partial: null,
    run: null,
    pending: null,
    error: null,
    model: null,
    thinking: null,
    draft: "",
    draftImages: [],
    draftClips: [],
    showThinking: typeof window === "undefined" ? true : readFlag(SHOW_THINKING_KEY, true),

    async loadStatus(force = false) {
      const status = await statusAction(force);
      set({ status });
      const { model, thinking } = chooseModel(get().model, get().thinking);
      set({ model, thinking });
    },

    async loadLimits(force = false) {
      if (!get().status?.online) return;
      const res = await limitsAction(force);
      if (res.ok) set({ limits: res.data, limitsError: null });
      else set({ limitsError: res.error });
    },

    async loadChats() {
      const res = await chatsAction();
      if (!res.ok) return;
      // Seelie may have named the open chat after its reply ended.
      const open = res.data.find((c) => c.id === get().chatId);
      set({ chats: res.data, ...(open ? { title: open.title } : {}) });
    },

    async openChat(chatId) {
      const gen = ++generation;
      streamAbort?.abort();
      streamAbort = null;
      deltaQueue = [];
      remember(LAST_CHAT_KEY, chatId);
      set({
        chatId,
        title: "",
        autoApprove: false,
        pinned: false,
        messages: [],
        tools: {},
        partial: null,
        run: null,
        pending: null,
        error: null,
        loadingChat: chatId !== null,
      });
      if (!chatId) {
        set(chooseModel(get().model, get().thinking));
        return;
      }
      const res = await chatAction(chatId);
      if (gen !== generation) return;
      if (!res.ok) {
        remember(LAST_CHAT_KEY, null);
        set({ loadingChat: false, chatId: null, error: res.error });
        return;
      }
      const view = res.data;
      set({
        loadingChat: false,
        title: view.title,
        autoApprove: view.autoApprove,
        pinned: view.pinned,
        messages: view.messages,
        tools: Object.fromEntries(view.tools.map((t) => [t.callId, t])),
        partial: view.partial,
        run: view.activeRun ?? view.runs.at(-1) ?? null,
        ...chooseModel(view.model ?? get().model, view.thinking ?? get().thinking),
      });
      if (view.activeRun) void follow(view.activeRun.id, gen);
    },

    async send() {
      const s = get();
      const text = s.draft.trim();
      const images = s.draftImages;
      const clips = s.draftClips;
      if (!text && images.length === 0 && clips.length === 0) return;
      if (clips.some((c) => c.assetId === null)) return;
      if (s.run && ACTIVE_RUN.includes(s.run.status)) return;
      const gen = generation;
      set({ pending: { text, images, clips }, draft: "", draftImages: [], draftClips: [], error: null });
      streamAbort?.abort();
      const abort = new AbortController();
      streamAbort = abort;
      let res: Response;
      try {
        res = await fetch(withBasePath("/api/seelie/runs"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chatId: s.chatId,
            text,
            images: images.map(({ data, mimeType }) => ({ data, mimeType })),
            assets: clips.map((c) => c.assetId),
            model: s.model ?? undefined,
            thinking: s.thinking ?? undefined,
          }),
          signal: abort.signal,
          cache: "no-store",
        });
      } catch {
        if (gen === generation) set({ pending: null, draft: text, draftImages: images, draftClips: clips, error: "Couldn't reach the server. Check the connection and send again." });
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (gen === generation) set({ pending: null, draft: text, draftImages: images, draftClips: clips, error: body?.error ?? `Couldn't send (${res.status}).` });
        return;
      }
      // The first event names the run; until then there's nothing to reconnect to.
      await consume(res, gen, "", 0);
      const run = get().run;
      if (gen === generation && run && ACTIVE_RUN.includes(run.status)) void follow(run.id, gen, 1);
    },

    async stop() {
      const run = get().run;
      if (!run) return;
      await fetch(withBasePath(`/api/seelie/runs/${run.id}/abort`), { method: "POST" }).catch(() => {});
    },

    async decide(row, approve, alwaysThisChat = false) {
      const s = get();
      set({
        tools: {
          ...s.tools,
          [row.callId]: { ...row, status: approve ? "queued" : "denied", approval: approve ? "approved" : "denied" },
        },
        ...(alwaysThisChat ? { autoApprove: true } : {}),
      });
      const res = await fetch(withBasePath("/api/seelie/tool-calls"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: row.runId, callId: row.callId, approve, alwaysThisChat }),
      }).catch(() => null);
      if (!res?.ok) {
        const body = (await res?.json().catch(() => null)) as { error?: string } | null;
        set({ tools: { ...get().tools, [row.callId]: row }, error: body?.error ?? "The decision didn't reach the server. Try again." });
      }
    },

    async setAutoApprove(on) {
      const chatId = get().chatId;
      set({ autoApprove: on });
      if (!chatId) return;
      const res = await autoApproveAction(chatId, on);
      if (!res.ok) set({ autoApprove: !on, error: res.error });
    },

    async rename(chatId, title) {
      const res = await renameChatAction(chatId, title);
      if (!res.ok) return set({ error: res.error });
      if (get().chatId === chatId) set({ title: title.trim() });
      await get().loadChats();
    },

    async pin(chatId, pinned) {
      const res = await pinChatAction(chatId, pinned);
      if (!res.ok) return set({ error: res.error });
      if (get().chatId === chatId) set({ pinned });
      await get().loadChats();
    },

    async remove(chatId) {
      const res = await deleteChatsAction([chatId]);
      if (!res.ok) return set({ error: res.error });
      if (get().chatId === chatId) await get().openChat(null);
      await get().loadChats();
    },

    setModel(model) {
      set(chooseModel(model, get().thinking));
    },
    setThinking(thinking) {
      set({ thinking });
    },
    setDraft(draft) {
      set({ draft });
    },
    addImages(images) {
      set({ draftImages: [...get().draftImages, ...images].slice(0, MAX_IMAGES) });
    },
    removeImage(index) {
      const images = [...get().draftImages];
      const [gone] = images.splice(index, 1);
      if (gone) URL.revokeObjectURL(gone.preview);
      set({ draftImages: images });
    },
    addClips(files) {
      const room = MAX_CLIPS - get().draftClips.length;
      const picked = files.filter((f) => /^(video|audio)\//.test(f.type)).slice(0, Math.max(0, room));
      const patch = (key: string, change: Partial<DraftClip>) =>
        set({ draftClips: get().draftClips.map((c) => (c.key === key ? { ...c, ...change } : c)) });
      for (const file of picked) {
        const clip: DraftClip = {
          key: crypto.randomUUID(),
          name: file.name,
          kind: file.type.startsWith("audio/") ? "audio" : "video",
          bytes: file.size,
          progress: 0,
          assetId: null,
          error: file.size > MAX_CLIP_BYTES ? `${Math.round(file.size / 1048576)} MB; the limit is 300 MB` : null,
          preview: URL.createObjectURL(file),
        };
        set({ draftClips: [...get().draftClips, clip] });
        if (clip.error) continue;
        const abort = new AbortController();
        uploads.set(clip.key, abort);
        let shown = 0;
        uploadClip(file, {
          signal: abort.signal,
          onProgress: (share) => {
            // A repaint per percent is plenty.
            if (share - shown < 0.01 && share < 1) return;
            shown = share;
            patch(clip.key, { progress: share });
          },
        })
          .then((asset) => patch(clip.key, { assetId: asset.id, progress: 1 }))
          .catch((err: unknown) => {
            if (abort.signal.aborted) return;
            patch(clip.key, { error: err instanceof Error ? err.message : "The upload failed" });
          })
          .finally(() => uploads.delete(clip.key));
      }
    },
    removeClip(key) {
      uploads.get(key)?.abort();
      const gone = get().draftClips.find((c) => c.key === key);
      if (gone) URL.revokeObjectURL(gone.preview);
      set({ draftClips: get().draftClips.filter((c) => c.key !== key) });
    },
    setShowThinking(on) {
      remember(SHOW_THINKING_KEY, on ? "1" : "0");
      set({ showThinking: on });
    },
    clearError() {
      set({ error: null });
    },
  };
});

export const MAX_DRAFT_IMAGES = MAX_IMAGES;
export const MAX_DRAFT_CLIPS = MAX_CLIPS;
