"use client";

import {
  AlertTriangle,
  Check,
  Clapperboard,
  Download,
  Film,
  ImagePlus,
  Music2,
  RectangleHorizontal,
  RectangleVertical,
  RotateCcw,
  Share2,
  Shuffle,
  Sparkles,
  VolumeX,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Segmented } from "@/components/segmented";
import { Spinner } from "@/components/ui";
import { withBasePath } from "@/lib/base-path";
import type { ReelJobView, ReelLayout } from "@/lib/reels/types";
import { isKept, needsRemake, useReelsStore, type ReelPhoto } from "@/lib/stores/reels-store";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

const SHOT_LABEL: Record<string, string> = {
  full_front: "Front",
  full_back: "Back",
  full_side: "Side",
  half: "Half",
  detail: "Detail",
  other: "",
};

type Store = ReturnType<typeof useReelsStore.getState>;

/** Where the reel is up to, in words, and as a 0..1 fraction for the bar. */
function progressOf(s: Store): { label: string; fraction: number | null } | null {
  const v = s.view;
  const sending = s.kind === "photos" ? s.photos.filter((p) => p.state === "sending").length : s.video?.state === "sending" ? 1 : 0;
  const working = v && ["queued", "selecting", "analyzing", "rendering"].includes(v.status);
  if (s.busy && !working) {
    if (sending > 0) {
      if (s.kind === "video" && s.video) return { label: `Uploading ${Math.round((s.video.sent / s.video.size) * 100)}%`, fraction: (s.video.sent / s.video.size) * 0.2 };
      const n = s.photos.length;
      return { label: `Uploading ${n - sending} of ${n}`, fraction: ((n - sending) / n) * 0.2 };
    }
    return { label: "Starting…", fraction: 0.2 };
  }
  if (!working) return null;
  if (v.status === "queued") return { label: "Starting…", fraction: 0.2 };
  if (v.status === "selecting") return { label: "Choosing the best photos…", fraction: null };
  if (v.status === "analyzing") return { label: "Reading the video…", fraction: null };
  return { label: `Making the reel · ${Math.round(v.progress * 100)}%`, fraction: 0.25 + 0.75 * v.progress };
}

const canShareFiles = () =>
  typeof navigator !== "undefined" &&
  typeof navigator.canShare === "function" &&
  navigator.canShare({ files: [new File([new Uint8Array(1)], "a.mp4", { type: "video/mp4" })] });

/* -------------------------------------------------------------------------- */
/* Screen                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The Reels screen. Photos from a shoot (Gemini picks the keepers) or one
 * supplier video go in; a beat-matched reel with the Paribelle end card comes
 * out. Same frame as the PDF printer: a two-column workspace on desktop, and
 * on phones one screen tall with the actions docked above the bottom bar.
 */
export function Reels() {
  const s = useReelsStore();
  const [share, setShare] = useState(false);

  // Always open at the top, and keep the page itself still on phones.
  useEffect(() => {
    window.scrollTo(0, 0);
    const root = document.documentElement;
    root.classList.add("printer-lock");
    setShare(canShareFiles());
    if (useReelsStore.getState().library.length === 0) void useReelsStore.getState().loadLibrary();
    return () => root.classList.remove("printer-lock");
  }, []);

  const hasInput = s.kind === "photos" ? s.photos.some((p) => p.state !== "failed") : !!s.video && s.video.state !== "failed";
  const done = s.view?.status === "done";
  const remake = needsRemake(s);
  const progress = progressOf(s);
  const failed = s.view?.status === "error" && !s.busy ? s.view : null;
  const showStage = !!progress || done;

  return (
    <div className="printer-surface flex h-[calc(100dvh-57px-24px-76px-56px-env(safe-area-inset-bottom))] flex-col overflow-hidden sm:-mt-[17px] sm:h-[calc(100dvh-57px-7px-76px-env(safe-area-inset-bottom))] lg:block lg:h-auto lg:overflow-visible lg:pb-0">
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-x-5 lg:flex-none lg:grid-cols-[minmax(0,1fr)_340px] lg:grid-rows-none lg:gap-x-[7px]">
        {/* ------------------------------------------------------ left column -- */}
        <div className="flex min-h-0 min-w-0 flex-col overflow-y-auto overflow-x-hidden overscroll-contain lg:block lg:overflow-visible">
          <Presence value={failed}>{(v) => <ErrorHead view={v} onRetry={() => s.make()} onNoAi={() => s.make({ useAi: false })} />}</Presence>
          <Presence value={s.notice}>
            {(n) => (
              <Notice onClose={() => useReelsStore.setState({ notice: null })}>{n}</Notice>
            )}
          </Presence>
          <Presence value={showStage}>
            {() => <Stage s={s} progress={progress} />}
          </Presence>
          <Presence value={done && !progress && s.view}>
            {(v) => (
              <div className="lg:hidden">
                <ResultCard view={v} s={s} share={share} />
              </div>
            )}
          </Presence>
          <div className={cn("pb-3 lg:pb-[7px]", !s.kind && "flex flex-1 flex-col lg:h-full lg:pb-0")}>
            <Dropzone onFiles={s.add} disabled={s.busy} compact={!!s.kind} kind={s.kind} />
          </div>
          <Presence value={s.kind === "photos" && s.photos.length > 0}>{() => <PhotoGrid s={s} />}</Presence>
          <Presence value={s.kind === "video" && s.video}>{(v) => <VideoCard video={v} view={s.view} onClear={s.reset} busy={s.busy} />}</Presence>
        </div>

        {/* ----------------------------------------------------- right column -- */}
        <aside className="hidden lg:block">
          <div className={cn("sticky top-16 space-y-[7px]", !s.kind && "lg:h-full")}>
            <OptionsPanel s={s} />
            <section className="panel space-y-3 p-5">
              <StatusLine s={s} progress={progress} />
              <PrimaryButton s={s} hasInput={hasInput} remake={remake} share={false} className="w-full" />
            </section>
            <Presence value={done && s.view} gap="pb-0">
              {(v) => <ResultCard view={v} s={s} share={share} />}
            </Presence>
          </div>
        </aside>
      </div>

      {/* Below `lg` the options and the button fold into one docked bar. */}
      <div
        className="no-print fixed inset-x-0 bottom-[calc(56px+env(safe-area-inset-bottom))] z-30 border-t px-4 pb-3 pt-3 sm:bottom-0 sm:pb-[calc(12px+env(safe-area-inset-bottom))] lg:hidden"
        style={{ background: "var(--panel)", boxShadow: "0 -6px 20px rgba(15,37,54,0.08)" }}
      >
        <div className="mx-auto flex max-w-2xl items-center gap-3">
          <div className="min-w-0 flex-1">
            <OptionsInline s={s} />
          </div>
          <PrimaryButton s={s} hasInput={hasInput} remake={remake} share={share} className="shrink-0" />
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Presence: blocks slide open and closed instead of popping in               */
/* -------------------------------------------------------------------------- */

/** Same as the printer's: renders while `value` is truthy, and animates in and out. */
function Presence<T>({
  value,
  children,
  gap = "pb-3 lg:pb-[7px]",
}: {
  value: T | null | undefined | false | "" | 0;
  children: (v: T) => ReactNode;
  gap?: string;
}) {
  const last = useRef<T | null>(null);
  if (value) last.current = value as T;
  const shown = !!value;
  const [open, setOpen] = useState(shown);

  useEffect(() => {
    if (shown === open) return;
    const id = requestAnimationFrame(() => setOpen(shown));
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  if (last.current === null) return null;
  return (
    <div
      className="grid"
      style={{
        gridTemplateRows: open ? "1fr" : "0fr",
        opacity: open ? 1 : 0,
        transform: open ? "none" : "translateY(-6px)",
        transition:
          "grid-template-rows 0.5s var(--ease-premium), opacity 0.4s ease, transform 0.5s var(--ease-premium)",
      }}
      aria-hidden={!open}
    >
      <div className="-mx-2 min-h-0 overflow-hidden px-2">
        <div className={gap}>{children(last.current)}</div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Dropzone                                                                   */
/* -------------------------------------------------------------------------- */

function Dropzone({
  onFiles,
  disabled,
  compact,
  kind,
}: {
  onFiles: (files: File[]) => void;
  disabled: boolean;
  compact: boolean;
  kind: Store["kind"];
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  function take(list: FileList | null) {
    if (list && list.length) onFiles(Array.from(list));
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!disabled) take(e.dataTransfer.files);
      }}
      className={cn(
        "panel flex flex-col items-center justify-center text-center transition-colors",
        compact
          ? "gap-2 px-4 py-3 sm:flex-row sm:justify-between sm:gap-3 sm:px-5 sm:py-4 sm:text-left"
          : "flex-1 gap-4 px-6 py-8 sm:py-16 lg:h-full lg:min-h-[420px]",
      )}
      style={{
        borderStyle: "dashed",
        borderWidth: 1.5,
        borderColor: over ? "var(--accent)" : "var(--border-strong)",
        background: over ? "var(--accent-soft)" : "var(--panel)",
      }}
    >
      <input
        ref={input}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        onChange={(e) => {
          take(e.target.files);
          e.target.value = "";
        }}
      />
      <div className={cn("flex items-center gap-4", compact ? "sm:flex-row" : "flex-col")}>
        <span
          className={cn("flex shrink-0 items-center justify-center rounded-2xl", compact ? "hidden h-11 w-11 sm:flex" : "h-14 w-14")}
          style={{ background: "linear-gradient(135deg, var(--accent-soft), rgba(34,211,238,0.14))", color: "var(--accent)" }}
        >
          <Clapperboard className={compact ? "h-5 w-5" : "h-6 w-6"} />
        </span>
        <div>
          <p className={cn("font-semibold", compact ? "text-sm" : "text-base")}>
            {compact ? (kind === "video" ? "Use a different video" : "Add more photos") : (
              <>
                <span className="hidden sm:inline">Drop a product shoot or a supplier video</span>
                <span className="sm:hidden">Add a shoot or a video</span>
              </>
            )}
          </p>
          {!compact ? (
            <p className="muted mt-1 max-w-sm text-[13px]">
              Photos: AI keeps the best and cuts them to a song. A video: its sound and end card go, ours and a song come in.
            </p>
          ) : null}
        </div>
      </div>
      <button type="button" className="btn btn-primary" disabled={disabled} onClick={() => input.current?.click()}>
        <ImagePlus className="h-4 w-4" />
        {compact ? "Choose" : "Choose files"}
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Photos                                                                     */
/* -------------------------------------------------------------------------- */

function PhotoGrid({ s }: { s: Store }) {
  const picks = s.view?.picks ?? null;
  const pickOf = new Map((picks ?? []).map((p) => [p.index, p]));
  const order = new Map((s.view?.order ?? []).map((idx, i) => [idx, i + 1]));
  const kept = s.photos.filter((p) => isKept(s, p.idx)).length;
  const sending = s.photos.filter((p) => p.state === "sending").length;
  // Taps only mean something once there are picks for these exact photos.
  const tappable = !!picks && s.photos.every((p) => pickOf.has(p.idx)) && !s.busy;

  return (
    <section className="panel overflow-hidden">
      <header
        className="flex items-center justify-between gap-3 px-4 py-3"
        style={{ background: "var(--panel-2)", borderBottom: "1px solid var(--border)" }}
      >
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
          Photos
          <span className="rounded-full px-1.5 py-px text-[10.5px] tabular-nums" style={{ background: "var(--panel)", color: "var(--muted)" }}>
            {s.photos.length}
          </span>
          {tappable ? (
            <span className="normal-case tracking-normal" style={{ color: "var(--muted)" }}>
              · {kept} in the reel
            </span>
          ) : sending ? (
            <span className="normal-case tracking-normal" style={{ color: "var(--muted)" }}>
              · uploading {s.photos.length - sending} of {s.photos.length}
            </span>
          ) : null}
        </div>
        <button type="button" onClick={s.reset} disabled={s.busy} className="text-xs font-medium disabled:opacity-40" style={{ color: "var(--accent)" }}>
          Clear all
        </button>
      </header>
      {tappable ? (
        <p className="px-4 pt-3 text-[12.5px]" style={{ color: "var(--muted)" }}>
          Numbers are the order in the reel. Tap a photo to put it in or take it out, then remake.
        </p>
      ) : null}
      <ul className="grid grid-cols-3 gap-2 p-3 sm:grid-cols-[repeat(auto-fill,minmax(112px,1fr))]">
        {s.photos.map((p) => (
          <PhotoTile
            key={p.idx}
            photo={p}
            kept={isKept(s, p.idx)}
            number={order.get(p.idx)}
            label={pickOf.get(p.idx) ? SHOT_LABEL[pickOf.get(p.idx)!.shot] : ""}
            reason={pickOf.get(p.idx)?.reason ?? ""}
            tappable={tappable}
            busy={s.busy}
            onToggle={() => s.toggleKeep(p.idx)}
            onRemove={() => s.removePhoto(p.idx)}
          />
        ))}
      </ul>
    </section>
  );
}

function PhotoTile({
  photo,
  kept,
  number,
  label,
  reason,
  tappable,
  busy,
  onToggle,
  onRemove,
}: {
  photo: ReelPhoto;
  kept: boolean;
  number?: number;
  label: string;
  reason: string;
  tappable: boolean;
  busy: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const out = tappable && !kept;
  return (
    <li className="relative">
      <button
        type="button"
        onClick={tappable ? onToggle : undefined}
        title={reason || photo.name}
        className={cn("group relative block aspect-[3/4] w-full overflow-hidden rounded-xl", tappable ? "cursor-pointer" : "cursor-default")}
        style={{
          background: "var(--panel-2)",
          outline: tappable && kept ? "2px solid var(--accent)" : "1px solid var(--border)",
          outlineOffset: tappable && kept ? -2 : -1,
        }}
        aria-pressed={tappable ? kept : undefined}
        aria-label={tappable ? `${kept ? "Take out" : "Put in"} ${photo.name}` : photo.name}
      >
        {photo.preview ? (
          // Object URLs of local files: nothing for next/image to optimise.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photo.preview}
            alt=""
            className="h-full w-full object-cover transition-[filter,opacity] duration-300"
            style={out ? { filter: "grayscale(1)", opacity: 0.45 } : undefined}
          />
        ) : null}
        {photo.state === "sending" ? (
          <span className="absolute inset-0 flex items-center justify-center" style={{ background: "rgba(255,255,255,0.45)" }}>
            <Spinner size="1.4rem" />
          </span>
        ) : null}
        {photo.state === "failed" ? (
          <span className="absolute inset-x-0 bottom-0 px-2 py-1 text-[11px] font-medium text-white" style={{ background: "var(--danger)" }}>
            Did not upload
          </span>
        ) : null}
        {tappable && kept && number ? (
          <span
            className="absolute left-1.5 top-1.5 flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-[12px] font-semibold tabular-nums text-white"
            style={{ background: "var(--accent)", boxShadow: "0 1px 4px rgba(0,0,0,0.25)" }}
          >
            {number}
          </span>
        ) : null}
        {tappable && kept && !number ? (
          <span className="absolute left-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full text-white" style={{ background: "var(--accent)" }}>
            <Check className="h-3.5 w-3.5" />
          </span>
        ) : null}
        {tappable && (label || (out && reason)) ? (
          <span
            className="absolute inset-x-0 bottom-0 truncate px-2 pb-1.5 pt-4 text-left text-[11px] font-medium text-white"
            style={{ background: "linear-gradient(transparent, rgba(0,0,0,0.6))" }}
          >
            {out && reason ? reason : label}
          </span>
        ) : null}
      </button>
      {!busy ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${photo.name}`}
          className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full text-white opacity-90 transition-opacity hover:opacity-100"
          style={{ background: "rgba(15,23,42,0.55)" }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Video                                                                      */
/* -------------------------------------------------------------------------- */

function VideoCard({
  video,
  view,
  onClear,
  busy,
}: {
  video: NonNullable<Store["video"]>;
  view: ReelJobView | null;
  onClear: () => void;
  busy: boolean;
}) {
  const cut = view?.status === "done" ? view.videoCut : null;
  return (
    <section className="panel flex gap-4 p-3">
      <video
        src={video.preview}
        muted
        playsInline
        preload="metadata"
        className="h-36 w-auto max-w-[45%] shrink-0 rounded-xl object-contain"
        style={{ background: "#0b0f14" }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2 py-1">
        <div className="flex items-start gap-2">
          <Film className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--accent)" }} />
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{video.name}</p>
          <button type="button" onClick={onClear} disabled={busy} aria-label="Remove the video" className="disabled:opacity-40" style={{ color: "var(--muted)" }}>
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="muted text-xs tabular-nums">{mb(video.size)}</p>
        {video.state === "sending" ? (
          <div className="space-y-1">
            <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--panel-2)" }}>
              <div className="h-full rounded-full transition-[width]" style={{ width: `${(video.sent / video.size) * 100}%`, background: "var(--accent)" }} />
            </div>
            <p className="muted text-xs">Uploading…</p>
          </div>
        ) : video.state === "failed" ? (
          <p className="text-xs" style={{ color: "var(--danger)" }}>Did not upload. Choose it again.</p>
        ) : cut ? (
          <p className="text-[13px]" style={{ color: "var(--muted)" }}>
            {cut.endCard ? `Their end card was cut at ${mmss(cut.at)}; ours follows.` : `Kept to ${mmss(cut.at)}, on the beat; our end card follows.`} Their sound is gone.
          </p>
        ) : (
          <p className="muted text-[13px]">Their sound and end card will be taken off.</p>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* The reel itself                                                            */
/* -------------------------------------------------------------------------- */

function Stage({ s, progress }: { s: Store; progress: { label: string; fraction: number | null } | null }) {
  const v = s.view;
  const layout: ReelLayout = progress ? s.layout : (v?.layout ?? s.layout);
  const portrait = layout === "portrait";
  const src = v && v.status === "done" && s.jobId !== null ? withBasePath(`/api/reels/${s.jobId}/video?v=${v.version}`) : null;

  return (
    <section className="panel flex items-center justify-center overflow-hidden p-3" style={{ background: "#0b0f14" }}>
      <div
        className={cn("relative overflow-hidden rounded-lg", portrait ? "h-[min(58dvh,560px)] aspect-[9/16]" : "aspect-video w-full max-h-[58dvh]")}
        style={{ background: "#11161d", maxWidth: "100%" }}
      >
        {progress || !src ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 px-6 text-center text-white">
            <Spinner size="2.4rem" color="#7dd3fc" />
            <p className="text-sm font-medium">{progress?.label ?? "Starting…"}</p>
            <div className="h-1 w-40 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.12)" }}>
              {progress?.fraction != null ? (
                <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${progress.fraction * 100}%`, background: "#7dd3fc" }} />
              ) : (
                <div className="h-full w-1/3 rounded-full" style={{ background: "#7dd3fc", animation: "sync-sweep 1.1s ease-in-out infinite" }} />
              )}
            </div>
          </div>
        ) : (
          <video key={src} src={src} controls playsInline preload="metadata" className="absolute inset-0 h-full w-full object-contain" />
        )}
      </div>
    </section>
  );
}

function ResultCard({ view, s, share }: { view: ReelJobView; s: Store; share: boolean }) {
  const song = view.song;
  return (
    <section className="panel space-y-4 p-4 lg:p-5">
      {song ? (
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: "var(--accent-soft)", color: "var(--accent)" }}>
            <Music2 className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{song.title}</p>
            <p className="muted truncate text-xs">
              {song.artist} · {Math.round(song.bpm)} BPM{view.duration ? ` · ${view.duration.toFixed(1)} s` : ""}
            </p>
          </div>
          <button type="button" className="btn shrink-0 px-2.5 text-xs" disabled={s.busy} onClick={() => s.make({ track: "next" })}>
            <Shuffle className="h-3.5 w-3.5" />
            Different song
          </button>
        </div>
      ) : null}

      {song ? (
        <p className="rounded-xl px-3 py-2.5 text-[12.5px] leading-snug" style={{ background: "var(--panel-2)", color: "var(--muted)" }}>
          Posting the copy without music? In Instagram, add <b style={{ color: "var(--text)" }}>{song.title}</b> and start it at{" "}
          <b className="tabular-nums" style={{ color: "var(--text)" }}>{mmss(song.cue)}</b>: the cuts land on its beats.
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <button type="button" className="btn btn-primary" disabled={!!s.saving} onClick={() => s.save("music")}>
          {s.saving === "music" ? <Spinner size="1rem" color="#fff" /> : <Download className="h-4 w-4" />}
          Download
        </button>
        <button type="button" className="btn" disabled={!!s.saving} onClick={() => s.save("silent")}>
          {s.saving === "silent" ? <Spinner size="1rem" /> : <VolumeX className="h-4 w-4" />}
          No music
        </button>
        {share ? (
          <button type="button" className="btn col-span-2" disabled={!!s.saving} onClick={() => s.save("share")}>
            {s.saving === "share" ? <Spinner size="1rem" /> : <Share2 className="h-4 w-4" />}
            Share to WhatsApp, Instagram…
          </button>
        ) : null}
      </div>

      <button type="button" onClick={s.reset} disabled={s.busy} className="flex items-center gap-1.5 text-xs font-medium disabled:opacity-40" style={{ color: "var(--accent)" }}>
        <RotateCcw className="h-3.5 w-3.5" />
        Start a new reel
      </button>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Options, status, the button                                                */
/* -------------------------------------------------------------------------- */

const LAYOUTS = [
  { key: "portrait" as const, label: "Portrait", icon: <RectangleVertical className="h-3.5 w-3.5" /> },
  { key: "landscape" as const, label: "Landscape", icon: <RectangleHorizontal className="h-3.5 w-3.5" /> },
];

function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={cn("flex items-start gap-3", disabled ? "opacity-50" : "cursor-pointer")}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors"
        style={{ background: checked ? "var(--accent)" : "var(--border-strong)" }}
      >
        <span className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-[left]" style={{ left: checked ? 18 : 2, boxShadow: "var(--shadow-xs)" }} />
      </button>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {hint ? <span className="muted block text-xs">{hint}</span> : null}
      </span>
    </label>
  );
}

function OptionsPanel({ s }: { s: Store }) {
  return (
    <section className="panel space-y-4 p-5">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
        Reel options
      </h2>
      <div className="space-y-2">
        <p className="text-sm font-medium">Shape</p>
        <Segmented label="Shape" items={LAYOUTS} value={s.layout} onChange={s.setLayout} className="w-full [&>button]:flex-1 [&>button]:justify-center" />
        <p className="muted text-xs">{s.layout === "portrait" ? "9:16, for Reels, Stories and WhatsApp status." : "16:9, for YouTube and feeds."}</p>
      </div>
      {s.kind !== "video" ? (
        <Toggle
          checked={s.useAi}
          onChange={s.setUseAi}
          disabled={s.busy}
          label="AI picks the photos"
          hint={s.useAi ? "Keeps the best shots and orders them by outfit." : "Every photo, in the order added."}
        />
      ) : null}
      <div className="space-y-2">
        <label htmlFor="reel-song" className="block text-sm font-medium">
          Song
        </label>
        <select
          id="reel-song"
          value={String(s.song)}
          onChange={(e) => s.setSong(e.target.value === "auto" ? "auto" : Number(e.target.value))}
          className="input w-full"
        >
          <option value="auto">{s.view?.song ? `Keep ${s.view.song.title}` : "Best match"}</option>
          {s.library.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title} · {t.artist}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}

function StatusLine({ s, progress }: { s: Store; progress: { label: string; fraction: number | null } | null }) {
  let text: string;
  if (progress) text = progress.label;
  else if (s.kind === "photos") {
    const sending = s.photos.filter((p) => p.state === "sending").length;
    text = sending ? `Uploading ${s.photos.length - sending} of ${s.photos.length} photos` : `${s.photos.length} photo${s.photos.length === 1 ? "" : "s"} ready`;
  } else if (s.kind === "video" && s.video) {
    text = s.video.state === "sending" ? `Uploading the video · ${Math.round((s.video.sent / s.video.size) * 100)}%` : "Video ready";
  } else text = "Add photos or a video to start";
  const fraction = progress ? progress.fraction : s.view?.status === "done" && !s.busy ? 1 : 0;

  return (
    <>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="muted truncate font-medium">{text}</span>
        {s.view?.status === "done" && !progress && s.view.duration ? (
          <span className="muted shrink-0 tabular-nums">{s.view.duration.toFixed(1)} s</span>
        ) : null}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--panel-2)" }}>
        {fraction == null ? (
          <div
            className="h-full w-1/3 rounded-full"
            style={{ background: "linear-gradient(90deg, var(--accent), var(--accent-2))", animation: "sync-sweep 1.1s ease-in-out infinite" }}
          />
        ) : (
          <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${fraction * 100}%`, background: "linear-gradient(90deg, var(--accent), var(--accent-2))" }} />
        )}
      </div>
    </>
  );
}

function OptionsInline({ s }: { s: Store }) {
  const chip = (on: boolean, label: ReactNode, flip: () => void, key: string) => (
    <button
      key={key}
      type="button"
      onClick={flip}
      disabled={s.busy}
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-medium disabled:opacity-50"
      style={{ background: on ? "var(--accent-soft)" : "var(--panel-2)", color: on ? "#0b7fb0" : "var(--muted)" }}
    >
      {label}
    </button>
  );
  const portrait = s.layout === "portrait";
  return (
    <div className="flex gap-2 overflow-x-auto">
      {chip(
        true,
        <>
          {portrait ? <RectangleVertical className="h-3.5 w-3.5" /> : <RectangleHorizontal className="h-3.5 w-3.5" />}
          {portrait ? "Portrait" : "Landscape"}
        </>,
        () => s.setLayout(portrait ? "landscape" : "portrait"),
        "layout",
      )}
      {s.kind !== "video"
        ? chip(
            s.useAi,
            <>
              <Sparkles className="h-3.5 w-3.5" />
              AI picks
            </>,
            () => s.setUseAi(!s.useAi),
            "ai",
          )
        : null}
    </div>
  );
}

function PrimaryButton({
  s,
  hasInput,
  remake,
  share,
  className,
}: {
  s: Store;
  hasInput: boolean;
  remake: boolean;
  share: boolean;
  className?: string;
}) {
  const done = s.view?.status === "done";
  if (s.busy) {
    return (
      <button type="button" className={cn("btn btn-primary", className)} disabled>
        <Spinner size="1.1rem" color="#fff" />
        Making…
      </button>
    );
  }
  if (done && !remake) {
    // Phones hand the reel straight to WhatsApp or Instagram; desktop saves it.
    return (
      <button type="button" className={cn("btn btn-primary", className)} disabled={!!s.saving} onClick={() => s.save(share ? "share" : "music")}>
        {s.saving ? <Spinner size="1.1rem" color="#fff" /> : share ? <Share2 className="h-4 w-4" /> : <Download className="h-4 w-4" />}
        {share ? "Share" : "Download reel"}
      </button>
    );
  }
  return (
    <button type="button" className={cn("btn btn-primary", className)} disabled={!hasInput} onClick={() => s.make()}>
      <Clapperboard className="h-4 w-4" />
      {done && remake ? "Remake reel" : "Make reel"}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                   */
/* -------------------------------------------------------------------------- */

function Notice({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-[13px]" style={{ background: "var(--warn-soft)", color: "#8a5a17" }}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
      <button type="button" onClick={onClose} aria-label="Dismiss">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

function ErrorHead({ view, onRetry, onNoAi }: { view: ReelJobView; onRetry: () => void; onNoAi: () => void }) {
  return (
    <div
      className="flex flex-col gap-3 rounded-2xl px-4 py-3.5 sm:flex-row sm:items-start"
      style={{ background: "var(--danger-soft)", color: "var(--danger)", border: "1px solid color-mix(in srgb, var(--danger) 25%, transparent)" }}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-semibold">Could not make the reel</p>
          <p className="mt-0.5 break-words text-[13px]">{view.error}</p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        {view.aiFailed ? (
          <button type="button" className="btn btn-primary text-xs" onClick={onNoAi}>
            Make it without AI
          </button>
        ) : null}
        <button type="button" className="btn text-xs" onClick={onRetry}>
          Try again
        </button>
      </div>
    </div>
  );
}
