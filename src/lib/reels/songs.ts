import { existsSync, statSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { asc, sql } from "drizzle-orm";

import { db } from "../../db";
import { reelTracks } from "../../db/schema";
import { analyseTrack, SAMPLE_RATE, sliceAnalysis, type TrackAnalysis } from "./beats";
import { decodeMono, runFfmpeg } from "./ffmpeg";
import { runYtDlp } from "./ytdlp";

/**
 * The reel song library's rules, shared by `npm run songs` (scripts/reel-songs.ts) and
 * Seelie's songs tool: what counts as the same song, what the database already knows,
 * vetting candidates, and adding one (fetch → measure the beats → keep ~70 s around
 * the hook as AAC → `reel_tracks`). See docs/reels/procedure.md.
 */

/** Seconds of song kept per track: enough for the longest reel plus room to choose where it starts. */
export const WINDOW = 70;
/** How far before the hook the kept stretch begins, so a reel can open on the build-up. */
export const LEAD = 8;

export interface SongInput {
  input: string;
  title: string;
  artist: string;
  language?: string;
  tags?: string[] | string;
  hook?: string | number;
  source?: string;
  /** The owner wants this song in although it is known: new audio or a new hook, or a different song with a known title. */
  again?: boolean;
}

export const SONG_FIELDS = new Set(["input", "title", "artist", "language", "tags", "hook", "source", "again"]);

/** "0:47", "1:05.5" or "47" → seconds. */
export function toSeconds(v: string | number | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  if (typeof v === "number") return v;
  const parts = v.split(":").map(Number);
  if (parts.some((p) => Number.isNaN(p))) throw new Error(`Not a time: ${v}`);
  return parts.reduce((s, p) => s * 60 + p, 0);
}

export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* -------------------------------------------------------------------------- */
/* Telling songs apart                                                        */
/* -------------------------------------------------------------------------- */

/** Lowercase with Latin accents off (é → e). Other scripts keep their vowel signs, which are letters there. */
function fold(s: string): string {
  return s.normalize("NFKD").replace(/(\p{Script=Latin})\p{M}+/gu, "$1").normalize("NFC").toLowerCase();
}

/** Punctuation off: apostrophes and dots join (don't → dont, a.p. → ap), anything else separates words. */
function plainWords(s: string): string {
  return s
    .replace(/['’‘`´.]/g, "")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    .trim();
}

/** Bracketed text, closed or not: "(From "Bad Newz")", "[Official Video]", "(no copyright". */
const BRACKETS = /\([^)]*\)?|\[[^\]]*\]?|\{[^}]*\}?/g;

/** What uploads and lyric sites add to a song's name. Applied after `fold`. */
const TITLE_NOISE = [
  /\bofficial(\s+(music|lyric|lyrical|full))?(\s+(audio|video))?\b/g,
  /\b(music|lyric|lyrical|full)\s+(video|audio)\b/g,
  /\b(full|audio|video)\s+song\b/g,
  /\blyric(al|s)?\b/g,
  /\b(4k|8k|hd|hq|uhd|\d{3,4}p)\b/g,
  /\s[-–—:]\s*(audio|video|song)\s*$/, // Tauba Tauba - Audio
];

/**
 * A title reduced to the words that name the song. YouTube titles put the
 * film and cast after a "|", so only the part before it counts.
 */
function titleKey(title: string): string {
  let s = fold(title).split("|")[0].replace(BRACKETS, " ");
  s = s
    .replace(/\s[-–—:]\s*from\s.*$/, "") // Tauba Tauba - From Bad Newz
    .replace(/\bfrom\s+["“'‘].*$/, "") // Tauba Tauba From "Bad Newz"
    .replace(/\b(feat|ft|featuring)\b.*$/, "");
  for (const re of TITLE_NOISE) s = s.replace(re, " ");
  // A title that was all noise ("Official Video") keeps its own words rather than matching every other.
  return plainWords(s) || plainWords(fold(title));
}

/** The people behind a song, one entry each, sorted: "Badshah & Diljit Dosanjh" → ["badshah", "diljit dosanjh"]. */
function artistNames(artist: string): string[] {
  const s = fold(artist)
    .replace(BRACKETS, " ")
    .replace(/\s*-\s*topic\s*$/, "")
    .replace(/\b(vevo|official)\b/g, " ");
  const names = s
    .split(/,|&|\+|\/|;|\b(?:and|x|feat|ft|featuring|with|vs)\b\.?/)
    .map(plainWords)
    .filter(Boolean);
  return [...new Set(names)].sort();
}

/**
 * The same words spelled loosely, for romanised Punjabi and Hindi where
 * "Kinni Kinni" and "Kini Kini", or "Tauba" and "Touba", are one song.
 */
function loose(s: string): string {
  return s
    .replace(/\s+/g, "")
    .replace(/ee/g, "i")
    .replace(/oo/g, "u")
    .replace(/ou/g, "au")
    .replace(/w/g, "v")
    .replace(/ph/g, "f")
    .replace(/q/g, "k")
    .replace(/z/g, "j")
    .replace(/y/g, "i")
    .replace(/(.)\1+/gu, "$1");
}

export interface SongKey {
  /** The title's words: lowercase, no accents, punctuation or upload noise. */
  title: string;
  artists: string[];
  /** `title|artist, artist`: what `known` shows and what de-duplication is about. */
  key: string;
  /** `title`, loosely spelled. */
  loose: string;
}

/** The de-duplication key for a song. The one helper every command compares with. */
export function songKey(title: string, artist: string): SongKey {
  const t = titleKey(title ?? "");
  const artists = artistNames(artist ?? "");
  return { title: t, artists, key: `${t}|${artists.join(", ")}`, loose: loose(t) };
}

/** Every word of name `a` is in name `b` ("diljit" in "diljit dosanjh"), loosely spelled. */
function nameWithin(a: string, b: string): boolean {
  const words = new Set(b.split(" ").map(loose));
  return a.split(" ").every((w) => words.has(loose(w)));
}

/** At least one person in common, so "Diljit" and "Diljit Dosanjh, Badshah" are the same act. */
function sameArtist(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => nameWithin(x, y) || nameWithin(y, x)));
}

/** The 11-character video id in a YouTube link, so two links to one upload compare equal. */
export function youtubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

export interface Comparable {
  key: SongKey;
  video: string | null;
}

export type MatchKind = "same song" | "same title" | "same upload" | "spelled alike" | "looks like";

/**
 * How `a` relates to `b`, if at all. Everything but "looks like" means the
 * same song for vetting: a known title by other artists is usually the same
 * song under another spelling, and the owner can say otherwise ("again").
 */
export function compare(a: Comparable, b: Comparable): MatchKind | null {
  const artist = sameArtist(a.key.artists, b.key.artists);
  if (a.key.title === b.key.title) return artist ? "same song" : "same title";
  if (a.video && a.video === b.video) return "same upload";
  if (!artist) return null;
  if (a.key.loose === b.key.loose) return "spelled alike";
  const [short, long] = a.key.title.length <= b.key.title.length ? [a.key.title, b.key.title] : [b.key.title, a.key.title];
  if (short.length >= 4 && ` ${long} `.includes(` ${short} `)) return "looks like";
  return null;
}

export const blocks = (m: MatchKind) => m !== "looks like";

/* -------------------------------------------------------------------------- */
/* What the database knows                                                    */
/* -------------------------------------------------------------------------- */

export interface KnownSong extends Comparable {
  table: "reel_tracks" | "reel_songs";
  id: number;
  title: string;
  artist: string;
  language: string | null;
  bpm: number | null;
  status: "in library" | "used" | "disabled" | "not used";
  /** YYYY-MM-DD. */
  usedAt: string | null;
  /** What used it: a reel job, a Seelie video, or a file the experiment wrote in the old catalogue. */
  usedIn: string | null;
  source: string | null;
  added: string | null;
}

const day = (v: unknown) => (v == null || v === "" ? null : String(v).slice(0, 10));

/**
 * Every song in `reel_tracks` and, when it exists, `reel_songs`. Read only.
 * `reel_songs` is optional: another database may never have had the experiment.
 */
export async function loadKnown(): Promise<{ songs: KnownSong[]; catalogue: string | null }> {
  const tracks = await db
    .select({
      id: reelTracks.id,
      title: reelTracks.title,
      artist: reelTracks.artist,
      language: reelTracks.language,
      bpm: reelTracks.bpm,
      active: reelTracks.active,
      usedAt: reelTracks.usedAt,
      usedByJob: reelTracks.usedByJob,
      source: reelTracks.source,
      createdAt: reelTracks.createdAt,
    })
    .from(reelTracks)
    .orderBy(asc(reelTracks.id));

  const songs: KnownSong[] = tracks.map((r) => ({
    table: "reel_tracks",
    id: r.id,
    title: r.title,
    artist: r.artist,
    language: r.language,
    bpm: r.bpm,
    status: r.usedAt ? "used" : r.active ? "in library" : "disabled",
    usedAt: r.usedAt ? r.usedAt.toISOString().slice(0, 10) : null,
    usedIn: r.usedAt ? (r.usedByJob != null ? `reel ${r.usedByJob}` : "a Seelie video") : null,
    source: r.source,
    added: r.createdAt.toISOString().slice(0, 10),
    key: songKey(r.title, r.artist),
    video: youtubeId(r.source),
  }));

  // null: read; otherwise why the old catalogue is not in the list.
  let catalogue: string | null = "reel_songs is not in this database.";
  const [reg] = (await db.execute(sql`select to_regclass('public.reel_songs')::text as t`)).rows;
  if (reg?.t) {
    try {
      // Dates as text: the columns have no time zone, and the two drivers parse them differently.
      const { rows } = await db.execute(sql`
        select id, title, artist, is_used, to_char(used_at, 'YYYY-MM-DD') as used_at, used_in_reel,
               youtube_url, to_char(created_at, 'YYYY-MM-DD') as created_at
        from reel_songs order by id
      `);
      for (const r of rows) {
        const title = String(r.title ?? "");
        const artist = String(r.artist ?? "");
        const source = r.youtube_url ? String(r.youtube_url) : null;
        songs.push({
          table: "reel_songs",
          id: Number(r.id),
          title,
          artist,
          language: null,
          bpm: null,
          status: r.is_used ? "used" : "not used",
          usedAt: r.is_used ? day(r.used_at) : null,
          usedIn: r.is_used && r.used_in_reel ? String(r.used_in_reel) : null,
          source,
          added: day(r.created_at),
          key: songKey(title, artist),
          video: youtubeId(source),
        });
      }
      catalogue = null;
    } catch (e) {
      catalogue = `reel_songs exists but could not be read: ${errorText(e)}`;
    }
  }
  return { songs, catalogue };
}

export const where = (k: KnownSong) => (k.table === "reel_tracks" ? `library #${k.id}` : `old catalogue #${k.id}`);

/** "used 2026-09-27, reel 7". `short` keeps only the file name of an old-catalogue reel. */
export function statusText(k: KnownSong, short = false): string {
  if (k.status !== "used") return k.status;
  const usedIn = k.usedIn && short ? path.win32.basename(k.usedIn) : k.usedIn;
  return `used${k.usedAt ? ` ${k.usedAt}` : ""}${usedIn ? `, ${usedIn}` : ""}`;
}

export function describe(k: KnownSong): string {
  const facts = [statusText(k, true), k.bpm ? `${k.bpm} BPM` : null].filter(Boolean).join(", ");
  return `${where(k)} "${k.title} — ${k.artist}" (${facts})`;
}

/**
 * Songs the same as each other across both tables, so a song held in both
 * counts once. "Same" is `compare`'s "same song".
 */
export function groupSongs(songs: KnownSong[]): KnownSong[][] {
  const groups: KnownSong[][] = [];
  for (const s of songs) {
    const g = groups.find((g) => g.some((o) => compare(o, s) === "same song"));
    if (g) g.push(s);
    else groups.push([s]);
  }
  return groups;
}

/* -------------------------------------------------------------------------- */
/* Vetting a batch before it is added                                         */
/* -------------------------------------------------------------------------- */

export type InputKind = "link" | "search" | "file";

/** What `fetchAudio` will do with an input, or why it can't. `files` false: only links and searches. */
export function inputKind(input: string, files = true): InputKind | string {
  if (/^https?:\/\/\S+$/.test(input)) return "link";
  if (/^ytsearch\d*:\s*\S/.test(input)) return "search";
  if (!files) return `input "${input}" is neither a link nor a "ytsearch1:" search`;
  const file = path.resolve(input);
  if (existsSync(file) && statSync(file).isFile()) return "file";
  return `input "${input}" is neither a link, a "ytsearch1:" search nor a file that exists (paths are from the repo folder)`;
}

export interface Vetted {
  n: number;
  title: string;
  artist: string;
  /** `songKey(title, artist).key`, to see what it was compared as. */
  key: string;
  verdict: string;
  blocked: boolean;
  /** Why it is blocked. */
  reasons: string[];
  /** Worth reading, not blocking. */
  notes: string[];
}

function knownVerdict(k: KnownSong): string {
  if (k.status === "used") return "already known (used)";
  if (k.table === "reel_tracks") return k.status === "disabled" ? "already in library (disabled)" : "already in library";
  return "already known (old catalogue, not used)";
}

/** The library before the old catalogue, and within each a used song before one in the library. */
const rank = (k: KnownSong) => (k.table === "reel_tracks" ? 0 : 10) + ["used", "in library", "disabled", "not used"].indexOf(k.status);

/** Each candidate against the known songs and the ones before it. `files` false refuses local files as input. */
export function vetSongs(list: unknown[], known: KnownSong[], opts: { files?: boolean } = {}): Vetted[] {
  const seen: (Comparable & { n: number; label: string })[] = [];

  return list.map((raw, i): Vetted => {
    const n = i + 1;
    const problems: string[] = [];
    const notes: string[] = [];
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { n, title: "", artist: "", key: "", verdict: "not ready", blocked: true, reasons: ["not a song: expected { input, title, artist, … }"], notes };
    }
    const song = raw as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const title = text(song.title);
    const artist = text(song.artist);

    // A misspelt field is lost without a word ("hok" drops the hook), so it blocks.
    for (const f of Object.keys(song)) {
      if (!SONG_FIELDS.has(f) && song[f] !== undefined) problems.push(`unknown field "${f}" (the fields are ${[...SONG_FIELDS].join(", ")})`);
    }
    if (!title) problems.push("missing title");
    if (!artist) problems.push("missing artist");

    const input = text(song.input);
    let kind: InputKind | null = null;
    if (!input) problems.push(`missing input (a YouTube link or a "ytsearch1:" search${opts.files === false ? "" : " or a file"})`);
    else {
      const k = inputKind(input, opts.files !== false);
      if (k === "link" || k === "search" || k === "file") kind = k;
      else problems.push(k);
    }
    const video = youtubeId(input) ?? youtubeId(text(song.source));
    if (kind === "link") notes.push(video ? `YouTube link (${video})` : "a link that is not YouTube: yt-dlp may still fetch it");
    if (kind === "search") notes.push("a search takes its first result; a link to the official audio is surer");
    if (kind === "file") notes.push("local file");

    if (song.hook === undefined || song.hook === "") {
      notes.push("no hook: it will be guessed from loudness, often a different chorus than reels use");
    } else if (typeof song.hook !== "string" && typeof song.hook !== "number") {
      problems.push('hook must be a time like "0:47" or a number of seconds');
    } else {
      try {
        const s = toSeconds(song.hook);
        if (s === undefined || !Number.isFinite(s) || s < 0) problems.push(`hook "${song.hook}" does not parse (use m:ss, e.g. "0:47")`);
        else {
          notes.push(`hook ${typeof song.hook === "number" ? mmss(s) : song.hook.trim()}`);
          if (s < 5) notes.push(`a hook at ${s} s is the very start of the song; "0:47" is written with a colon`);
          if (s > 8 * 60) notes.push(`a hook at ${mmss(s)} is later than most songs are long`);
        }
      } catch {
        problems.push(`hook "${song.hook}" does not parse (use m:ss, e.g. "0:47")`);
      }
    }
    if (song.tags !== undefined && typeof song.tags !== "string" && !(Array.isArray(song.tags) && song.tags.every((t) => typeof t === "string"))) {
      problems.push("tags must be a list of words or one comma-separated string");
    }
    if (song.language !== undefined && typeof song.language !== "string") problems.push("language must be a word, like punjabi");
    if (song.again !== undefined && typeof song.again !== "boolean") problems.push("again must be true or false");
    const again = song.again === true;

    const me: Comparable = { key: songKey(title, artist), video };

    // Within the batch: the first of two copies is judged on its own, the later one is the duplicate.
    const dupes: string[] = [];
    if (title && artist) {
      for (const o of seen) {
        const m = compare(me, o);
        if (m && blocks(m)) {
          dupes.push(`duplicate in batch: ${m} as no. ${o.n} (${o.label})`);
          break;
        }
      }
      seen.push({ ...me, n, label: `${title} — ${artist}` });
    }

    const matches =
      title && artist
        ? known
            .map((k) => ({ k, m: compare(me, k) }))
            .filter((x): x is { k: KnownSong; m: MatchKind } => x.m !== null)
            .sort((a, b) => rank(a.k) - rank(b.k))
        : [];
    const hard = matches.filter((x) => blocks(x.m));
    for (const { k } of matches.filter((x) => !blocks(x.m))) notes.push(`looks like ${describe(k)}: check it is a different song`);

    const reasons = [...problems, ...dupes];
    if (hard.length && again) {
      for (const { k, m } of hard) {
        const exact = k.table === "reel_tracks" && k.title === title && k.artist === artist;
        notes.push(`added again on purpose: ${m} as ${describe(k)}` + (exact ? `; replaces its audio and hook${k.status === "used" ? ", and it stays used" : ""}` : ""));
      }
    } else {
      for (const { k, m } of hard) reasons.push(`${m} as ${describe(k)}`);
    }
    if (again && !hard.length) notes.push('"again" is set but no known song matches; it makes no difference');

    const verdict = problems.length
      ? "not ready"
      : dupes.length
        ? "duplicate in batch"
        : hard.length && !again
          ? knownVerdict(hard[0].k)
          : hard.length
            ? "new (again, on purpose)"
            : "new";
    return { n, title, artist, key: me.key.key, verdict, blocked: reasons.length > 0, reasons, notes };
  });
}

/* -------------------------------------------------------------------------- */
/* Fetching, analysing and adding                                             */
/* -------------------------------------------------------------------------- */

/** A local audio file for `input`, downloading it into `tmp` first when it is a link or a search. */
export async function fetchAudio(input: string, tmp: string, signal?: AbortSignal): Promise<{ file: string; source: string | null; name: string | null }> {
  const isRemote = /^https?:\/\//.test(input) || /^ytsearch\d*:/.test(input);
  if (!isRemote) return { file: path.resolve(input), source: null, name: null };
  const printed = (
    await runYtDlp(
      [
        "-f", "bestaudio/best", "--no-playlist", "--quiet",
        "--max-filesize", "100M",
        "-o", path.join(tmp, "%(id)s.%(ext)s"),
        "--print", "after_move:%(title)s",
        "--print", "after_move:%(webpage_url)s",
        input,
      ],
      { signal, timeoutMs: 5 * 60_000 },
    )
  )
    .trim()
    .split(/\r?\n/);
  const file = (await readdir(tmp)).find((f) => !f.endsWith(".part"));
  if (!file) throw new Error("yt-dlp finished but left no file.");
  return { file: path.join(tmp, file), source: printed.at(-1) || null, name: printed.at(-2) || null };
}

export async function analyseFile(file: string, hook?: number) {
  const pcm = await decodeMono(file, SAMPLE_RATE);
  if (pcm.length < SAMPLE_RATE * 30) throw new Error("That audio is shorter than 30 seconds.");
  return analyseTrack(pcm, { hook });
}

/** The stretch of the full song that is kept: from `LEAD` s before the hook, `WINDOW` s long. */
export function stretchOf(full: TrackAnalysis) {
  const hook = full.hook ?? Math.min(30, full.duration / 3);
  let from = Math.max(0, hook - LEAD);
  const to = Math.min(full.duration, from + WINDOW);
  if (to - from < WINDOW) from = Math.max(0, to - WINDOW);
  return { hook, from, to };
}

/** What `check` finds in a song: nothing is saved. */
export async function checkSong(input: string, hook: string | number | undefined, signal?: AbortSignal) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "reel-song-"));
  try {
    const { file, source, name } = await fetchAudio(input, tmp, signal);
    const hookGiven = toSeconds(hook);
    const a = await analyseFile(file, hookGiven);
    const { from, to } = stretchOf(a);
    return { name, source, analysis: a, hookFound: hookGiven === undefined, from, to };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Says so before a song replaces a library row, or when it looks like a known
 * song under another spelling (which adds a second row instead). Neither is
 * stopped: a new cut or hook for a song is a normal thing to do.
 */
export function addWarnings(song: SongInput, known: KnownSong[]): string[] {
  const title = song.title.trim();
  const artist = song.artist.trim();
  const me: Comparable = { key: songKey(title, artist), video: youtubeId(song.input) ?? youtubeId(song.source) };
  const out: string[] = [];
  const exact = known.find((k) => k.table === "reel_tracks" && k.title === title && k.artist === artist);
  if (exact) {
    const after = exact.status === "used" ? "; it stays used" : exact.status === "disabled" ? "; it goes back into rotation" : "";
    out.push(`replaces ${describe(exact)}: new audio, hook and beats${after}`);
  }
  for (const k of known) {
    if (k === exact) continue;
    const m = compare(me, k);
    if (!m) continue;
    const second =
      k.table === "reel_tracks" && !exact && blocks(m)
        ? ". This adds a second library row; to replace that one, use its title and artist exactly as stored"
        : "";
    out.push(`${m} as ${describe(k)}${second}`);
  }
  return out;
}

export interface Added {
  id: number;
  title: string;
  artist: string;
  /** The upload's own name, when it came from a link or a search. */
  from: string | null;
  source: string | null;
  bpm: number;
  beats: number;
  hook: number;
  hookFound: boolean;
  stretch: [number, number];
  kb: number;
}

/** Adds one song (or replaces the row with its exact title and artist). `known` gets it too, for the rest of a batch. */
export async function addSong(song: SongInput, known: KnownSong[], signal?: AbortSignal): Promise<Added> {
  if (!song.title || !song.artist) throw new Error("Every song needs a title and an artist.");
  const tmp = await mkdtemp(path.join(os.tmpdir(), "reel-song-"));
  try {
    const { file, source, name } = await fetchAudio(song.input, tmp, signal);
    const hookGiven = toSeconds(song.hook);
    const full = await analyseFile(file, hookGiven);

    const { hook, from, to } = stretchOf(full);
    const clip = sliceAnalysis(full, from, to);

    const out = path.join(tmp, "clip.m4a");
    await runFfmpeg([
      "-y", "-ss", from.toFixed(3), "-t", (to - from).toFixed(3), "-i", file,
      "-vn", "-ac", "2", "-ar", "44100", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out,
    ]);
    const audio = await readFile(out);

    const tags = Array.isArray(song.tags)
      ? song.tags
      : (song.tags ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
    const values = {
      title: song.title.trim(),
      artist: song.artist.trim(),
      language: (song.language ?? "punjabi").trim().toLowerCase(),
      tags,
      bpm: full.bpm,
      source: song.source ?? source ?? (/^https?:/.test(song.input) ? song.input : null),
      windowStart: Math.round(from * 1000) / 1000,
      duration: Math.round((to - from) * 1000) / 1000,
      audio,
      audioMime: "audio/mp4",
      analysis: clip,
      active: true,
    };
    const [row] = await db
      .insert(reelTracks)
      .values(values)
      .onConflictDoUpdate({ target: [reelTracks.title, reelTracks.artist], set: values })
      .returning({ id: reelTracks.id });

    // The rest of a batch compares against this song too.
    const existing = known.find((k) => k.table === "reel_tracks" && k.id === row.id);
    if (existing) {
      if (existing.status === "disabled") existing.status = "in library";
      existing.bpm = full.bpm;
    } else {
      known.push({
        table: "reel_tracks",
        id: row.id,
        title: values.title,
        artist: values.artist,
        language: values.language,
        bpm: full.bpm,
        status: "in library",
        usedAt: null,
        usedIn: null,
        source: values.source,
        added: new Date().toISOString().slice(0, 10),
        key: songKey(values.title, values.artist),
        video: youtubeId(values.source),
      });
    }
    return {
      id: row.id,
      title: values.title,
      artist: values.artist,
      from: name,
      source: values.source,
      bpm: full.bpm,
      beats: clip.beats.length,
      hook,
      hookFound: hookGiven === undefined,
      stretch: [from, to],
      kb: Math.round(audio.length / 1024),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
