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
 * agree on what counts as the same song. Those rules live in
 * src/lib/reels/songs.ts, which Seelie's songs tool uses too.
 *
 * Needs ffmpeg (the one npm installed is used) and, for links, yt-dlp
 * (YTDLP_PATH, on PATH, or as a Python module: `pip install yt-dlp`).
 */
import { config } from "dotenv";
import { existsSync, readFileSync } from "node:fs";

// The database connects on first use, after these have run.
import {
  addSong,
  addWarnings,
  checkSong,
  errorText,
  groupSongs,
  loadKnown,
  mmss,
  statusText,
  vetSongs,
  type KnownSong,
  type SongInput,
} from "../src/lib/reels/songs";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

/** Adds a song, saying what it replaces or resembles first and what was kept after. */
async function addAndSay(song: SongInput, known: KnownSong[]) {
  console.log(`
• ${song.title} — ${song.artist}`);
  if (song.title && song.artist) for (const w of addWarnings(song, known)) console.log(`  warning: ${w}`);
  const r = await addSong(song, known);
  if (r.from) console.log(`  from: ${r.from}`);
  console.log(
    `  saved #${r.id}: ${r.bpm} BPM, ${r.beats} beats kept, ` +
      `hook ${mmss(r.hook)}${r.hookFound ? " (found)" : ""}, ` +
      `stretch ${mmss(r.stretch[0])}–${mmss(r.stretch[1])}, ${r.kb} KB`,
  );
}

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
    await addAndSay(
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
        await addAndSay(song, songs);
        ok++;
      } catch (e) {
        failed.push(`${song.title} — ${errorText(e)}`);
        console.log(`  FAILED: ${errorText(e)}`);
      }
    }
    console.log(`\n${ok} of ${list.length} added.${failed.length ? `\nFailed:\n  ${failed.join("\n  ")}` : ""}`);
  } else if (command === "check") {
    if (!pos[0]) throw new Error('Usage: npm run songs -- check <file | link | "ytsearch1:query"> [--hook 0:47]');
    const { name, source, analysis: a, hookFound, from, to } = await checkSong(pos[0], flags.hook);
    if (name || source) console.log(`${name ?? ""}${source ? `  ${source}` : ""}`.trim());
    console.log(
      `${a.bpm} BPM · ${a.beats.length} beats · first bar at beat ${a.downbeat} · ` +
        `${a.phrases.length} phrases · ${a.lifts.length} lifts · ` +
        `hook ${a.hook == null ? "none" : `${mmss(a.hook)}${hookFound ? " (found)" : ""}`} · ${mmss(a.duration)} long`,
    );
    console.log(`Adding it would keep ${mmss(from)}–${mmss(to)}. Nothing was saved.`);
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
