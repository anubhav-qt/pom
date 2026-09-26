/**
 * The reel song library, from a local machine. See docs/reels/procedure.md.
 *
 *   npm run songs -- add <file | YouTube link | "ytsearch1:query"> --title "…" --artist "…"
 *                        [--language punjabi] [--tags "wedding,festive"] [--hook 0:47] [--source <url>]
 *   npm run songs -- batch <songs.json>     many at once (same fields, see the procedure)
 *   npm run songs -- check <file> [--hook 0:47]   analyse only: tempo, beats, hook; nothing saved
 *   npm run songs -- list
 *   npm run songs -- disable <id> | enable <id> | remove <id>
 *
 * Adding a song: fetch the audio (yt-dlp, when given a link or a search),
 * measure its beats, keep ~70 s around its hook as AAC, and store both in
 * `reel_tracks`. Adding the same title and artist again replaces the row.
 *
 * Needs ffmpeg (the one npm installed is used) and, for links, yt-dlp on PATH
 * or as a Python module (`pip install yt-dlp`).
 */
import { spawnSync } from "node:child_process";
import { config } from "dotenv";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

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
}

function parseArgs(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      flags[a.slice(2)] = argv[i + 1] ?? "";
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

function ytDlp(): string[] | null {
  for (const cmd of [["yt-dlp"], ["py", "-m", "yt_dlp"], ["python", "-m", "yt_dlp"], ["python3", "-m", "yt_dlp"]]) {
    const r = spawnSync(cmd[0], [...cmd.slice(1), "--version"], { encoding: "utf8" });
    if (r.status === 0) return cmd;
  }
  return null;
}

/** A local audio file for `input`, downloading it first when it is a link or a search. */
function fetchAudio(input: string, tmp: string): { file: string; source: string | null } {
  const isRemote = /^https?:\/\//.test(input) || /^ytsearch\d*:/.test(input);
  if (!isRemote) return { file: path.resolve(input), source: null };

  const cmd = ytDlp();
  if (!cmd) throw new Error("yt-dlp is not installed. Run: pip install yt-dlp  (or download the audio yourself and pass the file)");
  const r = spawnSync(
    cmd[0],
    [
      ...cmd.slice(1),
      "-f", "bestaudio/best", "--no-playlist", "--quiet", "--no-warnings",
      "-o", path.join(tmp, "%(id)s.%(ext)s"),
      "--print", "after_move:%(webpage_url)s",
      input,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`yt-dlp failed: ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
  const file = readdirSync(tmp).find((f) => !f.endsWith(".part"));
  if (!file) throw new Error("yt-dlp finished but left no file.");
  return { file: path.join(tmp, file), source: r.stdout.trim().split("\n").pop() || null };
}

async function analyseFile(file: string, hook?: number) {
  const { analyseTrack, SAMPLE_RATE } = await import("../src/lib/reels/beats");
  const { decodeMono } = await import("../src/lib/reels/ffmpeg");
  const pcm = await decodeMono(file, SAMPLE_RATE);
  if (pcm.length < SAMPLE_RATE * 30) throw new Error("That audio is shorter than 30 seconds.");
  return analyseTrack(pcm, { hook });
}

async function addSong(song: SongInput) {
  const { sliceAnalysis } = await import("../src/lib/reels/beats");
  const { runFfmpeg } = await import("../src/lib/reels/ffmpeg");
  const { db } = await import("../src/db");
  const { reelTracks } = await import("../src/db/schema");

  if (!song.title || !song.artist) throw new Error("Every song needs --title and --artist.");
  const tmp = mkdtempSync(path.join(os.tmpdir(), "reel-song-"));
  try {
    console.log(`\n• ${song.title} — ${song.artist}`);
    const { file, source } = fetchAudio(song.input, tmp);
    const hookGiven = toSeconds(song.hook);
    const full = await analyseFile(file, hookGiven);

    const hook = full.hook ?? Math.min(30, full.duration / 3);
    let from = Math.max(0, hook - LEAD);
    const to = Math.min(full.duration, from + WINDOW);
    if (to - from < WINDOW) from = Math.max(0, to - WINDOW);
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

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);

  if (command === "add") {
    if (!pos[0]) throw new Error('Usage: npm run songs -- add <file|link|"ytsearch1:query"> --title "…" --artist "…"');
    await addSong({
      input: pos[0],
      title: flags.title,
      artist: flags.artist,
      language: flags.language,
      tags: flags.tags,
      hook: flags.hook,
      source: flags.source,
    });
  } else if (command === "batch") {
    if (!pos[0]) throw new Error("Usage: npm run songs -- batch <songs.json>");
    const list = JSON.parse(readFileSync(pos[0], "utf8")) as SongInput[];
    let ok = 0;
    const failed: string[] = [];
    for (const song of list) {
      try {
        await addSong(song);
        ok++;
      } catch (e) {
        failed.push(`${song.title} — ${e instanceof Error ? e.message : e}`);
        console.log(`  FAILED: ${e instanceof Error ? e.message : e}`);
      }
    }
    console.log(`\n${ok} of ${list.length} added.${failed.length ? `\nFailed:\n  ${failed.join("\n  ")}` : ""}`);
  } else if (command === "check") {
    if (!pos[0]) throw new Error("Usage: npm run songs -- check <file> [--hook 0:47]");
    const tmp = mkdtempSync(path.join(os.tmpdir(), "reel-song-"));
    try {
      const { file } = fetchAudio(pos[0], tmp);
      const a = await analyseFile(file, toSeconds(flags.hook));
      console.log(
        `${a.bpm} BPM · ${a.beats.length} beats · first bar at beat ${a.downbeat} · ` +
          `${a.phrases.length} phrases · ${a.lifts.length} lifts · hook ${a.hook == null ? "none" : mmss(a.hook)} · ${mmss(a.duration)} long`,
      );
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
        used: reelTracks.useCount,
        lastUsed: reelTracks.lastUsedAt,
        added: reelTracks.createdAt,
      })
      .from(reelTracks)
      .orderBy(asc(reelTracks.id));
    console.table(
      rows.map((r) => ({
        ...r,
        lastUsed: r.lastUsed ? r.lastUsed.toISOString().slice(0, 10) : "",
        added: r.added.toISOString().slice(0, 10),
      })),
    );
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
  add <file | link | "ytsearch1:query"> --title "…" --artist "…" [--language punjabi] [--tags "a,b"] [--hook 0:47] [--source <url>]
  batch <songs.json>
  check <file | link> [--hook 0:47]
  list
  disable <id> | enable <id> | remove <id>
See docs/reels/procedure.md.`);
    process.exit(command ? 1 : 0);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
