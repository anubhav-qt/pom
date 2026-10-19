"use client";

import { Download, ExternalLink, FileText, Film, Images, MessageSquarePlus, PenLine, Share2, SquareDashed, ThumbsDown, ThumbsUp, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { ZoomImg } from "@/components/image-lightbox";
import { Modal } from "@/components/modal";
import { Spinner } from "@/components/ui";
import { withBasePath } from "@/lib/base-path";
import { useSeelie } from "@/lib/stores/seelie-store";
import { cn } from "@/lib/utils";

import type { CardDocument, CardPicture, CardVideo, Change, Made } from "./turns";

/**
 * What Seelie made, where it shows in the chat: pictures (each can be marked up: boxes drawn
 * with a finger or the mouse, a note on each, and before/after against what it was made
 * from), PDFs, and videos (with notes at a moment, a box on the frame if it helps, and a
 * thumbs up or down Seelie learns from). Feedback goes to Seelie as a message.
 */

export const assetUrl = (id: number, query: string) => withBasePath(`/api/seelie/assets/${id}?${query}`);

/* -------------------------------------------------------------------------- */
/* Pictures and PDFs                                                          */
/* -------------------------------------------------------------------------- */

export function Pictures({ pictures, small }: { pictures: CardPicture[]; small?: boolean }) {
  const [marking, setMarking] = useState<CardPicture | null>(null);
  return (
    <>
      {/* Three across a phone's width; fixed-size tiles from `sm` up. */}
      <div className={cn("mt-2 grid gap-2 sm:flex sm:flex-wrap sm:gap-2.5", small ? "grid-cols-4" : "grid-cols-3")}>
        {pictures.map((p) => (
          <figure key={p.id} id={`made-picture-${p.id}`} className={cn("min-w-0 space-y-1", small ? "sm:w-20" : "sm:w-28")}>
            <ZoomImg
              src={assetUrl(p.id, "w=480")}
              fullSrc={assetUrl(p.id, "w=1280")}
              alt={p.name}
              className={cn("aspect-[7/9] w-full rounded-lg object-cover", small ? "sm:h-[6.5rem] sm:w-20" : "sm:h-36 sm:w-28")}
              style={{ border: "1px solid var(--border)", background: "var(--panel)" }}
            />
            <figcaption className="flex items-center gap-0.5">
              <span className="muted min-w-0 flex-1 truncate text-[11px]" title={p.name}>
                {p.size ?? p.name}
              </span>
              <button type="button" onClick={() => setMarking(p)} className="btn shrink-0 p-1.5 sm:p-1" aria-label={`Mark up ${p.name}`} title="Mark up what to change">
                <PenLine className="h-3.5 w-3.5" />
              </button>
              <a href={assetUrl(p.id, "download=1")} download className="btn shrink-0 p-1.5 sm:p-1" aria-label={`Download ${p.name}`} title="Download">
                <Download className="h-3.5 w-3.5" />
              </a>
            </figcaption>
          </figure>
        ))}
      </div>
      {marking ? <PhotoMarkup picture={marking} onClose={() => setMarking(null)} /> : null}
    </>
  );
}

export function Documents({ documents }: { documents: CardDocument[] }) {
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      {documents.map((d) => (
        <div key={d.id} id={`made-document-${d.id}`} className="surface-2 flex max-w-md items-center gap-2.5 px-2.5 py-2">
          <FileText className="h-5 w-5 shrink-0" style={{ color: "var(--muted)" }} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium" title={d.name}>
              {d.name}
            </p>
            <p className="muted text-[11px] tabular-nums">
              {[d.pages ? `${d.pages} page${d.pages === 1 ? "" : "s"}` : null, d.kb ? (d.kb >= 1024 ? `${(d.kb / 1024).toFixed(1)} MB` : `${d.kb} KB`) : null, d.locked ? "password-locked" : null]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <a href={assetUrl(d.id, "")} target="_blank" rel="noopener" className="btn shrink-0 p-1.5" aria-label={`Open ${d.name}`} title="Open">
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <a href={assetUrl(d.id, "download=1")} download className="btn shrink-0 p-1.5" aria-label={`Download ${d.name}`} title="Download">
            <Download className="h-3.5 w-3.5" />
          </a>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Videos                                                                     */
/* -------------------------------------------------------------------------- */

export function VideoBlock({ video, size = "md" }: { video: CardVideo; size?: "sm" | "md" }) {
  return (
    <div id={video.id ? `made-video-${video.id}` : undefined} className="max-w-full">
      <video
        src={video.src}
        poster={video.poster}
        controls
        playsInline
        preload="metadata"
        className={cn("w-auto max-w-full rounded-xl bg-black", size === "sm" ? "max-h-64" : "max-h-[26rem]")}
      />
      <VideoActions video={video} />
    </div>
  );
}

/** Save it, hand it to another app, leave notes on it, or say whether it's good. */
function VideoActions({ video }: { video: CardVideo }) {
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [canShare, setCanShare] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [liked, setLiked] = useState<boolean | null>(video.liked ?? null);

  useEffect(() => {
    try {
      setCanShare(typeof navigator.canShare === "function" && navigator.canShare({ files: [new File([""], "x.mp4", { type: "video/mp4" })] }));
    } catch {
      setCanShare(false);
    }
  }, []);

  async function share() {
    setSharing(true);
    setError(null);
    try {
      const res = await fetch(video.src, { cache: "no-store" });
      if (!res.ok) throw new Error(`Couldn't fetch the video (${res.status}).`);
      const name = `${video.title.replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 60) || "video"}.mp4`;
      const file = new File([await res.blob()], name, { type: "video/mp4" });
      await navigator.share({ files: [file], title: video.title });
    } catch (err) {
      // Closing the share sheet isn't a failure.
      if (!(err instanceof DOMException && err.name === "AbortError")) setError(err instanceof Error ? err.message : "Couldn't share it.");
    } finally {
      setSharing(false);
    }
  }

  async function rate(next: boolean) {
    if (!video.id) return;
    const value = liked === next ? null : next;
    setLiked(value);
    const ok = await useSeelie.getState().react({ on: "video", id: video.id, liked: value });
    if (!ok) setLiked(liked);
  }

  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {video.ref ? (
          <button type="button" className="btn btn-white px-2.5 py-1.5 text-[13px]" onClick={() => setReviewing(true)}>
            <MessageSquarePlus className="h-3.5 w-3.5" />
            Notes
          </button>
        ) : null}
        {video.download ? (
          <a href={video.download} download className="btn btn-white px-2.5 py-1.5 text-[13px]">
            <Download className="h-3.5 w-3.5" />
            <span className="hidden min-[400px]:inline">Download</span>
          </a>
        ) : null}
        {canShare ? (
          <button type="button" className="btn btn-white px-2.5 py-1.5 text-[13px]" disabled={sharing} onClick={() => void share()}>
            {sharing ? <Spinner size="0.9rem" /> : <Share2 className="h-3.5 w-3.5" />}
            <span className="hidden min-[400px]:inline">Share</span>
          </button>
        ) : null}
        {video.id ? (
          <span className="ml-0.5 flex items-center">
            <Thumb up active={liked === true} onClick={() => void rate(true)} label="Good video" />
            <Thumb active={liked === false} onClick={() => void rate(false)} label="Not good" />
          </span>
        ) : null}
        {error ? (
          <span className="text-xs" style={{ color: "var(--danger)" }}>
            {error}
          </span>
        ) : null}
      </div>
      {reviewing && video.ref ? <VideoReview video={video} onClose={() => setReviewing(false)} /> : null}
    </>
  );
}

export function Thumb({ up, active, onClick, label }: { up?: boolean; active: boolean; onClick: () => void; label: string }) {
  const Icon = up ? ThumbsUp : ThumbsDown;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className="nav-icon-btn h-8 w-8"
      style={{ color: active ? (up ? "var(--ok)" : "var(--danger)") : "var(--muted-2)" }}
    >
      <Icon className="h-[15px] w-[15px]" fill={active ? "currentColor" : "none"} fillOpacity={active ? 0.18 : 0} />
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Boxes drawn on a picture or a frame                                        */
/* -------------------------------------------------------------------------- */

/** A box as shares of the width and height, from the top left. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const pct = (n: number) => Math.round(n * 100);
const boxWords = (b: Box) => `${pct(b.x)}-${pct(b.x + b.w)}% across, ${pct(b.y)}-${pct(b.y + b.h)}% down`;
const clamp = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Where boxes are drawn: a drag (finger or mouse) makes one. The surface stops the page
 * scrolling under a finger only while it's on, so a phone can still scroll past it.
 */
function DrawSurface({ boxes, onAdd, selected, onSelect, enabled }: { boxes: Box[]; onAdd: (b: Box) => void; selected: number | null; onSelect: (i: number) => void; enabled: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<{ x0: number; y0: number; box: Box } | null>(null);

  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width), y: clamp((e.clientY - r.top) / r.height) };
  };

  return (
    <div
      ref={ref}
      className="absolute inset-0"
      style={{ touchAction: enabled ? "none" : "auto", cursor: enabled ? "crosshair" : "default", pointerEvents: enabled ? "auto" : "none" }}
      onPointerDown={(e) => {
        if (!enabled || e.button > 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = at(e);
        setDraft({ x0: p.x, y0: p.y, box: { x: p.x, y: p.y, w: 0, h: 0 } });
      }}
      onPointerMove={(e) => {
        if (!draft) return;
        const p = at(e);
        setDraft({ ...draft, box: { x: Math.min(draft.x0, p.x), y: Math.min(draft.y0, p.y), w: Math.abs(p.x - draft.x0), h: Math.abs(p.y - draft.y0) } });
      }}
      onPointerUp={() => {
        if (draft && draft.box.w > 0.03 && draft.box.h > 0.03) onAdd(draft.box);
        setDraft(null);
      }}
      onPointerCancel={() => setDraft(null)}
    >
      {[...boxes, ...(draft ? [draft.box] : [])].map((b, i) => (
        <button
          type="button"
          key={i}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => i < boxes.length && onSelect(i)}
          className="absolute rounded-md"
          style={{
            left: `${b.x * 100}%`,
            top: `${b.y * 100}%`,
            width: `${b.w * 100}%`,
            height: `${b.h * 100}%`,
            border: `2px solid ${i === selected ? "var(--warn)" : "var(--accent)"}`,
            background: i === selected ? "color-mix(in srgb, var(--warn) 14%, transparent)" : "color-mix(in srgb, var(--accent) 10%, transparent)",
            boxShadow: "0 0 0 1px rgba(255,255,255,0.7)",
            pointerEvents: i < boxes.length ? "auto" : "none",
          }}
          aria-label={`Box ${i + 1}`}
        >
          {i < boxes.length ? (
            <span
              className="absolute -left-2 -top-2 flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-semibold text-white"
              style={{ background: i === selected ? "var(--warn)" : "var(--accent)" }}
            >
              {i + 1}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/** One note per box (and one for the whole), each with a remove button. */
function BoxNotes({
  notes,
  onChange,
  onRemove,
  selected,
  onSelect,
  prefix,
}: {
  notes: { box?: Box | null; note: string; label?: string; onLabel?: () => void }[];
  onChange: (i: number, note: string) => void;
  onRemove: (i: number) => void;
  selected: number | null;
  onSelect: (i: number) => void;
  prefix?: (i: number) => React.ReactNode;
}) {
  return (
    <ol className="space-y-1.5">
      {notes.map((n, i) => (
        <li key={i} className="flex items-start gap-2">
          <button
            type="button"
            onClick={() => onSelect(i)}
            className="mt-1.5 flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums text-white"
            style={{ background: i === selected ? "var(--warn)" : "var(--accent)" }}
            aria-label={`Note ${i + 1}`}
          >
            {prefix ? prefix(i) : i + 1}
          </button>
          <textarea
            value={n.note}
            rows={1}
            autoFocus={i === notes.length - 1 && !n.note}
            onFocus={() => onSelect(i)}
            onChange={(e) => onChange(i, e.target.value)}
            placeholder={n.box ? "What should change here?" : "What should change?"}
            className="input min-h-[2.25rem] flex-1 resize-y py-1.5 text-base sm:text-sm"
          />
          <button type="button" onClick={() => onRemove(i)} className="btn mt-0.5 shrink-0 p-2" aria-label={`Remove note ${i + 1}`}>
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </li>
      ))}
    </ol>
  );
}

/* -------------------------------------------------------------------------- */
/* Mark up a picture                                                          */
/* -------------------------------------------------------------------------- */

/** Draw boxes where something should change, a note on each; before/after against what it was made from. */
export function PhotoMarkup({ picture, onClose }: { picture: CardPicture; onClose: () => void }) {
  const [notes, setNotes] = useState<{ box: Box; note: string }[]>([]);
  const [overall, setOverall] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [compare, setCompare] = useState(false);
  const [split, setSplit] = useState(50);
  const before = picture.from && /^asset:\d+$/.test(picture.from) ? assetUrl(Number(picture.from.slice(6)), "w=1280") : null;

  const ready = notes.some((n) => n.note.trim()) || overall.trim();

  function send() {
    const lines = notes
      .filter((n) => n.note.trim())
      .map((n, i) => `${i + 1}. Box ${boxWords(n.box)}: ${n.note.trim()}`);
    const text = [
      `Feedback on the picture asset:${picture.id} (${picture.name})${lines.length ? "; boxes are shares of its width and height from the top left" : ""}:`,
      ...lines,
      overall.trim() ? `${lines.length ? "Overall: " : ""}${overall.trim()}` : null,
      "Change these and show me the new version.",
    ]
      .filter(Boolean)
      .join("\n");
    void useSeelie.getState().say(text);
    onClose();
  }

  return (
    <Modal title="Mark up the picture" onClose={onClose} width="44rem">
      <div className="space-y-3">
        <p className="muted text-xs">Drag on the picture to box what should change, then say what for each box. Seelie gets the boxes and your notes.</p>
        {before ? (
          <div className="flex gap-1.5">
            <button type="button" className={cn("btn px-2.5 py-1 text-xs", !compare && "btn-white")} onClick={() => setCompare(false)}>
              <SquareDashed className="h-3.5 w-3.5" />
              Mark up
            </button>
            <button type="button" className={cn("btn px-2.5 py-1 text-xs", compare && "btn-white")} onClick={() => setCompare(true)}>
              <Images className="h-3.5 w-3.5" />
              Before and after
            </button>
          </div>
        ) : null}
        <div className="flex justify-center rounded-xl p-1.5" style={{ background: "var(--panel-2)" }}>
          <div className="relative inline-block max-w-full select-none">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={assetUrl(picture.id, "w=1280")} alt={picture.name} draggable={false} className="block max-h-[56vh] w-auto max-w-full rounded-lg" />
            {compare && before ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={before}
                  alt="Before"
                  draggable={false}
                  className="absolute inset-0 h-full w-full rounded-lg object-cover"
                  style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}
                />
                <span aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5" style={{ left: `${split}%`, background: "#fff", boxShadow: "0 0 0 1px rgba(0,0,0,0.2)" }} />
                <span className="pointer-events-none absolute left-2 top-2 rounded px-1.5 py-0.5 text-[11px] font-semibold text-white" style={{ background: "rgba(10,20,30,0.55)" }}>
                  Before
                </span>
                <span className="pointer-events-none absolute right-2 top-2 rounded px-1.5 py-0.5 text-[11px] font-semibold text-white" style={{ background: "rgba(10,20,30,0.55)" }}>
                  After
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={split}
                  onChange={(e) => setSplit(Number(e.target.value))}
                  aria-label="Before and after"
                  className="absolute inset-x-3 bottom-3 w-[calc(100%-1.5rem)] accent-[var(--accent)]"
                />
              </>
            ) : (
              <DrawSurface
                boxes={notes.map((n) => n.box)}
                enabled
                selected={selected}
                onSelect={setSelected}
                onAdd={(box) => {
                  setNotes((n) => [...n, { box, note: "" }]);
                  setSelected(notes.length);
                }}
              />
            )}
          </div>
        </div>
        {notes.length ? (
          <BoxNotes
            notes={notes}
            selected={selected}
            onSelect={setSelected}
            onChange={(i, note) => setNotes((n) => n.map((x, j) => (j === i ? { ...x, note } : x)))}
            onRemove={(i) => {
              setNotes((n) => n.filter((_, j) => j !== i));
              setSelected(null);
            }}
          />
        ) : null}
        <textarea
          value={overall}
          onChange={(e) => setOverall(e.target.value)}
          rows={2}
          placeholder={notes.length ? "Anything else? (optional)" : "Or just say what to change"}
          className="input resize-y text-base sm:text-sm"
        />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-blue" disabled={!ready} onClick={send}>
            Send to Seelie
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Notes on a video                                                           */
/* -------------------------------------------------------------------------- */

const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

/** Notes at moments of a video (pause, add a note), each with a box on the frame if it helps. */
export function VideoReview({ video, onClose }: { video: CardVideo; onClose: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [notes, setNotes] = useState<{ at: number; box: Box | null; note: string }[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [boxing, setBoxing] = useState(false);
  const [overall, setOverall] = useState("");

  function addNote() {
    const v = ref.current;
    if (!v) return;
    v.pause();
    const at = Math.round(v.currentTime * 10) / 10;
    setNotes((n) => [...n, { at, box: null, note: "" }].sort((a, b) => a.at - b.at));
    setSelected(null);
  }

  function seek(i: number) {
    const v = ref.current;
    const n = notes[i];
    if (!v || !n) return;
    v.pause();
    v.currentTime = n.at;
    setSelected(i);
  }

  const ready = notes.some((n) => n.note.trim()) || overall.trim();

  function send() {
    const lines = notes
      .filter((n) => n.note.trim())
      .map((n, i) => `${i + 1}. At ${clock(n.at)}${n.box ? ` (box ${boxWords(n.box)})` : ""}: ${n.note.trim()}`);
    const text = [
      `Notes on ${video.ref} ("${video.title}"); times from the start${notes.some((n) => n.box) ? ", boxes as shares of the frame from the top left" : ""}:`,
      ...lines,
      overall.trim() ? `${lines.length ? "Overall: " : ""}${overall.trim()}` : null,
      "Make these changes in a new version and show it to me.",
    ]
      .filter(Boolean)
      .join("\n");
    void useSeelie.getState().say(text);
    onClose();
  }

  const current = selected !== null ? notes[selected] : null;

  return (
    <Modal title="Notes on the video" onClose={onClose} width="44rem">
      <div className="space-y-3">
        <p className="muted text-xs">Pause where something should change and add a note there; box the part of the frame if it helps.</p>
        <div className="flex justify-center rounded-xl bg-black p-1">
          <div className="relative inline-block max-w-full">
            <video ref={ref} src={video.src} poster={video.poster} controls={!boxing} playsInline preload="metadata" className="block max-h-[52vh] w-auto max-w-full" />
            {current ? (
              <DrawSurface
                boxes={current.box ? [current.box] : []}
                enabled={boxing}
                selected={0}
                onSelect={() => {}}
                onAdd={(box) => {
                  setNotes((n) => n.map((x, j) => (j === selected ? { ...x, box } : x)));
                  setBoxing(false);
                }}
              />
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-white px-3 py-1.5 text-[13px]" onClick={addNote}>
            <MessageSquarePlus className="h-3.5 w-3.5" />
            Note here
          </button>
          {current ? (
            <button type="button" className={cn("btn px-3 py-1.5 text-[13px]", boxing ? "btn-blue" : "btn-white")} onClick={() => setBoxing((b) => !b)}>
              <SquareDashed className="h-3.5 w-3.5" />
              {boxing ? "Drag on the frame…" : current.box ? `Box again (note ${(selected ?? 0) + 1})` : `Box the frame (note ${(selected ?? 0) + 1})`}
            </button>
          ) : null}
        </div>
        {notes.length ? (
          <BoxNotes
            notes={notes}
            selected={selected}
            onSelect={seek}
            prefix={(i) => clock(notes[i].at)}
            onChange={(i, note) => setNotes((n) => n.map((x, j) => (j === i ? { ...x, note } : x)))}
            onRemove={(i) => {
              setNotes((n) => n.filter((_, j) => j !== i));
              setSelected(null);
              setBoxing(false);
            }}
          />
        ) : null}
        <textarea value={overall} onChange={(e) => setOverall(e.target.value)} rows={2} placeholder="About the whole video (optional)" className="input resize-y text-base sm:text-sm" />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-blue" disabled={!ready} onClick={send}>
            Send to Seelie
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Made in this chat                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Everything the chat has made, at its top: a tap opens a picture's mark-up or a video's
 * notes; Changes lists what the chat changed, each with Undo.
 */
export function MadeStrip({ made, changes, renderChanges }: { made: Made; changes: Change[]; renderChanges: (onClose: () => void) => React.ReactNode }) {
  const [picture, setPicture] = useState<CardPicture | null>(null);
  const [video, setVideo] = useState<CardVideo | null>(null);
  const [listing, setListing] = useState(false);
  const count = made.videos.length + made.pictures.length + made.documents.length;
  if (!count && !changes.length) return null;
  const tile = "relative h-14 w-11 shrink-0 overflow-hidden rounded-lg border";
  return (
    <div className="sl-made -mx-1 mb-2 flex items-center gap-2 overflow-x-auto px-1 pb-1">
      <span className="shrink-0 text-[10.5px] font-semibold uppercase tracking-wider" style={{ color: "var(--muted-2)" }}>
        Made here
      </span>
      {made.videos.map((v) => (
        <button key={v.src} type="button" className={tile} style={{ borderColor: "var(--border)", background: "#000" }} onClick={() => (v.ref ? setVideo(v) : window.open(v.src, "_blank"))} title={v.title}>
          {v.poster ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={v.poster} alt="" className="h-full w-full object-cover opacity-90" />
          ) : null}
          <Film className="absolute bottom-1 right-1 h-3 w-3 text-white" />
        </button>
      ))}
      {made.pictures.map((p) => (
        <button key={p.id} type="button" className={tile} style={{ borderColor: "var(--border)" }} onClick={() => setPicture(p)} title={p.name}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={assetUrl(p.id, "w=160")} alt="" className="h-full w-full object-cover" />
        </button>
      ))}
      {made.documents.map((d) => (
        <a key={d.id} href={assetUrl(d.id, "")} target="_blank" rel="noopener" className={cn(tile, "flex items-center justify-center")} style={{ borderColor: "var(--border)", background: "var(--panel)" }} title={d.name}>
          <FileText className="h-4 w-4" style={{ color: "var(--muted)" }} />
        </a>
      ))}
      {changes.length ? (
        <button type="button" className="btn btn-white shrink-0 px-2.5 py-1.5 text-xs" onClick={() => setListing(true)}>
          {changes.length} change{changes.length === 1 ? "" : "s"}
        </button>
      ) : null}
      {picture ? <PhotoMarkup picture={picture} onClose={() => setPicture(null)} /> : null}
      {video ? <VideoReview video={video} onClose={() => setVideo(null)} /> : null}
      {listing ? (
        <Modal title="Changes in this chat" onClose={() => setListing(false)} width="36rem">
          {renderChanges(() => setListing(false))}
        </Modal>
      ) : null}
    </div>
  );
}
