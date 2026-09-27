/**
 * The answers to "Do you like this reel?", for tuning the directing prompt.
 * See docs/reels/feedback.md.
 *
 *   npm run reels:feedback                       like rate per prompt version, what liked and disliked reels had in common, the latest answers
 *   npm run reels:feedback -- --since 2026-10-01 only answers from that day on
 *   npm run reels:feedback -- --prompt 2026-09-27.1   only reels that prompt version directed
 *   npm run reels:feedback -- --limit 50         how many answers to list one by one (default 20)
 *   npm run reels:feedback -- --json             every answer with its full reel, for a closer look
 *
 * Read-only.
 */
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

import type { ReelFeedbackSnapshot } from "../src/lib/reels/feedback";

interface Row {
  id: number;
  jobId: number;
  version: number;
  liked: boolean;
  kind: string;
  directed: boolean;
  promptVersion: string | null;
  model: string | null;
  reel: ReelFeedbackSnapshot;
  createdAt: Date;
  updatedAt: Date;
}

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = "true";
    else {
      flags[a.slice(2)] = next;
      i++;
    }
  }
  return flags;
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");
const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const fmt = (x: number | null, digits = 1) => (x == null ? "–" : x.toFixed(digits));
const day = (d: Date) => d.toISOString().slice(0, 10);

/** Which "who made it" a reel belongs to: a prompt version, or the rules. */
const makerOf = (r: Row) => (r.kind === "video" ? "video (no AI)" : r.directed ? `prompt ${r.promptVersion ?? "(before versions)"}` : "rules (AI off)");

/** The numbers worth comparing between liked and disliked reels. */
function traits(rows: Row[]) {
  const photo = rows.filter((r) => r.kind === "photos" && r.reel.scenes?.length);
  const scenes = photo.map((r) => r.reel.scenes!.length);
  const perScene = photo.map((r) => (r.reel.duration ?? 0) / Math.max(1, r.reel.scenes!.length));
  const transitions = new Map<string, number>();
  let transitionCount = 0;
  for (const r of photo) {
    for (const sc of r.reel.scenes!) {
      transitions.set(sc.transition, (transitions.get(sc.transition) ?? 0) + 1);
      transitionCount++;
    }
  }
  return {
    reels: rows.length,
    duration: avg(rows.map((r) => r.reel.duration ?? 0).filter((d) => d > 0)),
    scenes: avg(scenes),
    perScene: avg(perScene),
    keptShare: avg(photo.filter((r) => r.reel.photos).map((r) => (r.reel.kept ?? 0) / r.reel.photos!)),
    bpm: avg(rows.map((r) => r.reel.song?.bpm ?? 0).filter((b) => b > 0)),
    transitions: [...transitions.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `${t} ${pct(n, transitionCount)}`)
      .join(", "),
    moods: [...new Set(rows.map((r) => r.reel.direction?.mood).filter(Boolean))].slice(0, 8).join("; "),
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const { db } = await import("../src/db");
  const { reelFeedback } = await import("../src/db/schema");
  const { and, desc, eq, gte } = await import("drizzle-orm");

  const where = [];
  if (flags.since) {
    const since = new Date(`${flags.since}T00:00:00+05:30`);
    if (Number.isNaN(since.getTime())) throw new Error(`Not a date: ${flags.since} (use YYYY-MM-DD)`);
    where.push(gte(reelFeedback.updatedAt, since));
  }
  if (flags.prompt) where.push(eq(reelFeedback.promptVersion, flags.prompt));

  const rows = (await db
    .select()
    .from(reelFeedback)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(reelFeedback.updatedAt))) as Row[];

  if (flags.json === "true") {
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  }
  if (rows.length === 0) {
    console.log("No answers yet. They come from the Reels screen: \"Do you like this reel?\" under a finished reel.");
    process.exit(0);
  }

  const { PROMPT_VERSION } = await import("../src/lib/reels/lessons");
  const answers = (n: number) => `${n} answer${n === 1 ? "" : "s"}`;
  console.log(`${answers(rows.length)}, ${pct(rows.filter((r) => r.liked).length, rows.length)} yes. The prompt in the code now is ${PROMPT_VERSION}.\n`);

  // Like rate per maker: the number a prompt change is judged by.
  const makers = new Map<string, Row[]>();
  for (const r of rows) makers.set(makerOf(r), [...(makers.get(makerOf(r)) ?? []), r]);
  console.log("Like rate by who made the reel");
  console.table(
    [...makers.entries()].map(([maker, rs]) => ({
      maker,
      answers: rs.length,
      yes: rs.filter((r) => r.liked).length,
      no: rs.filter((r) => !r.liked).length,
      "like rate": pct(rs.filter((r) => r.liked).length, rs.length),
      from: day(rs[rs.length - 1].updatedAt),
      to: day(rs[0].updatedAt),
    })),
  );

  // Liked against disliked, photo reels the AI directed: where the patterns show.
  const directed = rows.filter((r) => r.directed);
  if (directed.length) {
    const yes = traits(directed.filter((r) => r.liked));
    const no = traits(directed.filter((r) => !r.liked));
    console.log("\nAI-directed reels: liked against disliked");
    console.table({
      reels: { yes: yes.reels, no: no.reels },
      "avg length (s)": { yes: fmt(yes.duration), no: fmt(no.duration) },
      "avg scenes": { yes: fmt(yes.scenes), no: fmt(no.scenes) },
      "avg s per scene": { yes: fmt(yes.perScene, 2), no: fmt(no.perScene, 2) },
      "photos kept": { yes: yes.keptShare == null ? "–" : pct(yes.keptShare, 1), no: no.keptShare == null ? "–" : pct(no.keptShare, 1) },
      "avg BPM": { yes: fmt(yes.bpm, 0), no: fmt(no.bpm, 0) },
    });
    console.log(`Transitions in liked reels:    ${yes.transitions || "–"}`);
    console.log(`Transitions in disliked reels: ${no.transitions || "–"}`);
    console.log(`Moods of liked reels:    ${yes.moods || "–"}`);
    console.log(`Moods of disliked reels: ${no.moods || "–"}`);
  }

  // Songs: a song makes one reel, so this says more about the kind of song than the song.
  console.log("\nSongs");
  console.table(
    rows
      .filter((r) => r.reel.song)
      .map((r) => ({
        answer: r.liked ? "yes" : "no",
        song: `${r.reel.song!.title} · ${r.reel.song!.artist}`,
        bpm: Math.round(r.reel.song!.bpm),
        "chosen by": r.directed && r.reel.direction?.song === r.reel.song!.id ? "AI" : "rules or person",
      })),
  );

  const limit = Number(flags.limit ?? 20) || 20;
  console.log(`\nLatest ${answers(Math.min(limit, rows.length))} (npm run reels:feedback -- --json for everything)`);
  console.table(
    rows.slice(0, limit).map((r) => ({
      date: day(r.updatedAt),
      answer: r.liked ? "yes" : "no",
      reel: `#${r.jobId} v${r.version}`,
      made: makerOf(r),
      length: r.reel.duration == null ? "–" : `${r.reel.duration.toFixed(1)} s`,
      scenes: r.reel.scenes?.length ?? "–",
      kept: r.reel.photos ? `${r.reel.kept}/${r.reel.photos}` : "–",
      mood: r.reel.direction?.mood ?? "",
      transitions: (r.reel.scenes ?? []).map((s) => s.transition).join(" "),
    })),
  );
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
