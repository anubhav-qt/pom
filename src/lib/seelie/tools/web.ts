import "server-only";

import { Type } from "@paribelle/pi-ai";

import { youtubeId } from "@/lib/reels/songs";
import { runYtDlp, YtDlpError } from "@/lib/reels/ytdlp";

import { GeminiError, generateContent, HELPER_MODEL, todayLine } from "../gemini";
import { fetchPublic } from "./images";
import { defineTool, ToolError } from "./types";
import { optional, StringEnum } from "./util";

/** Sub-call failures are the model's to work around: a tool error, not a crash. */
async function outside<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GeminiError || err instanceof YtDlpError) throw new ToolError(err.message);
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* web_search                                                                 */
/* -------------------------------------------------------------------------- */

export const webSearch = defineTool({
  name: "web_search",
  label: "Search the web",
  description: [
    "Search the web with Google and get an answer written from the results, with its sources.",
    "For what you don't know or what changes: trends, songs going viral on Reels, festivals and sale dates, competitors, how-tos, facts to check.",
    "Ask one clear question per call, with the detail that matters (place, time, platform). fetch_url reads a source in full.",
  ].join(" "),
  parameters: Type.Object({
    query: Type.String({ maxLength: 1000, description: "The question, as you'd ask a researcher." }),
  }),
  kind: "read",
  summary: (a) => a.query.slice(0, 120),
  async execute(a, ctx) {
    return outside(async () => {
      const res = await generateContent(
        HELPER_MODEL,
        {
          systemInstruction: {
            parts: [
              {
                text: `${todayLine()} You research for Paribelle, an Indian women's ethnic-wear label. Search the web and answer from what you find: specific names, numbers and dates, newest first when it's about trends. Say when the results don't settle something. No preamble.`,
              },
            ],
          },
          contents: [{ role: "user", parts: [{ text: `${todayLine()}\n\n${a.query}` }] }],
          tools: [{ googleSearch: {} }],
        },
        { signal: ctx.signal, timeoutMs: 90_000 },
      );
      if (!res.text) throw new ToolError("The search gave no answer. Ask it differently.");
      return {
        text: res.text,
        data: { searched: res.queries, sources: res.sources.slice(0, 12) },
      };
    });
  },
});

/* -------------------------------------------------------------------------- */
/* fetch_url                                                                  */
/* -------------------------------------------------------------------------- */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", rupee: "₹" };

function decode(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

const attr = (tag: string, name: string) => decode(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(2).find((x) => x !== undefined) ?? "");

/** A page as readable text, with its title, description, structured data, links and images. */
function readPage(html: string, base: string) {
  const abs = (u: string) => {
    try {
      const url = new URL(u, base);
      return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
    } catch {
      return null;
    }
  };
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const meta = (key: string) => {
    const tag = metas.find((t) => new RegExp(`(name|property)\\s*=\\s*["']?${key}["'\\s>]`, "i").test(t));
    return tag ? attr(tag, "content").trim() : "";
  };
  const structured = [...html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1].trim())
    .join("\n")
    .slice(0, 6000);

  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head|canvas|form|nav|aside|footer)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(div|ul|section)\b[^>]*\brole\s*=\s*["']?navigation[\s\S]*?<\/\1>/gi, " ");
  const main = /<(main|article)\b[\s\S]*?<\/\1>/i.exec(body)?.[0];
  if (main && main.length > 1500) body = main;

  const links: { text: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const url = abs(attr(m[0], "href"));
    const text = decode(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (!url || !text || seen.has(url) || links.length >= 60) continue;
    seen.add(url);
    links.push({ text: text.slice(0, 100), url });
  }
  const images: string[] = [];
  for (const u of [meta("og:image"), ...[...body.matchAll(/<img\b[^>]*>/gi)].map((m) => attr(m[0], "src") || attr(m[0], "data-src"))]) {
    const url = u ? abs(u) : null;
    if (url && !url.startsWith("data:") && !images.includes(url) && images.length < 24) images.push(url);
  }

  const text = decode(
    body
      .replace(/<(h[1-6])\b[^>]*>/gi, "\n\n## ")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<(br|hr)\b[^>]*>/gi, "\n")
      .replace(/<\/(p|div|section|article|header|footer|ul|ol|table|tr|h[1-6]|blockquote|pre|figure|dl|dt|dd)>/gi, "\n")
      .replace(/<(td|th)\b[^>]*>/gi, " | ")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, all) => l !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .trim();
  return { title, description: meta("description") || meta("og:description"), structured, links, images, text };
}

export const fetchUrl = defineTool({
  name: "fetch_url",
  label: "Read a page",
  description: [
    "Read a public https page (or a JSON, text or XML file): its text, title, description and structured data (product pages often carry price, sizes and photos there).",
    "Long pages come in parts: pass `from` (the offset given) for the next. links true lists its links; images lists its image URLs (view_images to look, video_assets import to use them).",
  ].join(" "),
  parameters: Type.Object({
    url: Type.String(),
    from: optional(Type.Integer({ minimum: 0 })),
    maxChars: optional(Type.Integer({ minimum: 1000, maximum: 40_000 })),
    links: optional(Type.Boolean()),
  }),
  kind: "read",
  summary: (a) => a.url.slice(0, 120),
  async execute(a, ctx) {
    const { bytes, type, url } = await fetchPublic(a.url, ctx.signal, {
      maxBytes: 8 * 1024 * 1024,
      timeoutMs: 30_000,
      accept: "text/html,application/xhtml+xml,application/json,text/plain,application/xml;q=0.9,*/*;q=0.5",
    });
    const max = a.maxChars ?? 12_000;
    const from = a.from ?? 0;
    const textual = /^(text\/|application\/(json|xml|xhtml\+xml|rss\+xml|atom\+xml|ld\+json))/.test(type) || type === "";
    if (!textual) {
      throw new ToolError(
        `${url} is ${type}, not a page.${type.startsWith("image/") ? " view_images shows it; video_assets import keeps it." : type.startsWith("video/") || type.startsWith("audio/") ? " video_assets import keeps it." : ""}`,
      );
    }
    const raw = bytes.toString("utf8");
    const html = /html/.test(type) || /^\s*<(!doctype html|html)/i.test(raw);
    const page = html ? readPage(raw, url) : { title: "", description: "", structured: "", links: [], images: [], text: raw };
    const part = page.text.slice(from, from + max);
    const next = from + max < page.text.length ? from + max : null;
    return {
      text: part || "(no readable text)",
      data: {
        url,
        ...(page.title ? { title: page.title } : {}),
        ...(page.description ? { description: page.description } : {}),
        ...(from === 0 && page.structured ? { structured: page.structured } : {}),
        chars: page.text.length,
        ...(next !== null ? { next: `from ${next}` } : {}),
        ...(from === 0 && page.images.length ? { images: page.images } : {}),
        ...(a.links ? { links: page.links } : {}),
      },
    };
  },
});

/* -------------------------------------------------------------------------- */
/* youtube                                                                    */
/* -------------------------------------------------------------------------- */

const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

type YtEntry = {
  id?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  view_count?: number;
  like_count?: number;
  upload_date?: string;
  timestamp?: number;
  description?: string;
  tags?: string[];
  chapters?: { title: string; start_time: number }[];
  url?: string;
  live_status?: string;
};

const date = (e: YtEntry) => (e.upload_date ? `${e.upload_date.slice(0, 4)}-${e.upload_date.slice(4, 6)}-${e.upload_date.slice(6, 8)}` : e.timestamp ? new Date(e.timestamp * 1000).toISOString().slice(0, 10) : undefined);

export const youtube = defineTool({
  name: "youtube",
  label: "YouTube",
  description: [
    "YouTube: search finds videos (title, channel, length, views); add 'shorts' or 'reel' to the query for short-form.",
    "info: one video's details (description, chapters, tags, date). watch: Gemini watches and listens to a video and answers `question`",
    "(a song's mood, tempo and where the hook is, a trend's editing style, what a reference edit does); from/to (seconds) for a part of a long video.",
    "To add a song from YouTube to the library, use the songs tool.",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["search", "info", "watch"]),
    query: optional(Type.String({ maxLength: 300 })),
    limit: optional(Type.Integer({ minimum: 1, maximum: 20 })),
    url: optional(Type.String()),
    question: optional(Type.String({ maxLength: 2000 })),
    from: optional(Type.Number({ minimum: 0 })),
    to: optional(Type.Number({ minimum: 1 })),
  }),
  kind: "read",
  summary: (a) => (a.action === "search" ? `Search "${a.query ?? ""}"` : `${a.action === "watch" ? "Watch" : "About"} ${a.url ?? ""}`),
  async execute(a, ctx) {
    return outside(async () => {
      if (a.action === "search") {
        if (!a.query?.trim()) throw new ToolError("Search for what (query)?");
        const n = a.limit ?? 10;
        const out = await runYtDlp(["--flat-playlist", "-J", `ytsearch${n}:${a.query.trim()}`], { signal: ctx.signal, timeoutMs: 60_000 });
        const entries = ((JSON.parse(out) as { entries?: YtEntry[] }).entries ?? []).filter((e) => e.id);
        return {
          data: entries.map((e) => ({
            url: e.url?.includes("/shorts/") ? `https://www.youtube.com/shorts/${e.id}` : watchUrl(e.id!),
            title: e.title,
            channel: e.channel ?? e.uploader,
            seconds: e.duration ?? null,
            views: e.view_count ?? null,
            ...(e.live_status && e.live_status !== "not_live" ? { live: e.live_status } : {}),
          })),
          text: entries.length ? undefined : "Nothing found.",
        };
      }

      const id = youtubeId(a.url);
      if (!id) throw new ToolError("url: a YouTube video link (watch, shorts or youtu.be).");

      if (a.action === "info") {
        const out = await runYtDlp(["-J", "--no-playlist", "--skip-download", watchUrl(id)], { signal: ctx.signal, timeoutMs: 90_000 });
        const e = JSON.parse(out) as YtEntry;
        return {
          data: {
            url: watchUrl(id),
            title: e.title,
            channel: e.channel ?? e.uploader,
            seconds: e.duration,
            uploaded: date(e),
            views: e.view_count,
            likes: e.like_count,
            tags: e.tags?.slice(0, 15),
            chapters: e.chapters?.map((c) => ({ at: Math.round(c.start_time), title: c.title })),
            description: e.description?.slice(0, 2500),
          },
        };
      }

      const question = a.question?.trim() || "Describe this video: what happens, how it's shot and edited (pace, cuts, text, transitions), and what the audio is (music, mood, tempo, where it peaks).";
      const res = await generateContent(
        HELPER_MODEL,
        {
          contents: [
            {
              role: "user",
              parts: [
                {
                  fileData: { fileUri: watchUrl(id), mimeType: "video/*" },
                  ...(a.from !== undefined || a.to !== undefined
                    ? { videoMetadata: { ...(a.from !== undefined ? { startOffset: `${a.from}s` } : {}), ...(a.to !== undefined ? { endOffset: `${a.to}s` } : {}) } }
                    : {}),
                } as never,
                { text: `${todayLine()} ${question} Give times as m:ss.` },
              ],
            },
          ],
        },
        { signal: ctx.signal, timeoutMs: 180_000 },
      );
      if (!res.text) throw new ToolError("No answer came back about that video.");
      return { text: res.text, data: { url: watchUrl(id) } };
    });
  },
});
