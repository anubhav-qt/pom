"use client";

import { Check, Mic, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { withBasePath } from "@/lib/base-path";
import { cn } from "@/lib/utils";

import { downsample, joinWords, Pieces, RATE, wav, type Cut } from "./voice-pieces";

/**
 * Voice input. While the mic is on, the recording is cut at each pause and every piece
 * goes to Gemini Flash (POST /api/seelie/transcribe), so the words land in the box a
 * couple of seconds behind the voice; a piece still being spoken is sent again every
 * few seconds, its words replaced each time. When the person stops, the whole recording
 * is written out once more and replaces the pieces (clean joins), then the box is theirs
 * to edit and send.
 */

/** Same as the server's MAX_VOICE_SECONDS: the mic turns itself off here. */
const MAX_SECONDS = 180;
/** How often a piece still being spoken is sent again. */
const OPEN_EVERY_MS = 2_500;
/** Bars in the sound wave. */
const BARS = 28;

export type VoiceState = "idle" | "starting" | "listening" | "finishing";

type Piece = { text: string; final: boolean; seq: number };

/** The worklet that hands the mic's samples over in 4096-sample batches. */
const WORKLET = `class SeelieMic extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(4096); this.n = 0; }
      }
    }
    return true;
  }
}
registerProcessor("seelie-mic", SeelieMic);`;

/** Whether this browser can record here (a secure page with a microphone API). */
export function canRecord() {
  return typeof window !== "undefined" && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== "undefined";
}

class VoiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function writeOut(samples: Float32Array, before: string, signal: AbortSignal): Promise<string> {
  const res = await fetch(withBasePath("/api/seelie/transcribe"), {
    method: "POST",
    headers: {
      "content-type": "audio/wav",
      ...(before ? { "x-before": encodeURIComponent(before.slice(-400)) } : {}),
    },
    body: new Blob([wav(samples)], { type: "audio/wav" }),
    signal,
  });
  const json = (await res.json().catch(() => null)) as {
    text?: string;
    error?: string;
  } | null;
  if (!res.ok) throw new VoiceError(json?.error ?? `Couldn't write that out (${res.status}).`, res.status);
  return json?.text ?? "";
}

/**
 * The mic. `text` is what has been said so far (live while listening, final once
 * `onDone` has run); `onDone` gets the finished words. `cancel` drops the recording.
 */
export function useVoice({ onDone }: { onDone: (text: string) => void }) {
  const [state, setState] = useState<VoiceState>("idle");
  const [text, setText] = useState("");
  const [levels, setLevels] = useState<number[]>([]);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const live = useRef<{
    stream: MediaStream;
    ctx: AudioContext;
    node: AudioWorkletNode;
    pieces: Pieces;
    words: Map<number, Piece>;
    openId: number;
    openSent: number;
    openBusy: boolean;
    seq: number;
    finals: Promise<void>[];
    abort: AbortController;
    timer: number;
    raf: number;
  } | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const shown = useCallback(() => {
    const s = live.current;
    if (!s) return "";
    return joinWords([...s.words.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p.text));
  }, []);

  const release = useCallback(() => {
    const s = live.current;
    if (!s) return;
    live.current = null;
    clearInterval(s.timer);
    cancelAnimationFrame(s.raf);
    s.node.port.onmessage = null;
    s.node.disconnect();
    s.stream.getTracks().forEach((t) => t.stop());
    void s.ctx.close().catch(() => undefined);
  }, []);

  // Sends piece `id` (samples `cut`). An open piece's answer only lands if it is still the newest for that piece.
  const send = useCallback(
    (id: number, cut: Cut, final: boolean) => {
      const s = live.current;
      if (!s) return Promise.resolve();
      const seq = ++s.seq;
      const before = joinWords(
        [...s.words.entries()]
          .filter(([k]) => k < id)
          .sort((a, b) => a[0] - b[0])
          .map(([, p]) => p.text),
      );
      const job = writeOut(s.pieces.slice(cut.from, cut.to), before, s.abort.signal)
        .then((words) => {
          if (live.current !== s) return;
          const had = s.words.get(id);
          if (had && (had.final || had.seq > seq) && !final) return;
          s.words.set(id, { text: words, final, seq });
          setText(shown());
        })
        .catch((err: unknown) => {
          if (live.current !== s || s.abort.signal.aborted) return;
          setError(err instanceof Error ? err.message : "Couldn't write that out.");
        });
      return job;
    },
    [shown],
  );

  const sendOpen = useCallback(() => {
    const s = live.current;
    if (!s || s.openBusy) return;
    const cut = s.pieces.open();
    if (!cut) return;
    s.openBusy = true;
    s.openSent = performance.now();
    const id = s.openId;
    void send(id, cut, false).finally(() => {
      if (live.current === s) s.openBusy = false;
    });
  }, [send]);

  const stop = useCallback(async () => {
    const s = live.current;
    if (!s || state !== "listening") return;
    setState("finishing");
    clearInterval(s.timer);
    s.node.port.onmessage = null;
    s.stream.getTracks().forEach((t) => t.stop());
    const last = s.pieces.finish();
    if (last) s.finals.push(send(s.openId, last, true));
    await Promise.all(s.finals);
    if (live.current !== s) return;
    let words = shown();
    // The whole recording once more, for clean joins (one piece already was the whole).
    if (s.words.size > 1 && s.pieces.samples > 0) {
      try {
        const whole = await writeOut(s.pieces.slice(0, s.pieces.samples), "", s.abort.signal);
        if (whole) words = whole;
      } catch {
        // Keep the pieces' words.
      }
    }
    if (live.current !== s) return;
    release();
    setText(words);
    setState("idle");
    doneRef.current(words);
  }, [release, send, shown, state]);

  const cancel = useCallback(() => {
    live.current?.abort.abort();
    release();
    setText("");
    setState("idle");
  }, [release]);

  const start = useCallback(async () => {
    if (live.current || state !== "idle") return;
    setError(null);
    setText("");
    setLevels([]);
    setSeconds(0);
    setState("starting");
    // Made inside the tap, so iPhones let it play.
    const ctx = new AudioContext();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      void ctx.close().catch(() => undefined);
      setState("idle");
      const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
      setError(denied ? "The microphone is blocked for this site. Allow it in the browser's site settings." : "No microphone was found.");
      return;
    }
    try {
      await ctx.resume();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => undefined);
      setState("idle");
      setError("This browser can't record here.");
      return;
    }
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, "seelie-mic");
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute).connect(ctx.destination);

    const began = performance.now();
    const s = {
      stream,
      ctx,
      node,
      pieces: new Pieces(),
      words: new Map<number, Piece>(),
      openId: 0,
      openSent: began,
      openBusy: false,
      seq: 0,
      finals: [] as Promise<void>[],
      abort: new AbortController(),
      timer: 0,
      raf: 0,
    };
    live.current = s;

    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (live.current !== s) return;
      for (const cut of s.pieces.push(downsample(e.data, ctx.sampleRate))) {
        s.finals.push(send(s.openId, cut, true));
        s.openId++;
        s.openSent = performance.now();
      }
      if (performance.now() - s.openSent >= OPEN_EVERY_MS) sendOpen();
    };
    s.timer = window.setInterval(() => {
      const secs = Math.floor((performance.now() - began) / 1000);
      setSeconds(secs);
      if (secs >= MAX_SECONDS) stopRef.current();
    }, 250);
    // The wave redraws 20 times a second, not every frame: each redraw re-renders the box.
    let drawn = 0;
    const draw = (now: number) => {
      if (live.current !== s) return;
      if (now - drawn >= 50) {
        drawn = now;
        setLevels(s.pieces.levels(BARS * 3).filter((_, i) => i % 3 === 0));
      }
      s.raf = requestAnimationFrame(draw);
    };
    s.raf = requestAnimationFrame(draw);
    setState("listening");
  }, [send, sendOpen, state]);

  const stopRef = useRef(() => undefined as unknown);
  stopRef.current = () => void stop();

  // Leaving the page turns the mic off.
  useEffect(
    () => () => {
      live.current?.abort.abort();
      release();
    },
    [release],
  );

  return {
    state,
    text,
    levels,
    seconds,
    error,
    clearError: () => setError(null),
    start,
    stop: () => void stop(),
    cancel,
  };
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** The mic button beside Send. */
export function MicButton({ onClick, disabled, compact }: { onClick: () => void; disabled?: boolean; compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn("nav-icon-btn shrink-0 disabled:opacity-40", compact ? "h-9 w-9" : "mr-1 h-8 w-8")}
      style={{ color: "var(--muted)" }}
      aria-label="Speak instead of typing"
      title="Speak: your words appear in the box as you talk"
    >
      <Mic className="h-[18px] w-[18px]" />
    </button>
  );
}

/** While the mic is on: cancel, the time, the sound wave and Done. */
export function RecordingBar({ voice, onCancel, className }: { voice: ReturnType<typeof useVoice>; onCancel: () => void; className?: string }) {
  const finishing = voice.state === "finishing";
  const bars = Array.from({ length: BARS }, (_, i) => voice.levels[voice.levels.length - BARS + i] ?? 0);
  return (
    <div className={cn("flex items-center gap-2", className)} onMouseDown={(e) => e.preventDefault()}>
      <button type="button" onClick={onCancel} className="nav-icon-btn h-8 w-8 shrink-0" style={{ color: "var(--muted)" }} aria-label="Drop the recording" title="Drop it">
        <X className="h-[18px] w-[18px]" />
      </button>
      {finishing ? (
        <span className="sl-shimmer flex-1 text-[13px]">Writing it out…</span>
      ) : (
        <>
          <span className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums" style={{ color: "var(--muted)" }}>
            <span className="h-2 w-2 rounded-full" style={{ background: "var(--danger)" }} />
            {clock(voice.seconds)}
          </span>
          <span className="flex h-6 min-w-0 flex-1 items-center gap-[3px] overflow-hidden" aria-hidden>
            {bars.map((level, i) => (
              <span
                key={i}
                className="w-[3px] shrink-0 rounded-full"
                style={{
                  height: `${Math.max(12, Math.round(level * 100))}%`,
                  background: level > 0.08 ? "var(--accent)" : "var(--border)",
                }}
              />
            ))}
          </span>
        </>
      )}
      <button type="button" onClick={voice.stop} disabled={finishing || voice.state !== "listening"} className="sl-send h-8 w-8" aria-label="Done speaking" title="Done">
        <Check className="h-4 w-4" strokeWidth={2.5} />
      </button>
    </div>
  );
}
