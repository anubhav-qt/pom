import "server-only";

import { readdir, readFile } from "node:fs/promises";

import { Type, type ImageContent, type VideoContent } from "@paribelle/pi-ai";
import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { reelTracks, seelieAssets, seelieChats } from "@/db/schema";
import type { TrackAnalysis } from "@/lib/reels/beats";

import { heroMoments, postChecks, renderComposition, sketchComposition, songMap } from "../media/compose";
import { findingLines, MAX_SECONDS, storyboardLines, TRANSITIONS, validate, videoBeats, type Composition, type Scene } from "../media/composition";
import { assetSummary, extOf, kindOfMime, mediaFolder, MediaError, saveAsset, videoFile } from "../media/files";
import { addGoogleFont, fontFaces } from "../media/fonts";
import { GraphError } from "../media/graph";
import {
  addVersion,
  checkSongs,
  createVideo,
  deleteVideo,
  getVideo,
  listVideos,
  songsFor,
  updateVideo,
  versionOf,
  versionsOf,
  videoSummary,
  type VideoRow,
  type VideoVersion,
} from "../media/library";
import { REF_PATTERN, resolveRef } from "../media/refs";
import { stillsAt } from "../media/render";
import { describeJob, renderQueue, stopRender } from "../media/renderer";
import { contactSheet } from "../media/sheet";
import { PALETTE, templateDocs } from "../media/templates";
import { WATCH_MAX_SECONDS, WATCH_REF, watchBlock } from "../media/watch";
import { fetchPublic, toJpeg } from "./images";
import { defineTool, ToolError, type ToolContext } from "./types";
import { optional, plural, StringEnum } from "./util";

/** Media errors are the model's to fix: they reach it as a tool error, not a crash. */
async function media<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MediaError) throw new ToolError(err.message);
    if (err instanceof GraphError) throw new ToolError(`The graph: ${err.message}`);
    throw err;
  }
}

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

const jpegBlock = (bytes: Buffer): ImageContent => ({ type: "image", data: bytes.toString("base64"), mimeType: "image/jpeg" });

/** Evenly spread moments to look at in `seconds` of video. */
const spread = (from: number, seconds: number, n: number) => Array.from({ length: n }, (_, i) => round(from + ((i + 0.5) * seconds) / n, 2));

/* -------------------------------------------------------------------------- */
/* video_assets                                                               */
/* -------------------------------------------------------------------------- */

function songInfo(row: { id: number; title: string; artist: string; language: string; tags: string[]; bpm: number; duration: number; analysis: unknown; usedAt: Date | null }) {
  const a = row.analysis as TrackAnalysis;
  const at = (i: number) => round(a.beats[i] ?? 0);
  return {
    ref: `song:${row.id}`,
    title: row.title,
    artist: row.artist,
    language: row.language,
    tags: row.tags,
    bpm: round(row.bpm, 1),
    seconds: round(row.duration, 1),
    hook: a.hook === null ? null : round(a.hook),
    beats: a.beats.map((b) => round(b)),
    bars: a.beats.map((_, i) => i).filter((i) => i >= a.downbeat && (i - a.downbeat) % 4 === 0).map(at),
    phrases: a.phrases.map(at),
    lifts: a.lifts.map(at),
    used: row.usedAt !== null,
  };
}

/** A file type from a URL's extension, for servers that don't say. */
const TYPE_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  ass: "text/x-ssa",
  srt: "application/x-subrip",
};

async function importUrl(raw: string, ctx: ToolContext) {
  const { bytes, type, url } = await fetchPublic(raw, ctx.signal, { maxBytes: 150 * 1024 * 1024, timeoutMs: 180_000 });
  const fileName = decodeURIComponent(new URL(url).pathname.split("/").pop() || "download");
  const byExt = TYPE_BY_EXT[fileName.split(".").pop()?.toLowerCase() ?? ""];
  const mime = kindOfMime(type) && extOf(type) ? type : byExt;
  if (!mime) throw new ToolError(`${raw.slice(0, 120)} isn't an image, clip or sound (${type || "unknown type"}). A web page isn't media: for YouTube use the youtube tool.`);
  const row = await saveAsset({ bytes, mime, name: fileName.slice(0, 120), source: "url", chatId: ctx.chatId, userId: ctx.user.id, meta: { url } });
  return assetSummary(row);
}

export const videoAssets = defineTool({
  name: "video_assets",
  label: "Media",
  description: [
    "What the video tools can use, by ref: chat:<n> (images attached in this chat, oldest first), asset:<id> (clips, images, sounds, subtitles in Seelie's media),",
    "song:<id> (library songs, ~70 s around the hook, with their beat map), video:<id>[@<version>] (library videos), brand:endcard (PariBelle's 1080x1920 end card).",
    "list: this chat's media (scope 'all' for everything). info: details of refs; images are shown to you; songs give bpm, beats, bars, phrases, lifts and hook in seconds.",
    "songs: library songs still free (each song makes one reel or video; pass videoId to include the one it holds).",
    `import: save images, clips (up to ${MAX_SECONDS * 4} s is fine) or sounds from public https URLs as assets. fonts: the font families a composition may use (CSS font-family), their files ($font/<file> for photo_edit and pdf_edit) and looks ($lut/<file>).`,
    "add_font: download a Google font by family (weights, default 400 and 700; subset e.g. devanagari for Hindi text, as one file per subset; italic).",
    "templates: PariBelle's scene templates with their params, and the brand's palette and fonts.",
    "save_frame: keep a still from a clip or video (ref, at seconds) as an image asset, e.g. to cut out or restyle.",
    "Product photos from the catalogue or paribelle.in: import their https URLs first.",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["list", "info", "songs", "import", "fonts", "add_font", "save_frame", "templates"]),
    scope: optional(StringEnum(["chat", "all"])),
    refs: optional(Type.Array(Type.String(), { maxItems: 12 })),
    videoId: optional(Type.Integer()),
    urls: optional(Type.Array(Type.String(), { maxItems: 8 })),
    family: optional(Type.String()),
    weights: optional(Type.Array(Type.Integer({ minimum: 100, maximum: 900 }), { maxItems: 6 })),
    subset: optional(Type.String()),
    italic: optional(Type.Boolean()),
    ref: optional(Type.String()),
    at: optional(Type.Number({ minimum: 0 })),
  }),
  kind: "read",
  summary: (a) =>
    a.action === "import"
      ? `Import ${plural(a.urls?.length ?? 0, "file")}`
      : a.action === "add_font"
        ? `Add font ${a.family ?? ""}`
        : a.action === "info"
          ? `About ${a.refs?.join(", ") ?? ""}`
          : a.action === "save_frame"
            ? `Still from ${a.ref} at ${a.at ?? 0} s`
            : a.action === "songs"
              ? "Songs left"
              : a.action === "fonts"
                ? "Fonts and looks"
                : a.action === "templates"
                  ? "Video templates"
                  : "Media in this chat",
  async execute(a, ctx) {
    return media(async () => {
      switch (a.action) {
        case "list": {
          const all = a.scope === "all";
          const images = await ctx.chatImages();
          const assets = await db
            .select()
            .from(seelieAssets)
            .where(all ? undefined : eq(seelieAssets.chatId, ctx.chatId))
            .orderBy(desc(seelieAssets.id))
            .limit(all ? 100 : 60);
          const videos = await listVideos({ limit: 20, chatId: all ? undefined : ctx.chatId });
          return {
            data: {
              chatImages: images.length ? `chat:1 … chat:${images.length}` : "none",
              assets: assets.map(assetSummary),
              videos: videos.map((v) => ({ ref: `video:${v.id}`, title: v.title, version: v.version, ...(v.version ? { seconds: versionOf(v).seconds } : {}) })),
              brand: ["brand:endcard"],
            },
          };
        }

        case "info": {
          if (!a.refs?.length) throw new ToolError("Which refs?");
          const out: unknown[] = [];
          const images: ImageContent[] = [];
          const cache = await mediaFolder("cache");
          for (const raw of a.refs) {
            const ref = raw.trim();
            if (!REF_PATTERN.test(ref)) {
              out.push({ ref, error: "not a ref" });
              continue;
            }
            const [kind, rest] = ref.split(":");
            if (kind === "song") {
              const [row] = await db.select().from(reelTracks).where(eq(reelTracks.id, Number(rest))).limit(1);
              out.push(row ? songInfo(row) : { ref, error: "no such song" });
              continue;
            }
            if (kind === "video") {
              const [id, v] = rest.split("@").map(Number);
              const video = await getVideo(id);
              if (!video) {
                out.push({ ref, error: "no such video" });
                continue;
              }
              out.push({
                ...videoSummary(video, video.version ? (v ?? video.version) : undefined),
                prompt: video.prompt,
                versions: versionsOf(video).map((x) => ({ version: x.version, quality: x.quality, seconds: x.seconds, ...(x.pruned ? { pruned: true } : {}), at: x.renderedAt })),
              });
              continue;
            }
            const m = await resolveRef(ref, { chatImages: ctx.chatImages, workDir: cache });
            const asset = kind === "asset" ? (await db.select().from(seelieAssets).where(eq(seelieAssets.id, Number(rest))).limit(1))[0] : null;
            out.push({
              ...(asset ? assetSummary(asset) : { ref, kind: m.kind, name: m.name }),
              ...(m.width ? { size: `${m.width}x${m.height}` } : {}),
              ...(asset?.meta ? { from: asset.meta } : {}),
            });
            if (m.kind === "image" && images.length < 6) images.push(jpegBlock(await toJpeg(await readFile(m.file), 768)));
          }
          return { data: out, images };
        }

        case "songs": {
          const video = a.videoId ? await getVideo(a.videoId) : null;
          const songs = await songsFor(video);
          return {
            text: songs.length ? "video_assets info on a song gives its beat map." : "No songs are left in the library. The songs tool can find and add new ones.",
            data: songs.map((s) => ({ ref: `song:${s.id}`, title: s.title, artist: s.artist, language: s.language, tags: s.tags, bpm: round(s.bpm, 1), seconds: round(s.seconds, 1) })),
          };
        }

        case "import": {
          if (!a.urls?.length) throw new ToolError("Which URLs?");
          const out: unknown[] = [];
          for (const [i, url] of a.urls.entries()) {
            ctx.progress(`Fetching ${i + 1} of ${a.urls.length}…`);
            out.push(await importUrl(url, ctx).catch((err: unknown) => ({ url, error: err instanceof Error ? err.message : String(err) })));
          }
          return { data: out };
        }

        case "fonts": {
          const faces = await fontFaces();
          const luts = await readdir(await mediaFolder("luts"));
          const families = new Map<string, string[]>();
          for (const f of faces) families.set(f.family, [...(families.get(f.family) ?? []), `${f.weight}${f.style === "italic" ? " italic" : ""}`]);
          return {
            data: {
              families: Object.fromEntries(families),
              files: faces.map((f) => `$font/${f.file}`),
              looks: luts.map((f) => `$lut/${f}`),
            },
            text: faces.length ? undefined : "No fonts yet (the brand's are fetched with the first storyboard): add_font adds Google fonts.",
          };
        }

        case "templates":
          return {
            text: [
              "Scenes fill these in (video_plan scenes[].template + params). A reel opens with hook (the product and the hook words from the first frame). Every template keeps text inside the reel's safe area, puts words over photos on solid boxes and moves on its own; add your own html/css/script to a scene for anything more.",
              "The brand: headlines in var(--font-display) (Cormorant Garamond), text in var(--font-text) (Jost), the wordmark in var(--font-logo) (Italiana). Colours as var(--name):",
              Object.keys(PALETTE).join(", "),
              "In a scene's own CSS: sizes as calc(var(--u) * N) on a 1080-wide grid; the safe area is var(--safe-top), var(--safe-bottom), var(--safe-x).",
            ].join("\n"),
            data: templateDocs(),
          };

        case "add_font": {
          if (!a.family) throw new ToolError("Which font family?");
          return { data: await addGoogleFont(a.family, a.weights, a.subset, a.italic === true, ctx.signal) };
        }

        case "save_frame": {
          if (!a.ref) throw new ToolError("From which clip or video (ref)?");
          const m = await resolveRef(a.ref, { chatImages: ctx.chatImages, workDir: await mediaFolder("cache") });
          if (m.kind !== "video") throw new ToolError(`${a.ref} isn't a clip or video.`);
          const [still] = await stillsAt(m.file, [a.at ?? 0], 1920);
          const row = await saveAsset({ bytes: still, mime: "image/jpeg", name: `${m.name} at ${a.at ?? 0}s`, source: "frame", chatId: ctx.chatId, userId: ctx.user.id, meta: { from: a.ref, at: a.at ?? 0 } });
          return { data: assetSummary(row), images: [jpegBlock(await toJpeg(still, 768))] };
        }
      }
    });
  },
});

/* -------------------------------------------------------------------------- */
/* video_watch                                                                */
/* -------------------------------------------------------------------------- */

/** video:<id> as its latest version, so the transcript keeps naming the same file. */
async function pinned(ref: string) {
  const m = /^video:(\d+)(#.*)?$/.exec(ref.trim());
  if (!m) return ref.trim();
  const video = await getVideo(Number(m[1]));
  if (!video?.version) throw new MediaError(`There's no rendered video:${m[1]}.`);
  return `video:${m[1]}@${video.version}${m[2] ?? ""}`;
}

async function stillsOf(ref: string, times: number[] | undefined, ctx: ToolContext): Promise<{ images: ImageContent[]; at: number[] }> {
  const [base, range] = ref.split("#");
  const m = await resolveRef(base, { chatImages: ctx.chatImages, workDir: await mediaFolder("cache") });
  if (m.kind === "image") return { images: [jpegBlock(await toJpeg(await readFile(m.file), 1024))], at: [] };
  if (m.kind !== "video") throw new MediaError(`${base} has no picture to look at${m.kind === "audio" ? " (it's a sound)" : ""}.`);
  const [from, to] = range ? range.split("-").map(Number) : [0, m.duration ?? 1];
  const at = times?.length ? times : spread(from, Math.max(0.1, to - from), 6);
  return { images: (await stillsAt(m.file, at, 768)).map(jpegBlock), at };
}

export const videoWatch = defineTool({
  name: "video_watch",
  label: "Watch",
  description: [
    `Watch and listen to clips, sounds, songs and library videos (refs; append #<from>-<to> in seconds for a stretch; up to ${WATCH_MAX_SECONDS} s each, 3 at a time).`,
    "You get the clip itself, with its sound: judge pacing, cuts, text legibility, colour and how the music sits. The latest 3 clips you watched stay with you on later turns.",
    "times: instead, stills at those seconds (sharper than the clip for small text and detail). Images (chat:<n>, image assets) are shown as they are.",
    "Only you see what you watch: to show the owner a library video, use video_library show.",
  ].join(" "),
  parameters: Type.Object({
    refs: Type.Array(Type.String(), { minItems: 1, maxItems: 3 }),
    times: optional(Type.Array(Type.Number({ minimum: 0 }), { maxItems: 12 })),
  }),
  kind: "read",
  summary: (a) => `${a.times?.length ? "Stills from" : "Watch"} ${a.refs.join(", ")}`,
  async execute(a, ctx) {
    return media(async () => {
      const videos: VideoContent[] = [];
      const images: ImageContent[] = [];
      const notes: string[] = [];
      for (const raw of a.refs) {
        const ref = await pinned(raw);
        const base = ref.split("#")[0];
        const still = a.times?.length || !ctx.canWatch || base.startsWith("chat:") || base === "brand:endcard" || !WATCH_REF.test(ref);
        if (still) {
          const s = await stillsOf(ref, a.times, ctx);
          images.push(...s.images);
          notes.push(s.at.length ? `${ref}: stills at ${s.at.join(", ")} s` : `${ref}: shown`);
        } else {
          videos.push(await watchBlock(ref));
          notes.push(`${ref}: attached`);
        }
      }
      if (videos.length) notes.push("(Only you see these. To show the owner one, use video_library show.)");
      return { text: notes.join("\n"), videos, images };
    });
  },
});

/* -------------------------------------------------------------------------- */
/* video_plan and video_render                                                */
/* -------------------------------------------------------------------------- */

const SceneSchema = Type.Object({
  id: Type.String({ description: "Short and unique: hook, hero, price (lowercase letters, digits, dashes)." }),
  start: optional(Type.Number({ minimum: 0, description: "Seconds into the video." })),
  duration: optional(Type.Number({ minimum: 0.1 })),
  intent: optional(Type.String({ maxLength: 300, description: "What the scene does, with a motion verb for each element (\"the kurta SLAMS in on the drop, the price DRIFTS up\")." })),
  template: optional(Type.String({ description: "A PariBelle template (video_assets templates lists them and their params)." })),
  params: optional(Type.Record(Type.String(), Type.Unknown(), { description: "The template's params." })),
  html: optional(Type.String({ maxLength: 40_000, description: "Your own scene, or more on top of a template. Media as src=\"asset:12\" / url(chat:2)." })),
  css: optional(Type.String({ maxLength: 40_000, description: "CSS for this scene only (nested under it): .title { … }." })),
  script: optional(Type.String({ maxLength: 40_000, description: "GSAP on `tl` in the scene's own seconds (0 = its start): tl.from(q(\".title\"), { y: 80 * U, opacity: 0, duration: 0.8, ease: \"expo.out\" }, 0.3). Also D, W, H, U, K, beats, bars, root." })),
  enter: optional(StringEnum([...TRANSITIONS], { description: "How it comes in (default cut)." })),
  hero: optional(Type.Number({ minimum: 0, description: "Its best moment in its own seconds, for sketches and the contact sheet (default 60% in)." })),
});

const LayerSchema = Type.Object({
  id: Type.String(),
  start: Type.Number({ minimum: 0 }),
  duration: Type.Number({ minimum: 0.1 }),
  html: Type.String({ maxLength: 20_000 }),
  css: optional(Type.String({ maxLength: 20_000 })),
  script: optional(Type.String({ maxLength: 20_000 })),
});

const SongSchema = Type.Object({
  ref: Type.String({ description: "song:<id>" }),
  from: optional(Type.Number({ minimum: 0, description: "Second of the song (its beat map's time) the video starts at." })),
  volume: optional(Type.Number({ minimum: 0, maximum: 3.98 })),
  fadeIn: optional(Type.Number({ minimum: 0 })),
  fadeOut: optional(Type.Number({ minimum: 0 })),
});

const SoundSchema = Type.Object({
  ref: Type.String({ description: "An audio asset (asset:<id>)." }),
  at: Type.Number({ minimum: 0 }),
  from: optional(Type.Number({ minimum: 0 })),
  duration: optional(Type.Number({ minimum: 0.1 })),
  volume: optional(Type.Number({ minimum: 0, maximum: 3.98 })),
  fadeIn: optional(Type.Number({ minimum: 0 })),
  fadeOut: optional(Type.Number({ minimum: 0 })),
});

const SetSchema = Type.Object({
  width: optional(Type.Integer()),
  height: optional(Type.Integer()),
  fps: optional(Type.Integer()),
  duration: optional(Type.Number({ description: `Seconds, up to ${MAX_SECONDS}.` })),
  song: optional(SongSchema),
  noSong: optional(Type.Boolean({ description: "Take the song out." })),
  sounds: optional(Type.Array(SoundSchema, { maxItems: 8 })),
  css: optional(Type.String({ maxLength: 20_000, description: "CSS every scene shares." })),
  overlays: optional(Type.Array(LayerSchema, { maxItems: 6, description: "Layers over the scenes for a stretch (a running caption, a logo)." })),
});

const EMPTY: Composition = { width: 1080, height: 1920, fps: 30, duration: 0, scenes: [] };

/** A composition with `a`'s changes: a whole one, then settings, then scenes added, changed or removed by id. */
function applyPlan(base: Composition, a: { composition?: Composition; set?: Partial<Composition> & { noSong?: boolean }; scenes?: Partial<Scene>[]; remove?: string[] }): Composition {
  let c: Composition = structuredClone(a.composition ?? base);
  if (a.set) {
    const { noSong, ...rest } = a.set;
    c = { ...c, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
    if (noSong) delete c.song;
  }
  for (const s of a.scenes ?? []) {
    const i = c.scenes.findIndex((x) => x.id === s.id);
    if (i >= 0) c.scenes[i] = { ...c.scenes[i], ...Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) } as Scene;
    else c.scenes.push(s as Scene);
  }
  if (a.remove?.length) c.scenes = c.scenes.filter((s) => !a.remove!.includes(s.id));
  c.scenes.sort((x, y) => (x.start ?? 0) - (y.start ?? 0));
  return c;
}

/** The composition a version was made from ("video:12" or "video:12@3"). */
async function recipeOf(ref: string): Promise<Composition> {
  const m = /^video:(\d+)(?:@(\d+))?$/.exec(ref.trim());
  if (!m) throw new ToolError(`from is a library video (video:<id> or video:<id>@<version>).`);
  const video = await getVideo(Number(m[1]));
  if (!video) throw new ToolError(`There's no video:${m[1]}.`);
  const c = m[2] ? versionOf(video, Number(m[2])).composition : video.version ? versionOf(video).composition : (video.composition as Composition | null);
  if (!c) throw new ToolError(`video:${m[1]}${m[2] ? `@${m[2]}` : ""} was made with the old ffmpeg renderer and has no composition to start from.`);
  return c;
}

const jobFor = (ctx: ToolContext, video: { id: number; title: string }, what: string) => ({ chatId: ctx.chatId, runId: ctx.runId, videoId: video.id, what: `${what} of video:${video.id} "${video.title}"` });

/** What to look for on a contact sheet before going on: what the owner would otherwise have to point out. */
const REVIEW_SHEET = [
  "The contact sheet (each scene at its best moment) is in this card. Go through it as someone scrolling Reels would, and fix what fails with video_plan before rendering:",
  "1) the first frame shows the product and the hook words, and the first two seconds show what the hook promises; 2) no words over a face; 3) every word is big enough to read on a phone and stays up long enough to read twice;",
  "4) each label matches the photo under it (the colour, the view); 5) every claim (fabric, work, origin, price, offer, delivery, numbers) is in the product's data from this chat, word for word in meaning;",
  "6) the product fills the frame in most scenes and no two scenes look alike. Then render a draft.",
].join(" ");

export const videoPlan = defineTool({
  name: "video_plan",
  label: "Storyboard",
  description: [
    "Write or change a video's storyboard: its composition of timed scenes, each a PariBelle template filled in (video_assets templates) or your own HTML/CSS/GSAP, or both, plus the song, sounds and overlays. Saved on the video (a new one when videoId is left out: give a title and the prompt).",
    "composition: the whole thing (first time, or to start over); from: start from a library video's composition (\"make another like video:12\"); set: canvas, fps, duration, song, sounds, css, overlays; scenes: add scenes or change them by id (only the fields you give); remove: scene ids.",
    `Scenes follow each other with no gaps and the last ends at duration (up to ${MAX_SECONDS} s); a scene's enter transition overlaps the one before for you. Times inside a scene are its own (0 = its start).`,
    "It checks the plan (timing, the song's beats, params), then the renderer checks the layout (text overflow, hidden or clipped text, the reel's covered bands, contrast, motion) and takes a still of every scene at its best moment: a contact sheet the owner sees in this card.",
    "Once the checks are clean and the contact sheet looks right, render a draft straight away (video_render); the owner judges the draft, not the plan.",
  ].join(" "),
  parameters: Type.Object({
    videoId: optional(Type.Integer()),
    title: optional(Type.String({ maxLength: 200 })),
    prompt: optional(Type.String({ maxLength: 4000, description: "A new video: what was asked for, in the person's words." })),
    from: optional(Type.String({ description: "video:<id>[@<version>] to start from." })),
    composition: optional(
      Type.Object({
        width: Type.Integer({ description: "1080 for reels" }),
        height: Type.Integer({ description: "1920 for reels" }),
        fps: Type.Integer({ description: "30" }),
        duration: Type.Number(),
        song: optional(SongSchema),
        sounds: optional(Type.Array(SoundSchema, { maxItems: 8 })),
        css: optional(Type.String({ maxLength: 20_000 })),
        scenes: Type.Array(SceneSchema, { minItems: 1, maxItems: 24 }),
        overlays: optional(Type.Array(LayerSchema, { maxItems: 6 })),
      }),
    ),
    set: optional(SetSchema),
    scenes: optional(Type.Array(SceneSchema, { maxItems: 24 })),
    remove: optional(Type.Array(Type.String(), { maxItems: 24 })),
    sketch: optional(Type.Boolean({ description: "Check it and take the stills (default true)." })),
  }),
  kind: "read",
  summary: (a) => `Storyboard ${a.videoId ? `of video:${a.videoId}` : `"${a.title ?? "a new video"}"`}`,
  async execute(a, ctx) {
    return media(async () => {
      let video = a.videoId ? await getVideo(a.videoId) : null;
      if (a.videoId && !video) throw new ToolError(`There's no video:${a.videoId}. video_library list shows them.`);
      const base = a.from ? await recipeOf(a.from) : ((video?.composition as Composition | null) ?? (video?.version ? versionOf(video).composition : null) ?? EMPTY);
      const c = applyPlan(base, { composition: a.composition as Composition | undefined, set: a.set as never, scenes: a.scenes as Partial<Scene>[] | undefined, remove: a.remove });
      if (!c.scenes.length) throw new ToolError("The storyboard has no scenes yet: give composition, or scenes.");

      if (!video) video = await createVideo({ chatId: ctx.chatId, userId: ctx.user.id, title: a.title?.trim() || "Untitled video", prompt: a.prompt ?? null, composition: c });
      else video = await updateVideo(video.id, { composition: c, ...(a.title?.trim() ? { title: a.title.trim() } : {}) });

      const map = await songMap(c);
      const verdict = validate(c, map);
      // A song another video already holds stops the render: say so now, while there's time to pick or add another.
      const songProblem = await checkSongs(video, c).then(
        () => null,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );
      if (songProblem) verdict.warnings.unshift(`Can't render with this song: ${songProblem}`);
      const head = `Storyboard of video:${video.id} "${video.title}" (saved): ${c.duration} s, ${c.width}x${c.height}, ${c.fps} fps${c.song ? `, ${c.song.ref} from ${c.song.from ?? 0} s` : ", no song"}.`;
      const lines = [head, ...storyboardLines(c)];
      if (verdict.errors.length) {
        return { text: [...lines, "", "Must fix before it can be sketched or rendered:", ...verdict.errors.map((e) => `- ${e}`), ...(verdict.warnings.length ? ["Also:", ...verdict.warnings.map((w) => `- ${w}`)] : [])].join("\n"), error: true };
      }
      if (map) {
        const { beats, bars } = videoBeats(c, map);
        lines.push(`Beats in the video: ${beats.slice(0, 48).join(", ")}${beats.length > 48 ? "…" : ""}. Bars start at: ${bars.join(", ")}.`);
      }
      if (verdict.warnings.length) lines.push("", "Worth fixing:", ...verdict.warnings.map((w) => `- ${w}`));
      if (a.sketch === false) return { text: lines.join("\n") };

      const sketch = await sketchComposition(c, jobFor(ctx, video, "Sketches"), ctx);
      const errors = sketch.findings.filter((f) => f.severity === "error");
      if (sketch.findings.length) lines.push("", `The check found ${errors.length} error${errors.length === 1 ? "" : "s"} (they stop a render) and ${sketch.findings.length - errors.length} warning(s):`, ...findingLines(sketch.findings));
      else lines.push("", "The check found nothing wrong: layout, the reel's safe zones, contrast, motion.");
      lines.push("", REVIEW_SHEET);
      return { text: lines.join("\n"), images: sketch.sheet ? [jpegBlock(sketch.sheet)] : [] };
    });
  },
});

export const videoRender = defineTool({
  name: "video_render",
  label: "Render video",
  description: [
    "Render a video's storyboard (video_plan) as its next version: drafts while you work (they cost nothing and claim nothing), a final once the owner has seen a draft and said go (a final claims its library song).",
    "The renderer checks the layout first; errors stop the render and come back to fix with video_plan (ignore: [codes] only for a finding that's wrong about this video). After it renders: checks on the file (black or frozen stretches; loudness is evened for Instagram),",
    "a contact sheet of every scene and the watch copy, both attached: look at both before deciding what to change. The owner sees each version play in the chat.",
    "One render runs at a time across all chats: if others are ahead, this waits for them (up to 5 minutes, then says what's in the way). video_library rendering shows what's running; stop_render stops it.",
  ].join(" "),
  parameters: Type.Object({
    videoId: Type.Integer(),
    quality: optional(StringEnum(["draft", "final"])),
    ignore: optional(Type.Array(Type.String(), { maxItems: 10, description: "Check codes to accept for this render." })),
    watch: optional(Type.Boolean({ description: "Get the watch copy back (default true)." })),
    frames: optional(Type.Array(Type.Number({ minimum: 0 }), { maxItems: 8, description: "Stills at these seconds as well." })),
  }),
  kind: "read",
  summary: (a) => `${a.quality === "final" ? "Final" : "Draft"} render of video:${a.videoId}`,
  async execute(a, ctx) {
    return media(async () => {
      const video = await getVideo(a.videoId);
      if (!video) throw new ToolError(`There's no video:${a.videoId}. video_library list shows them.`);
      let c = video.composition as Composition | null;
      if (!c?.scenes?.length) throw new ToolError(`video:${video.id} has no storyboard: write one with video_plan first.`);
      const verdict = validate(c, await songMap(c));
      if (verdict.errors.length) throw new ToolError(`The storyboard can't render yet:\n${verdict.errors.map((e) => `- ${e}`).join("\n")}`);
      await checkSongs(video, c);
      const quality = a.quality ?? "draft";

      const started = Date.now();
      const r = await renderComposition(c, quality, jobFor(ctx, video, quality === "final" ? "Final render" : "Draft render"), ctx, a.ignore ?? []);
      if (r.blocked) {
        return {
          text: ["Not rendered: the check found errors. Fix them with video_plan (or, when one is wrong about this video, render again with ignore: [its code]).", ...findingLines(r.blocked)].join("\n"),
          error: true,
        };
      }
      let row: VideoRow;
      let version: VideoVersion;
      let post: string[];
      try {
        const checked = await postChecks(r.file!, c);
        post = checked.notes;
        if (checked.volume !== null && c.song) {
          c = { ...c, song: { ...c.song, volume: checked.volume } };
          await updateVideo(video.id, { composition: c });
        }
        ({ video: row, version } = await addVersion(video.id, r.file!, { quality, composition: c, findings: [...findingLines(r.findings), ...post.map((p) => `- ${p}`)] }, ctx.progress));
      } finally {
        await r.clear();
      }
      const took = round((Date.now() - started) / 1000, 1);
      const ref = `video:${row.id}@${version.version}`;
      const file = videoFile(row.id, version.version);

      const moments = heroMoments(c);
      const stills = await stillsAt(file, moments.map((m) => m.at), 540);
      const images: ImageContent[] = [jpegBlock(await contactSheet(stills.map((image, i) => ({ image, label: moments[i].label })), { columns: Math.min(6, stills.length) }))];
      const videos: VideoContent[] = [];
      if (a.watch !== false && ctx.canWatch) videos.push(await watchBlock(ref));
      if (a.frames?.length) images.push(...(await stillsAt(file, a.frames, 768)).map(jpegBlock));

      const notes = [...findingLines(r.findings), ...post.map((p) => `- ${p}`)];
      return {
        text: [
          `Rendered ${ref} (${version.quality}, ${version.width}x${version.height}, ${version.seconds} s) in ${took} s.`,
          notes.length ? `What the checks found:\n${notes.join("\n")}` : "Checks passed: layout, the reel's safe zones, contrast, motion, loudness, no black or frozen stretches.",
          `The contact sheet${videos.length ? " and the watch copy are" : " is"} attached. Watch it as a viewer: would the first second stop you, does the hook's promise show, can every word be read in the time it's up, do the cuts land on the beat, is the product on screen to the end, is anything blank, soft or repeated? Fix what's off and render again.`,
          version.quality === "final" ? "" : "When it's right, it's already attached in the chat: tell the owner in one or two short lines what it is and ask for their go-ahead or changes before the final.",
        ]
          .filter(Boolean)
          .join("\n"),
        data: videoSummary(row, version.version),
        videos,
        images,
      };
    });
  },
});

/* -------------------------------------------------------------------------- */
/* video_library                                                              */
/* -------------------------------------------------------------------------- */

export const videoLibrary = defineTool({
  name: "video_library",
  label: "Video library",
  description: [
    "Seelie's video library: every video, with its storyboard (video_plan) and each rendered version with the composition that made it.",
    "list: this chat's videos (scope 'all' for every one). get: a video with its versions, its storyboard, and what the checks said (version: that version's composition, to build on with video_plan from).",
    "show: play a version (default the latest) for the owner in the chat, with Download and Share: how you show a video when asked to see it.",
    "rename: a new title. feedback: record what the owner said about it (liked, notes, in their words); it guides later videos. delete: remove it and its files (only when the owner asks for that video to go).",
    "rendering: the renderer's queue, in any chat (what, where, how far). stop_render: stop the one running, e.g. when the owner wants theirs first. Deleting a video never stops or frees a render.",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["list", "get", "show", "rename", "feedback", "delete", "rendering", "stop_render"]),
    scope: optional(StringEnum(["chat", "all"])),
    videoId: optional(Type.Integer()),
    version: optional(Type.Integer()),
    title: optional(Type.String({ maxLength: 200 })),
    liked: optional(Type.Boolean()),
    notes: optional(Type.String({ maxLength: 4000 })),
  }),
  kind: (a) => (a.action === "delete" || a.action === "stop_render" ? "write" : "read"),
  summary: async (a) => {
    switch (a.action) {
      case "list":
        return "Videos";
      case "rendering":
        return "What's rendering";
      case "stop_render": {
        const now = (await renderQueue().catch(() => [])).find((j) => j.status === "running");
        return now ? `Stop the render running now: ${now.what}` : "Stop the render running now";
      }
      case "delete": {
        // What the video really is, beside the model's own words on the card.
        const video = a.videoId ? await getVideo(a.videoId).catch(() => null) : null;
        if (!video) return `Delete video:${a.videoId}`;
        const versions = versionsOf(video);
        const finals = versions.filter((v) => v.quality === "final").length;
        const made = versions.length ? `${plural(versions.length, "version")}${finals ? `, ${plural(finals, "final")}` : ", drafts only"}` : "not rendered yet";
        return `Delete video:${video.id} "${video.title}" (${made}) and its files`;
      }
      case "rename":
        return `Rename video:${a.videoId} to "${a.title ?? ""}"`;
      case "feedback":
        return `Note on video:${a.videoId}`;
      default:
        return `${a.action === "show" ? "Show " : ""}video:${a.videoId}${a.version ? `@${a.version}` : ""}`;
    }
  },
  async execute(a, ctx) {
    return media(async () => {
      if (a.action === "list") {
        const rows = await listVideos({ limit: 40, chatId: a.scope === "all" ? undefined : ctx.chatId });
        return { data: rows.map((v) => videoSummary(v)), text: rows.length ? undefined : "No videos yet." };
      }
      if (a.action === "rendering") {
        const queue = await renderQueue();
        if (!queue.length) return { text: "Nothing is rendering." };
        const lines: string[] = [];
        for (const job of queue) {
          const [chat] = job.chatId && job.chatId !== ctx.chatId ? await db.select({ title: seelieChats.title }).from(seelieChats).where(eq(seelieChats.id, job.chatId)) : [];
          lines.push(`- ${describeJob(job, { chatId: ctx.chatId, runId: ctx.runId })}${chat?.title ? ` ("${chat.title}")` : ""}`);
        }
        return { text: `The renderer's queue (one at a time, in this order):\n${lines.join("\n")}` };
      }
      if (a.action === "stop_render") {
        const stopped = await stopRender();
        return { text: stopped ? `Stopped: ${stopped.what}.` : "Nothing was rendering." };
      }
      if (!a.videoId) throw new ToolError("Which video (videoId)?");
      const video = await getVideo(a.videoId);
      if (!video) throw new ToolError(`There's no video:${a.videoId}.`);
      switch (a.action) {
        case "get": {
          const v = video.version ? versionOf(video, a.version) : null;
          return {
            data: {
              ...videoSummary(video, v?.version),
              prompt: video.prompt,
              versions: versionsOf(video).map((x) => ({ version: x.version, quality: x.quality, seconds: x.seconds, ...(x.pruned ? { pruned: true } : {}), ...(x.composition ? {} : { renderer: "old ffmpeg graph" }), at: x.renderedAt })),
              storyboard: video.composition ?? null,
              ...(v?.composition && a.version !== undefined ? { versionComposition: v.composition } : {}),
              ...(v && !v.composition ? { oldRecipe: { inputs: v.inputs, graph: v.graph, files: v.files } } : {}),
              ...(v?.findings?.length ? { checks: v.findings } : {}),
            },
          };
        }
        case "show": {
          if (!video.version) throw new ToolError(`video:${video.id} isn't rendered yet.`);
          const v = versionOf(video, a.version);
          if (v.pruned) throw new ToolError(`video:${video.id}@${v.version}'s file was cleared to save space; render it again to show it.`);
          return { data: videoSummary(video, v.version), text: `The owner sees video:${video.id}@${v.version} playing in the chat now.` };
        }
        case "rename":
          if (!a.title?.trim()) throw new ToolError("What title?");
          return { data: videoSummary(await updateVideo(video.id, { title: a.title.trim() })) };
        case "feedback":
          if (a.liked === undefined && a.notes === undefined) throw new ToolError("Give liked and/or notes.");
          return { data: videoSummary(await updateVideo(video.id, { liked: a.liked, notes: a.notes })) };
        case "delete": {
          if ((await renderQueue()).some((j) => j.videoId === video.id)) throw new ToolError(`video:${video.id} is rendering or waiting to. Stop the render first (stop_render) if the owner wants the video gone.`);
          await deleteVideo(video.id);
          return { text: `Deleted video:${video.id} "${video.title}".` };
        }
      }
    });
  },
});
