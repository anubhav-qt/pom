import "server-only";

import { readdir, readFile, writeFile } from "node:fs/promises";

import { Type, type ImageContent, type VideoContent } from "@paribelle/pi-ai";
import { desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { reelTracks, seelieAssets } from "@/db/schema";
import type { TrackAnalysis } from "@/lib/reels/beats";

import { assetSummary, extOf, kindOfMime, mediaFolder, MediaError, SAFE_NAME, saveAsset, videoFile } from "../media/files";
import { checkGraph, GraphError } from "../media/graph";
import {
  createVideo,
  deleteVideo,
  getVideo,
  listVideos,
  renderVersion,
  songsFor,
  updateVideo,
  versionOf,
  versionsOf,
  videoSummary,
  type VideoVersion,
} from "../media/library";
import { REF_PATTERN, resolveRef } from "../media/refs";
import { checkSpec, MAX_SECONDS, stillsAt, type RenderSpec } from "../media/render";
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

/** A Google font from Fontsource (static TTFs per weight; every Google font is OFL or Apache). */
async function addFont(family: string, weights: number[] | undefined, subset: string | undefined, italic: boolean, ctx: ToolContext) {
  const id = family.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!id) throw new ToolError("Which font family?");
  const meta = await fetchPublic(`https://api.fontsource.org/v1/fonts/${id}`, ctx.signal, { maxBytes: 2_000_000 }).catch(() => {
    throw new ToolError(`There's no Google font "${family}" (fonts.google.com lists them).`);
  });
  const info = JSON.parse(meta.bytes.toString("utf8")) as { family: string; subsets: string[]; weights: number[]; styles: string[]; license: string; type: string };
  if (info.type !== "google") throw new ToolError(`${info.family} isn't a Google font.`);
  const sub = subset ?? "latin";
  if (!info.subsets.includes(sub)) throw new ToolError(`${info.family} has no ${sub} characters; it has ${info.subsets.join(", ")}.`);
  if (italic && !info.styles.includes("italic")) throw new ToolError(`${info.family} has no italic.`);
  const want = (weights?.length ? weights : [400, 700]).filter((w) => info.weights.includes(w));
  if (!want.length) throw new ToolError(`${info.family} comes in weights ${info.weights.join(", ")}.`);

  const dir = await mediaFolder("fonts");
  const saved: string[] = [];
  for (const w of want.slice(0, 6)) {
    const style = italic ? "italic" : "normal";
    const { bytes } = await fetchPublic(`https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/${sub}-${w}-${style}.ttf`, ctx.signal, { maxBytes: 5_000_000 });
    const name = `${info.family.replace(/[^A-Za-z0-9]+/g, "")}-${w}${italic ? "-italic" : ""}${sub === "latin" ? "" : `-${sub}`}.ttf`;
    if (!SAFE_NAME.test(name)) continue;
    await writeFile(`${dir}/${name}`, bytes);
    saved.push(`$font/${name}`);
  }
  return { family: info.family, license: info.license, added: saved, otherSubsets: info.subsets.filter((s) => s !== sub) };
}

export const videoAssets = defineTool({
  name: "video_assets",
  label: "Media",
  description: [
    "What the video tools can use, by ref: chat:<n> (images attached in this chat, oldest first), asset:<id> (clips, images, sounds, subtitles in Seelie's media),",
    "song:<id> (library songs, ~70 s around the hook, with their beat map), video:<id>[@<version>] (library videos), brand:endcard (Paribelle's 1080x1920 end card).",
    "list: this chat's media (scope 'all' for everything). info: details of refs; images are shown to you; songs give bpm, beats, bars, phrases, lifts and hook in seconds.",
    "songs: library songs still free (each song makes one reel or video; pass videoId to include the one it holds).",
    `import: save images, clips (up to ${MAX_SECONDS * 4} s is fine) or sounds from public https URLs as assets. fonts: the fonts ($font/<file>) and looks ($lut/<file>) graphs may use.`,
    "add_font: download a Google font by family (weights, default 400 and 700; subset e.g. devanagari for Hindi text, as one file per subset; italic).",
    "save_frame: keep a still from a clip or video (ref, at seconds) as an image asset, e.g. to cut out or restyle.",
    "Product photos from the catalogue or paribelle.in: import their https URLs first.",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["list", "info", "songs", "import", "fonts", "add_font", "save_frame"]),
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
          const fonts = await readdir(await mediaFolder("fonts"));
          const luts = await readdir(await mediaFolder("luts"));
          return {
            data: { fonts: fonts.map((f) => `$font/${f}`), looks: luts.map((f) => `$lut/${f}`) },
            text: fonts.length ? undefined : "No fonts yet: add_font adds Google fonts.",
          };
        }

        case "add_font": {
          if (!a.family) throw new ToolError("Which font family?");
          return { data: await addFont(a.family, a.weights, a.subset, a.italic === true, ctx) };
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
      return { text: notes.join("\n"), videos, images };
    });
  },
});

/* -------------------------------------------------------------------------- */
/* video_render                                                               */
/* -------------------------------------------------------------------------- */

const InputSchema = Type.Object({
  ref: Type.String({ description: "chat:<n>, asset:<id>, song:<id>, video:<id>[@<v>] or brand:endcard" }),
  start: optional(Type.Number({ minimum: 0, description: "Seconds into the clip or sound to start from." })),
  duration: optional(Type.Number({ minimum: 0.04, description: "Seconds to read; how long an image lasts (default: the whole video)." })),
  loop: optional(Type.Boolean({ description: "Repeat until the video ends." })),
});

export const videoRender = defineTool({
  name: "video_render",
  label: "Render video",
  description: [
    "Render a video from an ffmpeg filter graph (-filter_complex syntax) you write. Input i is [i:v] / [i:a] in the order of `inputs`.",
    "The graph must end in [vout] and may end in [aout] for sound; the OMS scales/pads [vout] to width x height, sets fps and encodes H.264/AAC.",
    `Limits: at most ${MAX_SECONDS} s and 1080p (long side 1920, short side 1080, even sizes), 12-60 fps, 40 inputs. Images are still inputs that last 'duration' s.`,
    "Files only through placeholders: drawtext fontfile=$font/<file> (video_assets fonts), lut3d file=$lut/<file>, subtitles/ass $asset/<id> or $file/<name> (text you pass in files),",
    "sendcmd $file/<name>, subtitles fontsdir=$fonts. Filters that open other files or URLs (movie, amovie) aren't available.",
    "quality draft (fast, 960 px, default) while you work; final (full size) once it's right. Every render is a new version of a library video (videoId; omit it and give a title to start one).",
    "fromVersion re-renders that version's recipe with whatever you change. A final that uses song:<id> claims the song for this video.",
    "You get the render back to watch (or stills at `frames`): always watch a draft before calling it done.",
  ].join(" "),
  parameters: Type.Object({
    videoId: optional(Type.Integer()),
    title: optional(Type.String({ maxLength: 200 })),
    prompt: optional(Type.String({ description: "A new video: what was asked for, in the person's words." })),
    fromVersion: optional(Type.Integer({ minimum: 1 })),
    inputs: optional(Type.Array(InputSchema, { maxItems: 40 })),
    graph: optional(Type.String({ maxLength: 100_000 })),
    files: optional(Type.Array(Type.Object({ name: Type.String(), content: Type.String() }), { maxItems: 10 })),
    width: optional(Type.Integer()),
    height: optional(Type.Integer()),
    fps: optional(Type.Number()),
    duration: optional(Type.Number({ description: "Seconds." })),
    quality: optional(StringEnum(["draft", "final"])),
    watch: optional(Type.Boolean({ description: "Get the render back to watch (default true)." })),
    frames: optional(Type.Array(Type.Number({ minimum: 0 }), { maxItems: 8, description: "Stills at these seconds as well." })),
  }),
  kind: "read",
  summary: (a) => `${a.quality === "final" ? "Final" : "Draft"} render of ${a.videoId ? `video:${a.videoId}` : `"${a.title ?? "a new video"}"`}${a.fromVersion ? ` from v${a.fromVersion}` : ""}`,
  async execute(a, ctx) {
    return media(async () => {
      let video = a.videoId ? await getVideo(a.videoId) : null;
      if (a.videoId && !video) throw new ToolError(`There's no video:${a.videoId}. video_library list shows them.`);
      let base: VideoVersion | null = null;
      if (a.fromVersion !== undefined) {
        if (!video) throw new ToolError("fromVersion needs the videoId it belongs to.");
        base = versionOf(video, a.fromVersion);
      }
      const inputs = a.inputs ?? base?.inputs;
      const graph = a.graph ?? base?.graph;
      const duration = a.duration ?? base?.seconds;
      if (!inputs?.length) throw new ToolError("inputs: which media go in?");
      if (!graph) throw new ToolError("graph: the filter graph to render.");
      if (!duration) throw new ToolError("duration: how many seconds?");
      for (const input of inputs) if (!REF_PATTERN.test(input.ref.trim())) throw new ToolError(`"${input.ref}" isn't a ref (video_assets list shows them).`);
      const spec: RenderSpec = {
        inputs: inputs.map((i) => ({ ...i, ref: i.ref.trim() })),
        graph,
        files: a.files ? Object.fromEntries(a.files.map((f) => [f.name, f.content])) : base?.files,
        width: a.width ?? base?.canvas.width ?? 1080,
        height: a.height ?? base?.canvas.height ?? 1920,
        fps: a.fps ?? base?.fps ?? 30,
        duration,
        quality: a.quality ?? "draft",
      };
      // Refuse a bad graph before a new video is made for it.
      checkSpec(spec);
      checkGraph(spec.graph, spec.inputs.length, spec.files ?? {});

      if (!video) {
        video = await createVideo({ chatId: ctx.chatId, userId: ctx.user.id, title: a.title?.trim() || "Untitled video", prompt: a.prompt ?? null });
      } else if (a.title?.trim() && a.title.trim() !== video.title) {
        video = await updateVideo(video.id, { title: a.title.trim() });
      }

      const started = Date.now();
      const { video: row, version } = await renderVersion(video.id, spec, { chatImages: ctx.chatImages, signal: ctx.signal, progress: ctx.progress });
      const took = round((Date.now() - started) / 1000, 1);

      const videos: VideoContent[] = [];
      const images: ImageContent[] = [];
      const ref = `video:${row.id}@${version.version}`;
      if (a.watch !== false) {
        if (ctx.canWatch) videos.push(await watchBlock(ref));
        else if (!a.frames?.length) images.push(...(await stillsAt(videoFile(row.id, version.version), spread(0, version.seconds, 6), 768)).map(jpegBlock));
      }
      if (a.frames?.length) images.push(...(await stillsAt(videoFile(row.id, version.version), a.frames, 768)).map(jpegBlock));

      const seen = videos.length ? " Its watch copy is attached: watch it before deciding what to change." : images.length ? " Stills from it are attached." : "";
      return {
        text: `Rendered ${ref} (${version.quality}, ${version.width}x${version.height}, ${version.seconds} s) in ${took} s.${seen}`,
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
    "Seelie's video library: every video rendered, each version with the graph and inputs that made it.",
    "list: this chat's videos (scope 'all' for every one). get: a video with its versions and a version's recipe (inputs, graph, files) to change and render again.",
    "rename: a new title. feedback: record what the owner said about it (liked, notes, in their words); it guides later videos. delete: remove it and its files.",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["list", "get", "rename", "feedback", "delete"]),
    scope: optional(StringEnum(["chat", "all"])),
    videoId: optional(Type.Integer()),
    version: optional(Type.Integer()),
    title: optional(Type.String({ maxLength: 200 })),
    liked: optional(Type.Boolean()),
    notes: optional(Type.String({ maxLength: 4000 })),
  }),
  kind: (a) => (a.action === "delete" ? "write" : "read"),
  summary: (a) =>
    a.action === "list"
      ? "Videos"
      : a.action === "delete"
        ? `Delete video:${a.videoId} and its files`
        : a.action === "rename"
          ? `Rename video:${a.videoId} to "${a.title ?? ""}"`
          : a.action === "feedback"
            ? `Note on video:${a.videoId}`
            : `video:${a.videoId}${a.version ? `@${a.version}` : ""}`,
  async execute(a, ctx) {
    return media(async () => {
      if (a.action === "list") {
        const rows = await listVideos({ limit: 40, chatId: a.scope === "all" ? undefined : ctx.chatId });
        return { data: rows.map((v) => videoSummary(v)), text: rows.length ? undefined : "No videos yet." };
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
              versions: versionsOf(video).map((x) => ({ version: x.version, quality: x.quality, seconds: x.seconds, ...(x.pruned ? { pruned: true } : {}), at: x.renderedAt })),
              ...(v ? { recipe: { inputs: v.inputs, graph: v.graph, files: v.files, width: v.canvas.width, height: v.canvas.height, fps: v.fps, duration: v.seconds } } : {}),
            },
          };
        }
        case "rename":
          if (!a.title?.trim()) throw new ToolError("What title?");
          return { data: videoSummary(await updateVideo(video.id, { title: a.title.trim() })) };
        case "feedback":
          if (a.liked === undefined && a.notes === undefined) throw new ToolError("Give liked and/or notes.");
          return { data: videoSummary(await updateVideo(video.id, { liked: a.liked, notes: a.notes })) };
        case "delete":
          await deleteVideo(video.id);
          return { text: `Deleted video:${video.id} "${video.title}".` };
      }
    });
  },
});
