"use client";

import { Check, Mic, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { withBasePath } from "@/lib/base-path";
import { cn } from "@/lib/utils";

import { downsample, Recording, wav } from "./voice-audio";

/**
 * Voice input. The mic records (a timer and a sound wave show it is listening); on Done
 * the whole recording goes to Gemini Flash once (POST /api/seelie/transcribe) and its
 * words land in the box, after anything already typed, for the person to edit and send.
 */

/** Same as the server's MAX_VOICE_SECONDS: the mic turns itself off here. */
const MAX_SECONDS = 180;
/** Bars in the sound wave. */
const BARS = 28;

export type VoiceState = "idle" | "starting" | "listening" | "finishing";

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

async function writeOut(samples: Float32Array, signal: AbortSignal): Promise<string> {
  const res = await fetch(withBasePath("/api/seelie/transcribe"), {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: new Blob([wav(samples)], { type: "audio/wav" }),
    signal,
  });
  const json = (await res.json().catch(() => null)) as { text?: string; error?: string } | null;
  if (!res.ok) throw new Error(json?.error ?? `Couldn't write that out (${res.status}).`);
  return json?.text ?? "";
}

/** The mic. `onDone` gets the words once the recording is written out; `cancel` drops it. */
export function useVoice({ onDone }: { onDone: (text: string) => void }) {
  const [state, setState] = useState<VoiceState>("idle");
  const [levels, setLevels] = useState<number[]>([]);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const live = useRef<{
    stream: MediaStream;
    ctx: AudioContext;
    node: AudioWorkletNode;
    recording: Recording;
    abort: AbortController;
    timer: number;
    raf: number;
  } | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

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

  const stop = useCallback(async () => {
    const s = live.current;
    if (!s || state !== "listening") return;
    clearInterval(s.timer);
    cancelAnimationFrame(s.raf);
    s.node.port.onmessage = null;
    s.stream.getTracks().forEach((t) => t.stop());
    if (!s.recording.heardSpeech()) {
      release();
      setState("idle");
      setError("Nothing was heard. Check the microphone and try again.");
      return;
    }
    setState("finishing");
    let words = "";
    try {
      words = await writeOut(s.recording.all(), s.abort.signal);
    } catch (err) {
      if (live.current !== s) return;
      release();
      setState("idle");
      setError(err instanceof Error ? err.message : "Couldn't write that out.");
      return;
    }
    if (live.current !== s) return;
    release();
    setState("idle");
    if (words) doneRef.current(words);
    else setError("Gemini heard no words in that.");
  }, [release, state]);

  const cancel = useCallback(() => {
    live.current?.abort.abort();
    release();
    setState("idle");
  }, [release]);

  const start = useCallback(async () => {
    if (live.current || state !== "idle") return;
    setError(null);
    setLevels([]);
    setSeconds(0);
    setState("starting");
    // Made inside the tap, so iPhones let it play.
    const ctx = new AudioContext();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
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
    const s = { stream, ctx, node, recording: new Recording(), abort: new AbortController(), timer: 0, raf: 0 };
    live.current = s;

    node.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (live.current === s) s.recording.push(downsample(e.data, ctx.sampleRate));
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
        setLevels(s.recording.levels(BARS * 3).filter((_, i) => i % 3 === 0));
      }
      s.raf = requestAnimationFrame(draw);
    };
    s.raf = requestAnimationFrame(draw);
    setState("listening");
  }, [state]);

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

  return { state, levels, seconds, error, clearError: () => setError(null), start, stop: () => void stop(), cancel };
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
      title="Speak: when you tap Done, your words land in the box"
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
