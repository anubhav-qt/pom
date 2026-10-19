"use client";

import type { AssistantMessage } from "@paribelle/pi-ai";
import { create } from "zustand";

import {
  chatAction,
  chatsAction,
  deleteChatsAction,
  limitsAction,
  pinChatAction,
  reactAction,
  renameChatAction,
  statusAction,
  type SeelieStatus,
} from "@/app/(app)/seelie/actions";
import { MAX_CLIP_BYTES, uploadClip } from "@/app/(app)/seelie/upload";
import { withBasePath } from "@/lib/base-path";
import type { AccountLimits } from "@/lib/seelie/limits";
import {
  ACTIVE_RUN,
  type ApprovalEdits,
  type ChatMessage,
  type ChatSummary,
  type ChatView,
  type ImageInput,
  type Mention,
  type Reaction,
  type ReactionInput,
  type RunInfo,
  type RunStatus,
  type StreamEvent,
  type ToolRow,
} from "@/lib/seelie/types";

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

/** A clip, sound or PDF going with the message: uploaded as soon as it's picked. */
export interface DraftClip {
  key: string;
  name: string;
  kind: "video" | "audio" | "pdf";
  bytes: number;
  /** 0–1 while it uploads. */
  progress: number;
  /** Set once the server has it. */
  assetId: number | null;
  error: string | null;
  /** An object URL to play it before it's sent. */
  preview: string;
}

export interface PendingSend {
  text: string;
  images: DraftImage[];
  clips: DraftClip[];
}

/** A reply that ended, for the note shown when the owner is on another screen. */
export interface Finished {
  runId: string;
  chatId: string;
  title: string;
  status: RunStatus;
  at: number;
}

interface SeelieState {
  status: SeelieStatus | null;
  limits: AccountLimits[] | null;
  limitsError: string | null;
  chats: ChatSummary[] | null;

  chatId: string | null;
  title: string;
  pinned: boolean;
  loadingChat: boolean;
  messages: ChatMessage[];
  tools: Record<string, ToolRow>;
  partial: AssistantMessage | null;
  run: RunInfo | null;
  /** The message just sent, shown until the server's copy arrives. */
  pending: PendingSend | null;
  /** A message on its way into the reply being written (read before Seelie's next step). */
  steering: PendingSend | null;
  /** Messages sent while Seelie worked that wait for its reply to end (another process holds it, or clips go with them). */
  queued: PendingSend[];
  error: string | null;
  /** The latest reply to end, for the note on other screens. */
  finished: Finished | null;

  model: string | null;
  thinking: string | null;
  draft: string;
  draftImages: DraftImage[];
  draftClips: DraftClip[];
  /** Products and orders picked with @ for the message being written. */
  draftMentions: Mention[];
  showThinking: boolean;

  loadStatus: (force?: boolean) => Promise<void>;
  loadLimits: (force?: boolean) => Promise<void>;
  loadChats: () => Promise<void>;
  openChat: (chatId: string | null) => Promise<void>;
  /** Back online after a blip: bring the open (or last) chat up to date without clearing it. */
  resume: () => Promise<void>;
  /** Send the message in the box: a new reply, or into the one being written. */
  send: () => Promise<void>;
  /** Send `text` as the owner's message (Undo, a next step, feedback): into the reply being written, or as a new one. */
  say: (text: string) => Promise<void>;
  unqueue: (index: number) => void;
  stop: () => Promise<void>;
  decide: (row: ToolRow, approve: boolean, edits?: ApprovalEdits | null) => Promise<void>;
  react: (input: ReactionInput) => Promise<boolean>;
  addMention: (mention: Mention) => void;
  clearFinished: () => void;
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
        set({ messages, ...(event.m.message.role === "user" ? { pending: null, steering: null } : {}) });
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
      case "end": {
        // A message on its way in when the reply ended goes as the next one.
        const late = s.steering ? [s.steering] : [];
        set({
          run: s.run ? { ...s.run, status: event.status, error: event.error, endedAt: new Date().toISOString() } : null,
          partial: null,
          pending: null,
          steering: null,
          queued: [...late, ...s.queued],
          error: event.status === "error" || event.status === "interrupted" ? (event.error ?? "Seelie stopped with an error.") : null,
          finished: s.run && s.chatId ? { runId: s.run.id, chatId: s.chatId, title: s.title, status: event.status, at: Date.now() } : s.finished,
        });
        void get().loadChats();
        void get().loadLimits();
        // What was sent meanwhile goes now, as one message, unless the owner stopped the reply.
        if (event.status !== "aborted" && get().queued.length) queueMicrotask(() => void flushQueue());
        return;
      }
    }
  }

  /** Messages kept while Seelie worked, sent together as the next message. */
  async function flushQueue() {
    const s = get();
    if (!s.queued.length || (s.run && ACTIVE_RUN.includes(s.run.status))) return;
    const all = s.queued;
    set({ queued: [] });
    await post({
      text: all.map((q) => q.text).filter(Boolean).join("\n\n"),
      images: all.flatMap((q) => q.images).slice(0, MAX_IMAGES),
      clips: all.flatMap((q) => q.clips).slice(0, MAX_CLIPS),
    });
  }

  /** Tell the reply being written something; kept for the next message when this process can't. */
  async function steer(msg: PendingSend) {
    const run = get().run;
    if (!run || !ACTIVE_RUN.includes(run.status) || msg.clips.length) {
      set({ queued: [...get().queued, msg] });
      return;
    }
    if (get().steering) {
      set({ queued: [...get().queued, msg] });
      return;
    }
    set({ steering: msg, error: null });
    const res = await fetch(withBasePath(`/api/seelie/runs/${run.id}/steer`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: msg.text, images: msg.images.map(({ data, mimeType }) => ({ data, mimeType })) }),
      cache: "no-store",
    }).catch(() => null);
    if (res?.ok) return;
    // Held by another process, or ending: it goes as the next message instead.
    if (get().steering === msg) set({ steering: null, queued: [...get().queued, msg] });
    if (res && res.status !== 409) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      set({ error: body?.error ?? `Couldn't pass that on (${res.status}); it goes when Seelie finishes.` });
    }
    const after = get().run;
    if (!after || !ACTIVE_RUN.includes(after.status)) void flushQueue();
  }

  /** Start a reply to `msg` in the open chat (a new chat when none is open). */
  async function post(msg: PendingSend) {
    const s = get();
    const gen = generation;
    const { text, images, clips } = msg;
    set({ pending: msg, error: null });
    streamAbort?.abort();
    const abort = new AbortController();
    streamAbort = abort;
    let res: Response;
    const back = (error: string) => {
      if (gen !== generation) return;
      const now = get();
      // The words go back in the box (after anything typed since), so nothing is lost.
      set({
        pending: null,
        draft: [text, now.draft].filter(Boolean).join("\n\n"),
        draftImages: [...images, ...now.draftImages].slice(0, MAX_IMAGES),
        draftClips: [...clips, ...now.draftClips].slice(0, MAX_CLIPS),
        error,
      });
    };
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
      back("Couldn't reach the server. Check the connection and send again.");
      return;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string; offline?: boolean } | null;
      if (body?.offline) markOffline();
      back(body?.error ?? `Couldn't send (${res.status}).`);
      return;
    }
    // The first event names the run; until then there's nothing to reconnect to.
    await consume(res, gen, "", 0);
    const run = get().run;
    if (gen === generation && run && ACTIVE_RUN.includes(run.status)) void follow(run.id, gen, 1);
  }

  /** Seelie answered from somewhere it doesn't run (the ThinkPad was busy for a moment): the screen waits for it. */
  function markOffline() {
    const status = get().status;
    if (status?.online) set({ status: { ...status, online: false } });
  }

  /** Follow a run again after a dropped connection, while it's still going. False when it isn't worth it. */
  async function retry(gen: number, runId: string, attempt: number) {
    const run = get().run;
    if (gen !== generation || !run || run.id !== runId || !ACTIVE_RUN.includes(run.status) || attempt >= 30) return false;
    await new Promise((r) => setTimeout(r, Math.min(1000 * (attempt + 1), 5000)));
    if (gen === generation) await follow(runId, gen, attempt + 1);
    return true;
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
    await retry(gen, runId, attempt);
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
        const body = (await res.json().catch(() => null)) as { error?: string; offline?: boolean } | null;
        if (gen !== generation) return;
        if (body?.offline) markOffline();
        // Offline, restarting, or a gateway between: the run carries on there, so keep trying.
        if ((body?.offline || res.status >= 502) && (await retry(gen, runId, attempt))) return;
        set({ error: body?.error ?? `Couldn't follow the reply (${res.status}).` });
        return;
      }
      await consume(res, gen, runId, attempt);
    } catch {
      if (!abort.signal.aborted) await retry(gen, runId, attempt);
    }
  }

  /** Show a chat as the server has it, and follow its reply if one is being written. */
  function showView(view: ChatView, gen: number) {
    set({
      loadingChat: false,
      title: view.title,
      pinned: view.pinned,
      messages: view.messages,
      tools: Object.fromEntries(view.tools.map((t) => [t.callId, t])),
      partial: view.partial,
      run: view.activeRun ?? view.runs.at(-1) ?? null,
      ...chooseModel(view.model ?? get().model, view.thinking ?? get().thinking),
    });
    if (view.activeRun) void follow(view.activeRun.id, gen);
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
    pinned: false,
    loadingChat: false,
    messages: [],
    tools: {},
    partial: null,
    run: null,
    pending: null,
    steering: null,
    queued: [],
    error: null,
    finished: null,
    model: null,
    thinking: null,
    draft: "",
    draftImages: [],
    draftClips: [],
    draftMentions: [],
    showThinking: typeof window === "undefined" ? true : readFlag(SHOW_THINKING_KEY, true),

    async loadStatus(force = false) {
      const status = await statusAction(force).catch(() => null);
      if (!status) return;
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
      // Messages kept for the chat being left go back in the box rather than into another chat.
      const kept = get().queued;
      set({
        chatId,
        title: "",
        pinned: false,
        messages: [],
        tools: {},
        partial: null,
        run: null,
        pending: null,
        steering: null,
        queued: [],
        error: null,
        loadingChat: chatId !== null,
        ...(kept.length
          ? {
              draft: [get().draft, ...kept.map((q) => q.text)].filter(Boolean).join("\n\n"),
              draftImages: [...get().draftImages, ...kept.flatMap((q) => q.images)].slice(0, MAX_IMAGES),
              draftClips: [...get().draftClips, ...kept.flatMap((q) => q.clips)].slice(0, MAX_CLIPS),
            }
          : {}),
      });
      if (!chatId) {
        set(chooseModel(get().model, get().thinking));
        return;
      }
      const res = await chatAction(chatId).catch(() => null);
      if (gen !== generation) return;
      // Unreachable or offline for now: keep the chat, and open it again once Seelie is back.
      if (!res || (!res.ok && res.offline)) {
        if (res) markOffline();
        set({ loadingChat: false, ...(res ? {} : { error: "Couldn't reach the server. It will try again when Seelie is back." }) });
        return;
      }
      if (!res.ok) {
        remember(LAST_CHAT_KEY, null);
        set({ loadingChat: false, chatId: null, error: res.error });
        return;
      }
      showView(res.data, gen);
    },

    async resume() {
      void get().loadChats();
      const s = get();
      const chatId = s.chatId ?? lastChatId();
      if (!chatId) return;
      if (s.chatId !== chatId || !s.messages.length) return get().openChat(chatId);
      // A reply being sent shows as pending; leave it to its own stream.
      if (s.pending || s.steering) return;
      const gen = ++generation;
      streamAbort?.abort();
      streamAbort = null;
      deltaQueue = [];
      const res = await chatAction(chatId).catch(() => null);
      if (gen !== generation || !res?.ok) return;
      set({ error: null });
      showView(res.data, gen);
    },

    async send() {
      const s = get();
      const text = withMentions(s.draft.trim(), s.draftMentions);
      const images = s.draftImages;
      const clips = s.draftClips;
      if (!text && images.length === 0 && clips.length === 0) return;
      if (clips.some((c) => c.assetId === null)) return;
      set({ draft: "", draftImages: [], draftClips: [], draftMentions: [] });
      // While Seelie works, the message goes into its reply (it reads it before its next step).
      if (s.run && ACTIVE_RUN.includes(s.run.status)) return steer({ text, images, clips });
      await post({ text, images, clips });
    },

    async say(text) {
      const msg: PendingSend = { text, images: [], clips: [] };
      const run = get().run;
      if (run && ACTIVE_RUN.includes(run.status)) return steer(msg);
      if (get().pending) return;
      await post(msg);
    },

    unqueue(index) {
      const queued = [...get().queued];
      const [gone] = queued.splice(index, 1);
      if (!gone) return;
      // Back in the box, to change or send again.
      const s = get();
      set({
        queued,
        draft: [s.draft, gone.text].filter(Boolean).join("\n\n"),
        draftImages: [...s.draftImages, ...gone.images].slice(0, MAX_IMAGES),
        draftClips: [...s.draftClips, ...gone.clips].slice(0, MAX_CLIPS),
      });
    },

    async stop() {
      const run = get().run;
      if (!run) return;
      await fetch(withBasePath(`/api/seelie/runs/${run.id}/abort`), { method: "POST" }).catch(() => {});
    },

    async decide(row, approve, edits) {
      const s = get();
      set({
        tools: {
          ...s.tools,
          [row.callId]: { ...row, status: approve ? "queued" : "denied", approval: approve ? "approved" : "denied" },
        },
      });
      const res = await fetch(withBasePath("/api/seelie/tool-calls"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ runId: row.runId, callId: row.callId, approve, ...(approve && edits ? { edits } : {}) }),
      }).catch(() => null);
      if (!res?.ok) {
        const body = (await res?.json().catch(() => null)) as { error?: string } | null;
        set({ tools: { ...get().tools, [row.callId]: row }, error: body?.error ?? "The decision didn't reach the server. Try again." });
      }
    },

    async react(input) {
      // A reply's thumb shows at once; it goes back if the server says no.
      const before = get().messages;
      if (input.on === "reply") {
        const reaction: Reaction = { liked: input.liked, note: input.note ?? null, ...(input.remember && input.note ? { remembered: true } : {}), at: new Date().toISOString() };
        set({
          messages: before.map((m) => (m.seq === input.seq && m.message.role === "assistant" ? { ...m, message: { ...m.message, reaction } as typeof m.message } : m)),
        });
      }
      const res = await reactAction(input).catch(() => null);
      if (res?.ok) return true;
      if (input.on === "reply") set({ messages: before });
      set({ error: res && !res.ok ? res.error : "That didn't reach the server. Try again." });
      return false;
    },

    addMention(mention) {
      const s = get();
      if (s.draftMentions.some((m) => m.token === mention.token)) return;
      set({ draftMentions: [...s.draftMentions, mention] });
    },

    clearFinished() {
      set({ finished: null });
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
      const picked = files.filter((f) => /^(video|audio)\//.test(f.type) || isPdf(f)).slice(0, Math.max(0, room));
      const patch = (key: string, change: Partial<DraftClip>) =>
        set({ draftClips: get().draftClips.map((c) => (c.key === key ? { ...c, ...change } : c)) });
      for (const file of picked) {
        const clip: DraftClip = {
          key: crypto.randomUUID(),
          name: file.name,
          kind: isPdf(file) ? "pdf" : file.type.startsWith("audio/") ? "audio" : "video",
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

/** The message with each product or order picked with @ as its token (`@Blue kurta` → `@[Blue kurta](product:PB-KU-101)`). */
export function withMentions(text: string, mentions: Mention[]) {
  let out = text;
  for (const m of mentions) {
    const at = `@${m.label}`;
    const i = out.indexOf(at);
    if (i >= 0) out = `${out.slice(0, i)}${m.token}${out.slice(i + at.length)}`;
  }
  return out;
}

export const MAX_DRAFT_IMAGES = MAX_IMAGES;
export const MAX_DRAFT_CLIPS = MAX_CLIPS;

/** Phones and some browsers leave a file's type empty; the name tells then. */
export const isPdf = (f: File) => f.type === "application/pdf" || (!f.type && /\.pdf$/i.test(f.name));
