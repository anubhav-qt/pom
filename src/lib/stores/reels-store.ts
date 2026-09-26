"use client";

import { create } from "zustand";

import { withBasePath } from "@/lib/base-path";
import {
  MAX_PHOTOS,
  MAX_VIDEO_BYTES,
  PHOTO_LONG_EDGE,
  THUMB_LONG_EDGE,
  VIDEO_CHUNK_BYTES,
  type ReelJobView,
  type ReelKind,
  type ReelLayout,
} from "@/lib/reels/types";

export interface ReelPhoto {
  /** Upload number: the server knows the photo by this. */
  idx: number;
  name: string;
  /** Object URL of the small preview. */
  preview: string;
  state: "sending" | "ready" | "failed";
}

export interface ReelVideo {
  name: string;
  size: number;
  preview: string;
  sent: number;
  state: "sending" | "ready" | "failed";
}

export type Song = { id: number; title: string; artist: string };

/** What a finished render was made from, so the screen knows when a remake is due. */
interface Made {
  layout: ReelLayout;
  photos: string;
  useAi: boolean;
}

interface ReelsState {
  kind: ReelKind | null;
  jobId: number | null;
  photos: ReelPhoto[];
  video: ReelVideo | null;
  layout: ReelLayout;
  useAi: boolean;
  /** The song for the next render: a library id, or "auto" for the best match (a remake keeps its song). */
  song: number | "auto";
  /** The person's own keep/drop taps, by upload number, over Gemini's picks. */
  keep: Record<number, boolean>;
  view: ReelJobView | null;
  library: Song[];
  /** Pressed Make and waiting for uploads or the server. */
  busy: boolean;
  /** A problem outside the job itself (an upload, the network). */
  notice: string | null;
  made: Made | null;
  /** A download or share in flight. */
  saving: "music" | "silent" | "share" | null;

  add: (files: File[]) => void;
  removePhoto: (idx: number) => void;
  toggleKeep: (idx: number) => void;
  setLayout: (layout: ReelLayout) => void;
  setUseAi: (useAi: boolean) => void;
  setSong: (song: number | "auto") => void;
  make: (opts?: { track?: number | "next"; useAi?: boolean }) => Promise<void>;
  loadLibrary: () => Promise<void>;
  save: (what: "music" | "silent" | "share") => Promise<void>;
  reset: () => void;
}

const isImage = (f: File) => f.type.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name);
const isVideo = (f: File) => f.type.startsWith("video/") || /\.(mp4|mov|m4v|webm|3gp)$/i.test(f.name);

/* -------------------------------------------------------------------------- */
/* Network                                                                    */
/* -------------------------------------------------------------------------- */

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withBasePath(path), init);
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.error ?? `The server said ${res.status}.`);
  return json as T;
}

/** One photo, resized in the browser: the full picture and a small preview, both JPEG. */
async function resize(file: File): Promise<{ photo: Blob; thumb: Blob }> {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const encode = (long: number, quality: number) => {
    const s = Math.min(1, long / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bmp.width * s));
    canvas.height = Math.max(1, Math.round(bmp.height * s));
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return new Promise<Blob>((ok, fail) =>
      canvas.toBlob((b) => (b ? ok(b) : fail(new Error("Could not read that photo."))), "image/jpeg", quality),
    );
  };
  try {
    let photo = await encode(PHOTO_LONG_EDGE, 0.88);
    // Under the server's 4.4 MB per request, with room to spare.
    if (photo.size > 4 * 1024 * 1024) photo = await encode(PHOTO_LONG_EDGE, 0.72);
    return { photo, thumb: await encode(THUMB_LONG_EDGE, 0.72) };
  } finally {
    bmp.close();
  }
}

const put = (jobId: number, kind: string, idx: number, name: string, body: Blob) =>
  api(`/api/reels/${jobId}/files?kind=${kind}&idx=${idx}&name=${encodeURIComponent(name)}`, { method: "PUT", body });

/** The finished MP4, fetched in the slices the server hands out. */
async function fetchReel(jobId: number, version: number, silent: boolean): Promise<Blob> {
  const parts: Blob[] = [];
  let start = 0;
  let size = Infinity;
  while (start < size) {
    const res = await fetch(withBasePath(`/api/reels/${jobId}/video?v=${version}${silent ? "&silent=1" : ""}`), {
      headers: { range: `bytes=${start}-` },
    });
    if (!res.ok) throw new Error("Could not download the reel.");
    const blob = await res.blob();
    const range = /\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
    size = range ? Number(range[1]) : blob.size;
    parts.push(blob);
    start += blob.size;
    if (blob.size === 0) break;
  }
  return new Blob(parts, { type: "video/mp4" });
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

// Work in flight lives outside the state: it is not something to render.
let creating: Promise<number> | null = null;
let uploads: Promise<unknown> = Promise.resolve();
let active = 0;
const waiting: (() => void)[] = [];
let nextIdx = 0;
let polling = false;
let generation = 0;

/** At most three uploads at a time; the rest queue. */
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (active >= 3) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await work();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

const photosKey = (photos: ReelPhoto[]) => photos.map((p) => p.idx).join(",");

/** The keep list to send: only when the person changed Gemini's picks, and only for photos it has seen. */
function keepList(s: Pick<ReelsState, "photos" | "keep" | "view">): number[] | undefined {
  const picks = s.view?.picks;
  if (!picks || Object.keys(s.keep).length === 0) return undefined;
  const byIdx = new Map(picks.map((p) => [p.index, p.keep]));
  if (s.photos.some((p) => !byIdx.has(p.idx))) return undefined;
  return s.photos.filter((p) => s.keep[p.idx] ?? byIdx.get(p.idx) ?? true).map((p) => p.idx);
}

const fresh = () => ({
  kind: null,
  jobId: null,
  photos: [],
  video: null,
  keep: {},
  view: null,
  busy: false,
  notice: null,
  made: null,
  saving: null,
});

/**
 * The Reels screen's working state, kept outside the component like the PDF
 * printer's: switching screens and back finds the photos, the render in
 * progress and the finished reel where they were. Uploads start the moment
 * files are picked, so by the time "Make reel" is pressed they are usually
 * already on the server.
 */
export const useReelsStore = create<ReelsState>((set, get) => {
  /** The job for this batch, made on first use. A new kind of upload starts over. */
  function job(kind: ReelKind): Promise<number> {
    const id = get().jobId;
    if (id !== null) return Promise.resolve(id);
    if (!creating) {
      const gen = generation;
      creating = api<{ id: number }>("/api/reels", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind }),
      })
        .then(({ id }) => {
          if (gen === generation) set({ jobId: id });
          return id;
        })
        .finally(() => {
          creating = null;
        });
    }
    return creating;
  }

  async function poll(id: number) {
    if (polling) return;
    polling = true;
    const gen = generation;
    try {
      for (;;) {
        await new Promise((r) => setTimeout(r, 1200));
        if (gen !== generation) return;
        let view: ReelJobView;
        try {
          view = await api<ReelJobView>(`/api/reels/${id}`, { cache: "no-store" });
        } catch {
          continue; // A blip: ask again.
        }
        if (gen !== generation) return;
        set({ view, library: view.library });
        if (view.status === "done" || view.status === "error") {
          set({ busy: false });
          return;
        }
      }
    } finally {
      polling = false;
    }
  }

  function addPhotos(list: File[]) {
    const room = MAX_PHOTOS - get().photos.length;
    const take = list.slice(0, Math.max(0, room));
    const gen = generation;
    for (const file of take) {
      const idx = nextIdx++;
      const photo: ReelPhoto = { idx, name: file.name, preview: "", state: "sending" };
      set((s) => ({ photos: [...s.photos, photo] }));
      const mark = (patch: Partial<ReelPhoto>) =>
        gen === generation && set((s) => ({ photos: s.photos.map((p) => (p.idx === idx ? { ...p, ...patch } : p)) }));
      const done = slot(async () => {
        if (gen !== generation) return;
        const { photo: full, thumb } = await resize(file);
        mark({ preview: URL.createObjectURL(thumb) });
        const id = await job("photos");
        await put(id, "thumb", idx, file.name, thumb);
        await put(id, "photo", idx, file.name, full);
        mark({ state: "ready" });
      }).catch((e) => {
        mark({ state: "failed" });
        if (gen === generation) set({ notice: `${file.name}: ${e instanceof Error ? e.message : "could not upload."}` });
      });
      uploads = Promise.all([uploads, done]);
    }
    if (take.length < list.length) set({ notice: `A reel takes up to ${MAX_PHOTOS} photos; the rest were left out.` });
  }

  function addVideo(file: File) {
    if (file.size > MAX_VIDEO_BYTES) {
      set({ notice: "That video is over 120 MB. Trim it or send a smaller copy." });
      return;
    }
    const gen = generation;
    set({ video: { name: file.name, size: file.size, preview: URL.createObjectURL(file), sent: 0, state: "sending" } });
    const mark = (patch: Partial<ReelVideo>) =>
      gen === generation && set((s) => ({ video: s.video ? { ...s.video, ...patch } : null }));
    uploads = (async () => {
      try {
        const id = await job("video");
        for (let i = 0, off = 0; off < file.size; i++, off += VIDEO_CHUNK_BYTES) {
          if (gen !== generation) return;
          await put(id, "video", i, file.name, file.slice(off, off + VIDEO_CHUNK_BYTES));
          mark({ sent: Math.min(file.size, off + VIDEO_CHUNK_BYTES) });
        }
        mark({ state: "ready" });
      } catch (e) {
        mark({ state: "failed" });
        if (gen === generation) set({ notice: `The video did not upload: ${e instanceof Error ? e.message : "try again."}` });
      }
    })();
  }

  return {
    ...fresh(),
    layout: "portrait",
    useAi: true,
    song: "auto",
    library: [],

    add: (list) => {
      const videos = list.filter(isVideo);
      const images = list.filter(isImage);
      const skipped = list.length - videos.length - images.length;
      const s = get();

      if (videos.length > 0) {
        // One video makes one reel: it replaces whatever was here.
        get().reset();
        set({ kind: "video" });
        addVideo(videos[0]);
        if (videos.length > 1 || images.length > 0) set({ notice: "A reel is made from one video. The first one was used." });
        return;
      }
      if (images.length === 0) {
        if (skipped) set({ notice: "Those are not photos or a video." });
        return;
      }
      if (s.kind === "video" || s.busy) {
        if (s.busy) return;
        get().reset();
      }
      set({ kind: "photos", notice: skipped ? `${skipped} file${skipped === 1 ? " was" : "s were"} not a photo and left out.` : null });
      addPhotos(images);
    },

    removePhoto: (idx) => {
      const { jobId, busy } = get();
      if (busy) return;
      set((s) => {
        const gone = s.photos.find((p) => p.idx === idx);
        if (gone?.preview) URL.revokeObjectURL(gone.preview);
        const photos = s.photos.filter((p) => p.idx !== idx);
        return photos.length === 0 ? { ...fresh(), layout: s.layout, useAi: s.useAi } : { photos };
      });
      if (get().photos.length === 0) {
        generation++;
        return;
      }
      // After the uploads in flight, so a photo still uploading is not put back.
      if (jobId !== null) {
        uploads = uploads.then(() => api(`/api/reels/${jobId}/files?idx=${idx}`, { method: "DELETE" }).catch(() => {}));
      }
    },

    toggleKeep: (idx) => {
      const s = get();
      if (s.busy) return;
      const pick = s.view?.picks?.find((p) => p.index === idx);
      const now = s.keep[idx] ?? pick?.keep ?? true;
      set({ keep: { ...s.keep, [idx]: !now } });
    },

    setLayout: (layout) => set({ layout }),
    setUseAi: (useAi) => set({ useAi }),
    setSong: (song) => set({ song }),

    make: async (opts = {}) => {
      if (get().busy) return;
      set({ busy: true, notice: null });
      const gen = generation;
      try {
        await uploads;
        if (gen !== generation) return;
        const s = get();
        if (s.kind === "photos" && !s.photos.some((p) => p.state === "ready")) throw new Error("None of the photos uploaded.");
        if (s.kind === "video" && s.video?.state !== "ready") throw new Error("The video did not upload.");
        const id = s.jobId;
        if (id === null) throw new Error("Add photos or a video first.");

        const useAi = opts.useAi ?? s.useAi;
        // Gemini switched off after it picked: every photo, still in its order.
        // Switched back on: let it pick afresh.
        const keep = !useAi && s.view?.picks ? s.photos.map((p) => p.idx) : keepList(s);
        const repick = useAi && s.made?.useAi === false;
        await api(`/api/reels/${id}/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            useAi,
            keep: repick ? undefined : keep,
            repick,
            track: opts.track ?? (s.song === "auto" ? undefined : s.song),
            layout: s.layout,
          }),
        });
        if (gen !== generation) return;
        set({
          view: s.view ? { ...s.view, status: "queued", progress: 0, error: null } : s.view,
          made: { layout: s.layout, photos: photosKey(s.photos), useAi },
          useAi,
        });
        await poll(id);
        // The finished picks now carry the person's taps; "Different song" leaves the picker on its best match.
        if (gen === generation && get().view?.status === "done") set({ keep: {}, ...(opts.track === "next" ? { song: "auto" } : {}) });
      } catch (e) {
        if (gen === generation) set({ busy: false, notice: e instanceof Error ? e.message : "Could not make the reel." });
      }
    },

    loadLibrary: async () => {
      try {
        const { library } = await api<{ library: Song[] }>("/api/reels", { cache: "no-store" });
        set({ library });
      } catch {
        // The picker just stays on "Best match".
      }
    },

    save: async (what) => {
      const { jobId, view, saving } = get();
      if (jobId === null || !view || view.status !== "done" || saving) return;
      set({ saving: what });
      try {
        const silent = what === "silent";
        const blob = await fetchReel(jobId, view.version, silent);
        const name = `paribelle-reel-${jobId}${silent ? "-no-music" : ""}.mp4`;
        if (what === "share") {
          const file = new File([blob], name, { type: "video/mp4" });
          if (navigator.canShare?.({ files: [file] })) {
            await navigator.share({ files: [file] }).catch(() => {});
            return;
          }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch (e) {
        set({ notice: e instanceof Error ? e.message : "Could not download the reel." });
      } finally {
        set({ saving: null });
      }
    },

    reset: () => {
      generation++;
      const s = get();
      for (const p of s.photos) if (p.preview) URL.revokeObjectURL(p.preview);
      if (s.video?.preview) URL.revokeObjectURL(s.video.preview);
      uploads = Promise.resolve();
      creating = null;
      set(fresh());
    },
  };
});

/** Whether what is on screen differs from what the finished reel was made from. */
export function needsRemake(s: Pick<ReelsState, "made" | "layout" | "photos" | "keep" | "view" | "useAi" | "song">): boolean {
  if (!s.made || s.view?.status !== "done") return false;
  if (s.made.layout !== s.layout || s.made.useAi !== s.useAi) return true;
  if (s.song !== "auto" && s.song !== s.view.song?.id) return true;
  if (s.made.photos !== photosKey(s.photos)) return true;
  // The server's picks are what the reel was made from, taps included.
  return (s.view.picks ?? []).some((p) => (s.keep[p.index] ?? p.keep) !== p.keep);
}

/** Whether a photo is in the reel: the person's tap, else Gemini's pick, else yes. */
export function isKept(s: Pick<ReelsState, "keep" | "view">, idx: number): boolean {
  return s.keep[idx] ?? s.view?.picks?.find((p) => p.index === idx)?.keep ?? true;
}
