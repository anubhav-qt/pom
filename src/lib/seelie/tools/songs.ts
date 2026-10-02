import "server-only";

import { Type } from "@paribelle/pi-ai";

import { addSong, addWarnings, checkSong, errorText, loadKnown, mmss, vetSongs, type SongInput } from "@/lib/reels/songs";
import { YtDlpError } from "@/lib/reels/ytdlp";

import { defineTool, ToolError } from "./types";
import { optional, plural, StringEnum } from "./util";

const Song = Type.Object({
  input: Type.String({ description: 'A YouTube link (the official audio is best) or "ytsearch1:<title> <artist> audio".' }),
  title: Type.String(),
  artist: Type.String(),
  language: optional(Type.String({ description: "punjabi (default), hindi, haryanvi, english, instrumental, ..." })),
  tags: optional(Type.Array(Type.String(), { maxItems: 10, description: "Moods and occasions: wedding, festive, romantic, upbeat, ..." })),
  hook: optional(Type.String({ description: 'Where the chorus reels use starts, as m:ss ("0:47"). Without it the loudest chorus is guessed.' })),
  source: optional(Type.String()),
  again: optional(Type.Boolean({ description: "Only when the owner asked to add a known song anyway (new audio or hook)." })),
});

const round = (n: number) => Math.round(n * 10) / 10;

export const songs = defineTool({
  name: "songs",
  label: "Song library",
  description: [
    "The song library that reels and videos use (each song makes one reel or video, then it's used); it keeps ~70 s around each song's hook with its beat map.",
    "known: every song the library has or had (used ones too); read it before suggesting songs, never suggest one it has. vet: check candidates against it (nothing fetched).",
    "check: fetch and measure one song (tempo, beats, hook, the stretch it would keep) without saving. add: fetch, measure and save up to 5 vetted songs (asks first).",
    "Find candidates with web_search (what's trending on Reels now) and youtube (search, and watch to hear the hook); give each its hook as m:ss when you know it.",
  ].join(" "),
  parameters: Type.Object({
    action: StringEnum(["known", "vet", "check", "add"]),
    songs: optional(Type.Array(Song, { maxItems: 20 })),
    input: optional(Type.String()),
    hook: optional(Type.String()),
  }),
  kind: (a) => (a.action === "add" ? "write" : "read"),
  summary: (a) =>
    a.action === "add"
      ? `Add ${a.songs?.map((s) => `"${s.title} — ${s.artist}"`).join(", ") ?? "songs"} to the song library`
      : a.action === "vet"
        ? `Vet ${plural(a.songs?.length ?? 0, "song")}`
        : a.action === "check"
          ? `Measure ${a.input ?? ""}`
          : "Every known song",
  async execute(a, ctx) {
    try {
      switch (a.action) {
        case "known": {
          const { songs: known, catalogue } = await loadKnown();
          const left = known.filter((k) => k.table === "reel_tracks" && k.status === "in library").length;
          return {
            text: `${known.length} known, ${left} left for new reels and videos.${catalogue ? ` (${catalogue})` : ""}`,
            data: known.slice(0, 500).map((k) => ({
              ...(k.table === "reel_tracks" ? { ref: `song:${k.id}` } : { old: k.id }),
              title: k.title,
              artist: k.artist,
              status: k.status,
              ...(k.language ? { language: k.language } : {}),
              ...(k.bpm ? { bpm: round(k.bpm) } : {}),
            })),
          };
        }

        case "vet": {
          if (!a.songs?.length) throw new ToolError("Which songs (songs)?");
          const { songs: known } = await loadKnown();
          return { data: vetSongs(a.songs, known, { files: false }) };
        }

        case "check": {
          if (!a.input?.trim()) throw new ToolError('input: a YouTube link or "ytsearch1:<query>".');
          if (!/^(https:\/\/\S+|ytsearch1?:\s*\S.*)$/.test(a.input.trim())) throw new ToolError('input: a YouTube link or "ytsearch1:<query>".');
          ctx.progress("Fetching and measuring…");
          const r = await checkSong(a.input.trim(), a.hook, ctx.signal).catch((err: unknown) => {
            if (ctx.signal.aborted) throw err;
            throw new ToolError(errorText(err));
          });
          return {
            data: {
              upload: r.name,
              source: r.source,
              bpm: round(r.analysis.bpm),
              seconds: round(r.analysis.duration),
              hook: r.analysis.hook === null ? null : mmss(r.analysis.hook),
              hookFound: r.hookFound,
              wouldKeep: `${mmss(r.from)}–${mmss(r.to)}`,
              phrases: r.analysis.phrases.length,
              lifts: r.analysis.lifts.length,
            },
            text: "Nothing was saved.",
          };
        }

        case "add": {
          if (!a.songs?.length) throw new ToolError("Which songs (songs)?");
          if (a.songs.length > 5) throw new ToolError("Add at most 5 songs at a time.");
          const { songs: known } = await loadKnown();
          const vetted = vetSongs(a.songs, known, { files: false });
          const added: unknown[] = [];
          const skipped: unknown[] = [];
          for (const [i, song] of a.songs.entries()) {
            const v = vetted[i];
            if (v.blocked) {
              skipped.push({ title: song.title, artist: song.artist, why: v.reasons });
              continue;
            }
            ctx.progress(`${i + 1} of ${a.songs.length}: fetching ${song.title}…`);
            const input: SongInput = { ...song, input: song.input.trim() };
            const warnings = addWarnings(input, known);
            try {
              const r = await addSong(input, known, ctx.signal);
              added.push({
                ref: `song:${r.id}`,
                title: r.title,
                artist: r.artist,
                upload: r.from,
                bpm: round(r.bpm),
                hook: `${mmss(r.hook)}${r.hookFound ? " (found)" : ""}`,
                kept: `${mmss(r.stretch[0])}–${mmss(r.stretch[1])}`,
                ...(warnings.length ? { warnings } : {}),
              });
            } catch (err) {
              if (ctx.signal.aborted) throw err;
              skipped.push({ title: song.title, artist: song.artist, why: [err instanceof YtDlpError ? err.message : errorText(err)] });
            }
          }
          return {
            text: `${added.length} added, ${skipped.length} skipped.${added.length ? " video_assets info on a song gives its beat map." : ""}`,
            data: { added, skipped },
            error: added.length === 0,
          };
        }
      }
    } catch (err) {
      if (err instanceof YtDlpError) throw new ToolError(err.message);
      throw err;
    }
  },
});
