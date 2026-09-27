/**
 * The reel song library, from a local machine. See docs/reels/procedure.md.
 *
 *   npm run songs -- known [--json]                every song the database knows, used or not
 *   npm run songs -- vet <songs.json> [--json]     a candidate batch against those; nothing fetched or saved
 *   npm run songs -- check <file | link | "ytsearch1:query"> [--hook 0:47]
 *                                                  analyse only: tempo, beats, hook, the stretch kept; nothing saved
 *   npm run songs -- add <file | YouTube link | "ytsearch1:query"> --title "…" --artist "…"
 *                        [--language punjabi] [--tags "wedding,festive"] [--hook 0:47] [--source <url>]
 *   npm run songs -- batch <songs.json>            many at once (same fields, see the procedure)
 *   npm run songs -- list
 *   npm run songs -- disable <id> | enable <id> | remove <id>
 *   npm run songs -- free <id>                     put a used song back in the library
 *
 * Adding a song: fetch the audio (yt-dlp, when given a link or a search),
 * measure its beats, keep ~70 s around its hook as AAC, and store both in
 * `reel_tracks`. Adding the same title and artist again replaces the row
 * (a song that has made a reel stays used).
 *
 * Each song makes one reel: once a reel is made with it, it leaves the
 * library (`used` in the list). `free` puts it back.
 *
 * Known songs are the library's (`reel_tracks`, used or not) and, when that
 * table exists, the catalogue the experiment in harness_experimentation/ left
 * (`reel_songs`): a song either one has held should not be suggested again.
 * Every comparison goes through `songKey`, so `known`, `vet`, `add` and `batch`
 * agree on what counts as the same song.
 *
 * Needs ffmpeg (the one npm installed is used) and, for links, yt-dlp on PATH
 * or as a Python module (`pip install yt-dlp`).
 */
import { spawnSync } from "node:child_process";
import { config } from "dotenv";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TrackAnalysis } from "../src/lib/reels/beats";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

/** Seconds of song kept per track: enough for the longest reel plus room to choose where it starts. */
const WINDOW = 70;
/** How far before the hook the kept stretch begins, so a reel can open on the build-up. */
const LEAD = 8;

interface SongInput {
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

const SONG_FIELDS = new Set(["input", "title", "artist", "language", "tags", "hook", "source", "again"]);

/** Flags that take no value, so `vet --json songs.json` doesn't read the file name as the flag's value. */
const SWITCHES = new Set(["json"]);

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      if (SWITCHES.has(name)) {
        flags[name] = "true";
        continue;
      }
      flags[name] = argv[i + 1] ?? "";
      i++;
    } else pos.push(a);
  }
  return { pos, flags };
}

/** "0:47", "1:05.5" or "47" → seconds. */
function toSeconds(v: string | number | undefined): number | undefined {
  if (v === undefined || v === "") return undefined;
  if (typeof v === "number") return v;
  const parts = v.split(":").map(Number);
  if (parts.some((p) => Number.isNaN(p))) throw new Error(`Not a time: ${v}`);
  return parts.reduce((s, p) => s * 60 + p, 0);
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

interface SongKey {
  /** The title's words: lowercase, no accents, punctuation or upload noise. */
  title: string;
  artists: string[];
  /** `title|artist, artist`: what `known` shows and what de-duplication is about. */
  key: string;
  /** `title`, loosely spelled. */
  loose: string;
}

/** The de-duplication key for a song. The one helper every command compares with. */
function songKey(title: string, artist: string): SongKey {
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
function youtubeId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

interface Comparable {
  key: SongKey;
  video: string | null;
}

type MatchKind = "same song" | "same title" | "same upload" | "spelled alike" | "looks like";

/**
 * How `a` relates to `b`, if at all. Everything but "looks like" means the
 * same song for vetting: a known title by other artists is usually the same
 * song under another spelling, and the owner can say otherwise ("again").
 */
function compare(a: Comparable, b: Comparable): MatchKind | null {
  const artist = sameArtist(a.key.artists, b.key.artists);
  if (a.key.title === b.key.title) return artist ? "same song" : "same title";
  if (a.video && a.video === b.video) return "same upload";
  if (!artist) return null;
  if (a.key.loose === b.key.loose) return "spelled alike";
  const [short, long] = a.key.title.length <= b.key.title.length ? [a.key.title, b.key.title] : [b.key.title, a.key.title];
  if (short.length >= 4 && ` ${long} `.includes(` ${short} `)) return "looks like";
  return null;
}

const blocks = (m: MatchKind) => m !== "looks like";

/* -------------------------------------------------------------------------- */
/* What the database knows                                                    */
/* -------------------------------------------------------------------------- */

interface KnownSong extends Comparable {
  table: "reel_tracks" | "reel_songs";
  id: number;
  title: string;
  artist: string;
  language: string | null;
  bpm: number | null;
  status: "in library" | "used" | "disabled" | "not used";
  /** YYYY-MM-DD. */
  usedAt: string | null;
  /** The reel that used it: a job id in the library, a file the experiment wrote in the old catalogue. */
  usedIn: string | null;
  source: string | null;
  added: string | null;
}

const day = (v: unknown) => (v == null || v === "" ? null : String(v).slice(0, 10));

/**
 * Every song in `reel_tracks` and, when it exists, `reel_songs`. Read only.
 * `reel_songs` is optional: another database may never have had the experiment.
 */
async function loadKnown(): Promise<{ songs: KnownSong[]; catalogue: string | null }> {
  const { db } = await import("../src/db");
  const { reelTracks } = await import("../src/db/schema");
  const { asc, sql } = await import("drizzle-orm");

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
    usedIn: r.usedAt && r.usedByJob != null ? `reel ${r.usedByJob}` : null,
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

const where = (k: KnownSong) => (k.table === "reel_tracks" ? `library #${k.id}` : `old catalogue #${k.id}`);

/** "used 2026-09-27, reel 7". `short` keeps only the file name of an old-catalogue reel. */
function statusText(k: KnownSong, short = false): string {
  if (k.status !== "used") return k.status;
  const usedIn = k.usedIn && short ? path.win32.basename(k.usedIn) : k.usedIn;
  return `used${k.usedAt ? ` ${k.usedAt}` : ""}${usedIn ? `, ${usedIn}` : ""}`;
}

function describe(k: KnownSong): string {
  const facts = [statusText(k, true), k.bpm ? `${k.bpm} BPM` : null].filter(Boolean).join(", ");
  return `${where(k)} "${k.title} — ${k.artist}" (${facts})`;
}

/**
 * Songs the same as each other across both tables, so a song held in both
 * counts once. "Same" is `compare`'s "same song".
 */
function groupSongs(songs: KnownSong[]): KnownSong[][] {
  const groups: KnownSong[][] = [];
  for (const s of songs) {
    const g = groups.find((g) => g.some((o) => compare(o, s) === "same song"));
    if (g) g.push(s);
    else groups.push([s]);
  }
  return groups;
}

/** A plain fixed-width table: easier to read and to copy from than console.table's. */
function printTable(rows: Record<string, string>[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => r[c].length)));
  const line = (cells: string[]) => cells.map((v, i) => v.padEnd(width[i])).join("  ").trimEnd();
  console.log(line(cols));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function known(json: boolean) {
  const { songs, catalogue } = await loadKnown();

  if (json) {
    console.log(
      JSON.stringify(
        songs.map((k) => ({
          table: k.table,
          id: k.id,
          title: k.title,
          artist: k.artist,
          language: k.language,
          bpm: k.bpm,
          status: k.status,
          usedAt: k.usedAt,
          usedIn: k.usedIn,
          source: k.source,
          added: k.added,
          key: k.key.key,
          titleKey: k.key.title,
        })),
        null,
        2,
      ),
    );
    return;
  }

  const library = songs.filter((k) => k.table === "reel_tracks");
  const old = songs.filter((k) => k.table === "reel_songs");
  const left = library.filter((k) => k.status === "in library");

  console.log(`Library (reel_tracks): ${library.length} songs, ${left.length} left for new reels\n`);
  printTable(
    library.map((k) => ({
      id: String(k.id),
      title: clip(k.title, 28),
      artist: clip(k.artist, 26),
      language: k.language ?? "",
      bpm: k.bpm == null ? "" : String(k.bpm),
      status: statusText(k),
      source: k.source ?? "",
      added: k.added ?? "",
      key: k.key.key,
    })),
  );

  if (catalogue) console.log(`\nOld catalogue: ${catalogue}`);
  else {
    const oldUsed = old.filter((k) => k.status === "used").length;
    console.log(`\nOld catalogue (reel_songs, from harness_experimentation/): ${old.length} songs, ${oldUsed} used\n`);
    printTable(
      old.map((k) => ({
        id: String(k.id),
        title: clip(k.title, 28),
        artist: clip(k.artist, 26),
        status: statusText(k, true),
        source: k.source ?? "",
        added: k.added ?? "",
        key: k.key.key,
      })),
    );
  }

  const groups = groupSongs(songs);
  const used = groups.filter((g) => g.some((k) => k.status === "used")).length;
  console.log(`\n${groups.length} known, ${used} used, ${left.length} left for new reels.`);

  // A library song the experiment already made a reel with may have been posted already.
  const stale = groups
    .filter((g) => g.some((k) => k.table === "reel_songs" && k.status === "used"))
    .flatMap((g) => g.filter((k) => k.table === "reel_tracks" && k.status === "in library"));
  if (stale.length) {
    console.log(
      `Still in the library but already used by the old catalogue: ${stale.map((k) => `${k.title} (#${k.id})`).join(", ")}.`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Vetting a batch before it is added                                         */
/* -------------------------------------------------------------------------- */

/** A songs.json file: a list of `SongInput`. A byte-order mark (PowerShell writes one) is dropped. */
function readSongs(file: string): unknown[] {
  if (!existsSync(file)) throw new Error(`No file at ${file}.`);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch (e) {
    throw new Error(`${file} could not be read as JSON: ${errorText(e)}`);
  }
  if (!Array.isArray(data)) throw new Error(`${file} must hold a list: [ { "input": …, "title": …, "artist": … }, … ]`);
  return data;
}

type InputKind = "link" | "search" | "file";

/** What `fetchAudio` will do with an input, or why it can't. */
function inputKind(input: string): InputKind | string {
  if (/^https?:\/\/\S+$/.test(input)) return "link";
  if (/^ytsearch\d*:\s*\S/.test(input)) return "search";
  const file = path.resolve(input);
  if (existsSync(file) && statSync(file).isFile()) return "file";
  return `input "${input}" is neither a link, a "ytsearch1:" search nor a file that exists (paths are from the repo folder)`;
}

interface Vetted {
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
const rank = (k: KnownSong) =>
  (k.table === "reel_tracks" ? 0 : 10) + ["used", "in library", "disabled", "not used"].indexOf(k.status);

function vetSongs(list: unknown[], known: KnownSong[]): Vetted[] {
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
      if (!SONG_FIELDS.has(f)) problems.push(`unknown field "${f}" (the fields are ${[...SONG_FIELDS].join(", ")})`);
    }
    if (!title) problems.push("missing title");
    if (!artist) problems.push("missing artist");

    const input = text(song.input);
    let kind: InputKind | null = null;
    if (!input) problems.push("missing input (a YouTube link, a \"ytsearch1:\" search or a file)");
    else {
      const k = inputKind(input);
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
      problems.push('tags must be a list of words or one comma-separated string');
    }
    if (song.language !== undefined && typeof song.language !== "string") problems.push("language must be a word, like punjabi");
    if (song.again !== undefined && typeof song.again !== "boolean") problems.push('again must be true or false');
    const again = song.again === true;

    const me: Comparable = { key: songKey(title, artist), video };

    // Within the file: the first of two copies is judged on its own, the later one is the duplicate.
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

    const matches = title && artist
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
        notes.push(
          `added again on purpose: ${m} as ${describe(k)}` +
            (exact ? `; replaces its audio and hook${k.status === "used" ? ", and it stays used" : ""}` : ""),
        );
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

/** Exit code: 1 when any candidate is blocked, so an agent can gate `batch` on it. */
async function vet(file: string, json: boolean): Promise<number> {
  const list = readSongs(file);
  const { songs, catalogue } = await loadKnown();
  const results = vetSongs(list, songs);
  const blocked = results.filter((r) => r.blocked).length;

  if (json) {
    console.log(JSON.stringify(results, null, 2));
    return blocked ? 1 : 0;
  }

  const library = songs.filter((k) => k.table === "reel_tracks").length;
  console.log(
    `Vetting ${results.length} song${results.length === 1 ? "" : "s"} from ${file} against ${library} in the library` +
      (catalogue ? ` (${catalogue})` : ` and ${songs.length - library} in the old catalogue`) +
      ". Nothing is fetched or saved.\n",
  );
  for (const r of results) {
    console.log(`${r.n}. ${r.title || "(no title)"} — ${r.artist || "(no artist)"}${r.key ? `  [${r.key}]` : ""}`);
    console.log(`   ${r.blocked ? "BLOCKED" : "ok"}: ${r.verdict}`);
    for (const why of r.reasons) console.log(`   - ${why}`);
    for (const note of r.notes) console.log(`   · ${note}`);
  }
  console.log(`\n${results.length - blocked} ready, ${blocked} blocked.`);
  if (blocked) {
    console.log(
      'Drop or fix the blocked songs and vet again. A known song the owner wants in anyway (new audio or hook, or a different song with a known title) takes "again": true.',
    );
  } else console.log(`Next: check each song, then npm run songs -- batch ${file}`);
  return blocked ? 1 : 0;
}

/* -------------------------------------------------------------------------- */
/* Fetching, analysing and adding                                             */
/* -------------------------------------------------------------------------- */

function ytDlp(): string[] | null {
  for (const cmd of [["yt-dlp"], ["py", "-m", "yt_dlp"], ["python", "-m", "yt_dlp"], ["python3", "-m", "yt_dlp"]]) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), "--version"], { encoding: "utf8" });
    if (r.status === 0) return cmd;
  }
  return null;
}

/** A local audio file for `input`, downloading it first when it is a link or a search. */
function fetchAudio(input: string, tmp: string): { file: string; source: string | null; name: string | null } {
  const isRemote = /^https?:\/\//.test(input) || /^ytsearch\d*:/.test(input);
  if (!isRemote) return { file: path.resolve(input), source: null, name: null };

  const cmd = ytDlp();
  if (!cmd) throw new Error("yt-dlp is not installed. Run: pip install yt-dlp  (or download the audio yourself and pass the file)");
  const r = spawnSync(
    cmd[0],
    [
      ...cmd.slice(1),
      "--js-runtimes", "node",
      "-f", "bestaudio/best", "--no-playlist", "--quiet", "--no-warnings",
      "-o", path.join(tmp, "%(id)s.%(ext)s"),
      "--print", "after_move:%(title)s",
      "--print", "after_move:%(webpage_url)s",
      input,
    ],
    // UTF-8 so an upload's title in Gurmukhi or Devanagari survives the Windows console codepage.
    { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } },
  );
  if (r.status !== 0) throw new Error(`yt-dlp failed: ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
  const file = readdirSync(tmp).find((f) => !f.endsWith(".part"));
  if (!file) throw new Error("yt-dlp finished but left no file.");
  const printed = r.stdout.trim().split(/\r?\n/);
  return { file: path.join(tmp, file), source: printed.at(-1) || null, name: printed.at(-2) || null };
}

async function analyseFile(file: string, hook?: number) {
  const { analyseTrack, SAMPLE_RATE } = await import("../src/lib/reels/beats");
  const { decodeMono } = await import("../src/lib/reels/ffmpeg");
  const pcm = await decodeMono(file, SAMPLE_RATE);
  if (pcm.length < SAMPLE_RATE * 30) throw new Error("That audio is shorter than 30 seconds.");
  return analyseTrack(pcm, { hook });
}

/** The stretch of the full song that is kept: from `LEAD` s before the hook, `WINDOW` s long. */
function stretchOf(full: TrackAnalysis) {
  const hook = full.hook ?? Math.min(30, full.duration / 3);
  let from = Math.max(0, hook - LEAD);
  const to = Math.min(full.duration, from + WINDOW);
  if (to - from < WINDOW) from = Math.max(0, to - WINDOW);
  return { hook, from, to };
}

/**
 * Says so before a song replaces a library row, or when it looks like a known
 * song under another spelling (which adds a second row instead). Neither is
 * stopped: a new cut or hook for a song is a normal thing to do.
 */
function warnBeforeAdding(song: SongInput, known: KnownSong[]) {
  const title = song.title.trim();
  const artist = song.artist.trim();
  const me: Comparable = { key: songKey(title, artist), video: youtubeId(song.input) ?? youtubeId(song.source) };
  const exact = known.find((k) => k.table === "reel_tracks" && k.title === title && k.artist === artist);
  if (exact) {
    const after = exact.status === "used" ? "; it stays used" : exact.status === "disabled" ? "; it goes back into rotation" : "";
    console.log(`  warning: replaces ${describe(exact)}: new audio, hook and beats${after}`);
  }
  for (const k of known) {
    if (k === exact) continue;
    const m = compare(me, k);
    if (!m) continue;
    const second = k.table === "reel_tracks" && !exact && blocks(m)
      ? ". This adds a second library row; to replace that one, use its title and artist exactly as stored"
      : "";
    console.log(`  warning: ${m} as ${describe(k)}${second}`);
  }
}

async function addSong(song: SongInput, known: KnownSong[]) {
  const { sliceAnalysis } = await import("../src/lib/reels/beats");
  const { runFfmpeg } = await import("../src/lib/reels/ffmpeg");
  const { db } = await import("../src/db");
  const { reelTracks } = await import("../src/db/schema");

  if (!song.title || !song.artist) throw new Error("Every song needs --title and --artist.");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "reel-song-"));
  try {
    console.log(`\n• ${song.title} — ${song.artist}`);
    warnBeforeAdding(song, known);
    const { file, source, name } = fetchAudio(song.input, tmp);
    if (name) console.log(`  from: ${name}`);
    const hookGiven = toSeconds(song.hook);
    const full = await analyseFile(file, hookGiven);

    const { hook, from, to } = stretchOf(full);
    const clip = sliceAnalysis(full, from, to);

    const out = path.join(tmp, "clip.m4a");
    await runFfmpeg([
      "-y", "-ss", from.toFixed(3), "-t", (to - from).toFixed(3), "-i", file,
      "-vn", "-ac", "2", "-ar", "44100", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", out,
    ]);
    const audio = readFileSync(out);

    const tags = Array.isArray(song.tags)
      ? song.tags
      : (song.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
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

    console.log(
      `  saved #${row.id}: ${full.bpm} BPM, ${clip.beats.length} beats kept, ` +
        `hook ${mmss(hook)}${hookGiven === undefined ? " (found)" : ""}, ` +
        `stretch ${mmss(from)}–${mmss(to)}, ${(audio.length / 1024).toFixed(0)} KB`,
    );
    return row.id;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);

  if (command === "known") {
    await known(flags.json === "true");
  } else if (command === "vet") {
    if (!pos[0]) throw new Error("Usage: npm run songs -- vet <songs.json> [--json]");
    return vet(pos[0], flags.json === "true");
  } else if (command === "add") {
    if (!pos[0]) throw new Error('Usage: npm run songs -- add <file|link|"ytsearch1:query"> --title "…" --artist "…"');
    const { songs } = await loadKnown();
    await addSong(
      {
        input: pos[0],
        title: flags.title,
        artist: flags.artist,
        language: flags.language,
        tags: flags.tags,
        hook: flags.hook,
        source: flags.source,
      },
      songs,
    );
  } else if (command === "batch") {
    if (!pos[0]) throw new Error("Usage: npm run songs -- batch <songs.json>");
    const list = readSongs(pos[0]) as SongInput[];
    const { songs } = await loadKnown();
    let ok = 0;
    const failed: string[] = [];
    for (const song of list) {
      try {
        await addSong(song, songs);
        ok++;
      } catch (e) {
        failed.push(`${song.title} — ${errorText(e)}`);
        console.log(`  FAILED: ${errorText(e)}`);
      }
    }
    console.log(`\n${ok} of ${list.length} added.${failed.length ? `\nFailed:\n  ${failed.join("\n  ")}` : ""}`);
  } else if (command === "check") {
    if (!pos[0]) throw new Error('Usage: npm run songs -- check <file | link | "ytsearch1:query"> [--hook 0:47]');
    const tmp = mkdtempSync(path.join(os.tmpdir(), "reel-song-"));
    try {
      const { file, source, name } = fetchAudio(pos[0], tmp);
      if (name || source) console.log(`${name ?? ""}${source ? `  ${source}` : ""}`.trim());
      const hookGiven = toSeconds(flags.hook);
      const a = await analyseFile(file, hookGiven);
      const { from, to } = stretchOf(a);
      console.log(
        `${a.bpm} BPM · ${a.beats.length} beats · first bar at beat ${a.downbeat} · ` +
          `${a.phrases.length} phrases · ${a.lifts.length} lifts · ` +
          `hook ${a.hook == null ? "none" : `${mmss(a.hook)}${hookGiven === undefined ? " (found)" : ""}`} · ${mmss(a.duration)} long`,
      );
      console.log(`Adding it would keep ${mmss(from)}–${mmss(to)}. Nothing was saved.`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  } else if (command === "list") {
    const { db } = await import("../src/db");
    const { reelTracks } = await import("../src/db/schema");
    const { asc } = await import("drizzle-orm");
    const rows = await db
      .select({
        id: reelTracks.id,
        title: reelTracks.title,
        artist: reelTracks.artist,
        language: reelTracks.language,
        bpm: reelTracks.bpm,
        active: reelTracks.active,
        renders: reelTracks.useCount,
        usedAt: reelTracks.usedAt,
        reel: reelTracks.usedByJob,
        added: reelTracks.createdAt,
      })
      .from(reelTracks)
      .orderBy(asc(reelTracks.id));
    const left = rows.filter((r) => r.active && !r.usedAt).length;
    console.table(
      rows.map((r) => ({
        ...r,
        usedAt: r.usedAt ? r.usedAt.toISOString().slice(0, 10) : "",
        reel: r.reel ?? "",
        added: r.added.toISOString().slice(0, 10),
      })),
    );
    console.log(`${left} of ${rows.length} songs left for new reels.`);
  } else if (command === "free") {
    const id = Number(pos[0]);
    if (!Number.isInteger(id)) throw new Error("Usage: npm run songs -- free <id>");
    const { db } = await import("../src/db");
    const { reelTracks } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    await db.update(reelTracks).set({ usedAt: null, usedByJob: null }).where(eq(reelTracks.id, id));
    console.log(`Song #${id} is back in the library.`);
  } else if (command === "disable" || command === "enable" || command === "remove") {
    const id = Number(pos[0]);
    if (!Number.isInteger(id)) throw new Error(`Usage: npm run songs -- ${command} <id>`);
    const { db } = await import("../src/db");
    const { reelTracks } = await import("../src/db/schema");
    const { eq } = await import("drizzle-orm");
    if (command === "remove") await db.delete(reelTracks).where(eq(reelTracks.id, id));
    else await db.update(reelTracks).set({ active: command === "enable" }).where(eq(reelTracks.id, id));
    console.log(`Song #${id}: ${command}d.`);
  } else {
    console.log(`Reel song library. Commands:
  known [--json]              every song the database knows (the library, and the old catalogue
                              when it exists), used or not. Run it before suggesting songs.
  vet <songs.json> [--json]   a candidate batch against those: known or used songs, duplicates,
                              missing fields, bad hooks or inputs. Nothing is fetched or saved;
                              exits 1 when any song is blocked.
  check <file | link | "ytsearch1:query"> [--hook 0:47]
                              tempo, beats, hook and the stretch that would be kept; nothing saved
  add <file | link | "ytsearch1:query"> --title "…" --artist "…" [--language punjabi] [--tags "a,b"] [--hook 0:47] [--source <url>]
  batch <songs.json>          add many (the fields of add, plus "again": true for a known song on purpose)
  list                        the library, with how many renders each song had
  disable <id> | enable <id> | remove <id>
  free <id>                   put a used song back in the library
See docs/reels/procedure.md.`);
    return command && !["help", "--help", "-h"].includes(command) ? 1 : 0;
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`\n${errorText(e)}`);
    process.exit(1);
  },
);
