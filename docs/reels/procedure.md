# Reels: adding songs

The Reels screen cuts every reel to a song from the library in the `reel_tracks`
table, and each song makes one reel. This is the procedure for keeping that
library stocked with songs that suit our reels. It is a co-working procedure:
Claude Code or Antigravity does the research and runs the commands, and the
owner decides which songs go in. To start, paste one of the prompts under
[Prompts to start a session](#prompts-to-start-a-session).

The steps come first. The reference sections after them (what a good reel song
is, every command, looking after the library, how a reel is made, music rights,
where things live) hold the details. The [Run log](#run-log) at the end records
every run, and the next run starts by reading it.

## Who does what

- **The agent** reads this file and the Run log, finds out what the library
  already has, researches candidates, shows the owner a shortlist, and after
  the owner's yes adds the songs, reports back and writes the Run log entry.
- **The owner** says how many songs they want, approves, drops or swaps songs
  on the shortlist, and can paste links to songs or reels they like at any
  point. The owner's own picks go to the top of the shortlist.
- **Nothing is added without the owner's yes** to the exact list. `add`,
  `batch`, `disable`, `enable`, `free` and `remove` change the live library,
  which is the same database the site uses. `known`, `list`, `vet` and `check`
  only read, and the agent can run them at any time.

## Before starting

From the repo folder, in any terminal (these commands work the same in
PowerShell and Git Bash):

```bash
npm install
yt-dlp --version
```

- `npm install` once per machine. It also brings ffmpeg (`ffmpeg-static`).
- `.env.local` must have `DATABASE_URL`, the same database the site uses. If
  `npm run songs -- known` in step 1 prints the library, the connection works.
- yt-dlp fetches audio from YouTube. If `yt-dlp --version` fails, try
  `py -m yt_dlp --version`; either works. If neither does, install it with
  `pip install -U yt-dlp`. YouTube changes often and an old yt-dlp stops
  working, so when a `check` fails with a yt-dlp error, update it first with
  the same command. Without yt-dlp, download the audio yourself and pass the
  file.

## Step 1, always first: what we already have

```bash
npm run songs -- known
```

This lists every song the database knows, used or not, in two tables:

- **Library** (`reel_tracks`): the songs the Reels screen uses. Each is
  `in library` (ready for a new reel), `used` (with the date and the reel that
  used it) or `disabled`.
- **Old catalogue** (`reel_songs`): the song list the experiment in
  `harness_experimentation/` left in the database, with which of its songs it
  already made reels with. These count as known too. A database without that
  table just says so.

The last lines give the totals, for example `11 known, 4 used, 4 left for new
reels.`, and name any library song the old catalogue already used (a reel with
it may already be posted).

Then:

1. **Don't suggest anything listed**, used or not. `vet` enforces this in
   step 4, but checking now saves the owner's time. Each song has a key (the
   last column, `title|artists`): in lowercase, without accents, punctuation,
   "official audio", brackets, "feat." and the like. Two songs whose keys have
   the same title part are treated as the same song.
2. **Say how many are left** and set a target. Each song makes one reel, so
   keep at least 10 left for new reels. With 4 left, shortlist about 8 to 10,
   so the owner can drop a few and still reach 10.
3. **Mention the library songs the old catalogue already used**, if any. The
   owner decides whether they still count as fresh or should be disabled.
4. **Read the [Run log](#run-log)**: what the owner kept and rejected before,
   and why. Don't suggest a rejected song again unless the owner asks.

`npm run songs -- known --json` prints the same as one JSON array, with `key`
and `titleKey` for each song, for an agent to read.

## Step 2: research candidates

Look for songs **trending now** in Instagram reels for Indian women's ethnic
wear: Punjabi pop, Bollywood dance and wedding tracks, the audio people are
using this month for kurti, suit and co-ord reels.

Where to look:

- **The owner's links and ideas** first: songs, reels or accounts they shared.
- **Web search** for this month's lists: "trending Instagram reel songs India
  this week", "trending Punjabi songs reels", wedding-season song lists, and
  the music charts (YouTube Charts' top songs in India, Spotify's India and
  Punjabi charts).
- **YouTube**: Trending > Music for India, and the labels' and artists' own
  channels (T-Series, Speed Records, White Hill Music, Saregama, Sony Music
  India, Zee Music Company, the artist's channel), where the official audio
  uploads are.
- **Instagram**, read-only and without signing in. Most audio pages need a
  login; when they do, ask the owner to look instead or to paste reels.

For each candidate, keep the title and artist as Instagram's music picker lists
them, in Latin letters (a title in Gurmukhi or Devanagari won't match the
romanised one already in the library). Drop any whose key is already in
`known`. See [What a good reel song is](#what-a-good-reel-song-is) for the
tempo and hook to look for.

## Step 3: the shortlist, with the owner

Show the owner a table like this one (the row only shows the format; that
song is already in the library):

| # | Title | Artist | Language | Why it fits | Official audio | Hook | How the hook was found | BPM |
|---|---|---|---|---|---|---|---|---|
| 1 | Tauba Tauba | Karan Aujla | punjabi | Party track with a steady beat; its chorus is a common outfit-change audio | https://www.youtube.com/watch?v=BBrQWOuE_pg | 0:47 | Most replayed peak, and the line three reels open on | 95 |

- **Why it fits**: one line on why it suits a kurta, suit or co-ord reel:
  where it trends, its mood, its tempo.
- **Official audio**: a YouTube link to the label's or artist's audio upload
  (titled "Audio" or "Official Audio", or the auto-made "- Topic" upload). Not
  a lyric video, remix, slowed or sped-up version, live cut or fan upload:
  their tempo and timings differ from the song reels use.
- **Hook**: where the part reels use starts, as `m:ss` in that official audio
  (music videos often have a longer intro, so their times are off). How to find
  it, surest first:
  1. The part reels use: open two or three reels with the audio (the owner can
     paste some) and find the line they open on in the official audio.
  2. YouTube's "Most replayed" peak: the graph over the progress bar of the
     official audio.
  3. Timestamped comments under the official audio ("2:15 the best part").
  4. The loudness guess: `check` without `--hook`. Last resort; it often picks
     a different chorus than the one reels use.

  Say which of these each hook came from.
- **BPM**: if `check` has already been run on it; otherwise leave it blank.

Ask the owner to keep, drop or swap each song ("keep 1, 3 and 4; swap 2 for
something slower"). Research replacements for swapped songs, show the table
again, and repeat until the owner approves a list. Note each dropped song and
the reason for the Run log.

## Step 4: vet, check, add

**1. Write the approved songs** to `tmp/songs.json` (`tmp/` is not committed):

```json
[
  { "input": "https://www.youtube.com/watch?v=BBrQWOuE_pg", "title": "Tauba Tauba", "artist": "Karan Aujla", "language": "punjabi", "tags": ["party", "festive"], "hook": "0:47" },
  { "input": "https://www.youtube.com/watch?v=ejYe2GwBEJ0", "title": "Kinni Kinni", "artist": "Diljit Dosanjh", "hook": "0:52" }
]
```

(These two only show the format: both are already in the library, so `vet`
would block them.) The fields are those of [`add`](#adding-one-song), plus
`again`:

- `input`, `title`, `artist` (required), `hook`, `language`, `tags`, `source`:
  see [Adding one song](#adding-one-song).
- `again: true`: only when the owner wants a known song in anyway: new audio
  or a new hook for a library song (same title and artist: it replaces that
  row, and a used song stays used), a song from the old catalogue, or a
  different song whose title is already known. Without it, `vet` blocks them.

**2. Vet the file.** It must pass before anything else:

```bash
npm run songs -- vet tmp/songs.json
```

Nothing is downloaded or saved. Each song gets a verdict: `new`, `new (again,
on purpose)`, `already in library`, `already in library (disabled)`, `already
known (used)`, `already known (old catalogue, not used)`, `duplicate in batch`
or `not ready`. Everything but the two `new` verdicts is blocked, with the
reasons listed under it, and then the command exits with code 1
(`$LASTEXITCODE` in PowerShell).

It blocks:

- a known song: the same title key (whoever the artist), the same title
  spelled a little differently by the same artist (Kinni Kinni and Kini Kini),
  or the same YouTube upload as a known song;
- a song twice in the file;
- a missing title, artist or input; a hook that doesn't read as `m:ss` or
  seconds; an input that is neither a link, a `ytsearch1:` search nor a file
  that exists; a field it doesn't know (a misspelt `"hok"` would lose the
  hook).

It also notes, without blocking: no hook, a search instead of a link, a hook in
the first 5 seconds (`0.47` where `0:47` was meant), and a title that contains
a known title by the same artist.

Fix or drop the blocked songs (with the owner, if that changes the list) and
vet again. `--json` prints the verdicts as JSON.

**3. Check each song** with its hook:

```bash
npm run songs -- check "https://www.youtube.com/watch?v=BBrQWOuE_pg" --hook 0:47
```

It downloads to a temporary folder, analyses, and deletes it; nothing is saved.
It prints the upload's title and link, then the tempo, beats, hook and length,
and the 70-second stretch that adding would keep:

```
Tauba Tauba - Audio | Bad Newz | Vicky Kaushal | Karan Aujla | Triptii Dimri  https://www.youtube.com/watch?v=BBrQWOuE_pg
95 BPM · 345 beats · first bar at beat 0 · 22 phrases · 17 lifts · hook 0:47 · 3:37 long
Adding it would keep 0:39–1:49. Nothing was saved.
```

- The title should be the official audio you meant.
- The BPM should match the song's feel. Half or double the real tempo (60 for
  a 120 BPM song) means the beat was misread: try another upload of the same
  song (the "- Topic" upload or the label's audio), check it, and use the link
  that reads right.
- The stretch should hold the hook. Running `check` without `--hook` shows
  where the loudness guess lands; if it is far from your hook, look at the hook
  again.

Put what you learn (the better link, a corrected hook, the BPM) into the
shortlist and `tmp/songs.json`, and vet again if the file changed.

**4. Add them**, once the owner has said yes to this list:

```bash
npm run songs -- batch tmp/songs.json
```

Before each song it warns, without stopping, when the song:

- **replaces a library row** (the same title and artist, exactly): new audio,
  hook and beats; a used song stays used, a disabled one goes back into
  rotation;
- **matches a known song under another spelling**: this adds a second library
  row. If that wasn't meant, stop and tell the owner. With their yes,
  `remove <id>` the new row; if a new cut of the known song was the aim, add
  it again with that song's title and artist exactly as stored.

A failing song is reported and skipped; the rest still go in.

## Step 5: report and log

Report to the owner, as a table: each song's id, title, artist, BPM, hook and
the stretch kept, with any BPM that looks halved or doubled flagged, then the
new "left for new reels" count from `npm run songs -- known`.

Then add a row to the [Run log](#run-log) at the end of this file: the date,
who ran it (the agent and the owner), the songs added with their ids, and the
songs rejected with the reason ("too slow", "trend is over", "already posted").
Keep it to one row per run. The log is part of the procedure: the next run
reads it to learn what the owner likes. Committing the file is the owner's
call.

## Notes for Antigravity

- Use your own browser for web search and YouTube, and your own terminal for
  the commands, run from the repo folder. The commands and the prompt are the
  same as for Claude Code.
- In the browser: read-only. Never sign in, like, comment, follow or
  subscribe, and decline optional cookies.
- Ask the owner in the chat before `batch`, `add`, `disable`, `enable`, `free`
  or `remove`.

## Notes for Claude Code

- Use the built-in browser pane for YouTube (the official uploads, the "Most
  replayed" graph, comments) and web search for trend lists. Run the commands
  in the terminal from the repo folder.
- Never sign in to anything. Stay read-only on YouTube and Instagram: no likes,
  comments, follows or subscriptions, and decline optional cookies. When a page
  needs a login (Instagram's audio pages usually do), ask the owner to look or
  paste what they see.
- Ask the owner before `batch`, `add`, `disable`, `enable`, `free` or `remove`.

## Prompts to start a session

**Claude Code:**

> Read docs/reels/procedure.md and follow it with me. Start with
> `npm run songs -- known` and the Run log, and tell me how many songs are
> left. Then research about 8 songs trending this month in Instagram reels for
> Indian women's ethnic wear (Punjabi pop, Bollywood dance and wedding tracks)
> that we don't already have, and show me the shortlist table. Use the browser
> pane read-only and don't sign in to anything. Don't add anything until I say
> yes to the list.

**Antigravity:**

> Read docs/reels/procedure.md and follow it with me. Start with
> `npm run songs -- known` and the Run log, and tell me how many songs are
> left. Then research about 8 songs trending this month in Instagram reels for
> Indian women's ethnic wear (Punjabi pop, Bollywood dance and wedding tracks)
> that we don't already have, and show me the shortlist table. Use your
> browser read-only for web search and YouTube, don't sign in to anything, and
> run the commands in your terminal from the repo folder. Don't add anything
> until I say yes to the list.

**When the owner already has songs in mind** (either agent):

> Read docs/reels/procedure.md. I like these songs: <links or names>. Check
> them against what we have, find the official audio and the hook for each,
> and show me the shortlist table. Don't add anything until I say yes.

## Reference

### What a good reel song is

- **Trending now** in Indian women's fashion reels: Punjabi pop, Bollywood
  dance and wedding tracks, the audio people are currently using for kurti,
  suit and co-ord reels.
- **A clear beat.** 85 to 135 BPM is the sweet spot for outfit cuts. Slower
  songs work but reels feel calmer; the picker prefers this range.
- **A hook.** The part everyone uses in reels (the chorus drop, the famous
  line). Its timestamp matters more than anything else (see `--hook`).

### Commands

```bash
npm run songs -- known [--json]                  # every song the database knows, used or not
npm run songs -- vet tmp/songs.json [--json]     # a candidate batch against those; nothing fetched or saved
npm run songs -- check <file | link | "ytsearch1:query"> [--hook 0:47]   # tempo, beats, hook, stretch; nothing saved
npm run songs -- add <file | link | "ytsearch1:query"> --title "…" --artist "…" [--language punjabi] [--tags "a,b"] [--hook 0:47] [--source <url>]
npm run songs -- batch tmp/songs.json            # add many
npm run songs -- list                            # the library, with renders and which reel used each song
npm run songs -- disable <id>                    # also enable <id>, free <id> and remove <id>; see below
npm run songs -- help
```

`known`, `vet`, `check`, `list` and `help` only read. The others change the
library.

### Adding one song

```bash
npm run songs -- add "ytsearch1:Tauba Tauba Karan Aujla official audio" --title "Tauba Tauba" --artist "Karan Aujla" --language punjabi --tags "party,festive" --hook 0:47
```

The input can be a YouTube link, a `ytsearch1:<query>` search (first result),
or a local audio or video file (a path from the repo folder).

- `--title`, `--artist` (required): what the screen shows, and what to search
  for in Instagram's music picker. Adding the same title and artist again
  replaces that song.
- `--hook` (strongly recommended): where the trending part starts in the full
  song, as `m:ss`. Take it from a few trending reels that use the audio (the
  audio page on Instagram shows the start). Without it the hook is guessed
  from loudness, which is often a different chorus than the one people use.
- `--language`: `punjabi` (default), `hindi`, `instrumental`, ...
- `--tags`: free words, comma separated (`wedding`, `festive`, `ads-safe`).
- `--source`: where it came from, if not a link.

What happens: the audio is fetched, its beats, bars and phrases are measured,
and a 70-second stretch starting 8 s before the hook is stored (AAC) with that
analysis. Reels only ever use that stretch. Like `batch`, `add` warns first
when the song replaces a library row or matches a known song under another
spelling.

The command prints the result, for example:

```
• Tauba Tauba — Karan Aujla
  from: Tauba Tauba - Audio | Bad Newz | Vicky Kaushal | Karan Aujla | Triptii Dimri
  saved #1: 95 BPM, 110 beats kept, hook 0:47, stretch 0:39–1:49, 1370 KB
```

Sanity-check it: the BPM should match the song's feel (a half or double of the
real tempo means the beat was misread: try another upload of the song), and the
hook should be what you asked for.

### Looking after the library

```bash
npm run songs -- known             # everything known, and how many are left
npm run songs -- list              # the library, which reel used each song, and how many are left
npm run songs -- disable 3         # out of rotation, kept in the database
npm run songs -- enable 3
npm run songs -- free 3            # a used song back in the library
npm run songs -- remove 3          # gone for good
```

**Each song makes one reel.** Once a reel is made with a song, it leaves the
library, so no two reels share a song; keep adding songs. The reel keeps its
song for remakes; "Different song" gives the old one back and takes the next.
The screen shows how many songs are left.

Disable a song once its trend has passed. New songs are favoured on their own:
the rules prefer songs added recently, so a fresh batch shows up straight away.

### How a photo reel is made

With **AI** on, Gemini directs the reel. It sees the shoot, the songs left and
the transitions, and answers in JSON (shown on the screen under the reel):
which photos to keep, the scenes in order with the seconds each holds and the
transition into it, the song, the total length, and the transition into the
end card. The code fits that onto the song: each scene becomes the whole
number of beats nearest its seconds, the reel starts on the song's best
downbeat, and every cut lands on a beat. Taps on the photos (in or out) change
the scenes without asking Gemini again.

With AI off, the rules in `plan.ts` do the same job: every photo in upload
order, a steady number of beats each, transitions from the music.

The photos never move in the frame. The transitions (`transitions.ts`) happen
on the picture, centred on the beat: cut, dissolve, dip to black, dip to
ivory, light leak, chroma split, film grain, ripple, focus pull, silk wipe and
glow.

### Music rights

- **Instagram / Facebook posts:** post the "No music" download, then add the
  same song inside Instagram, starting at the time the screen shows. Instagram's
  own library licenses it, and the cuts still land on the beat. Uploading the
  copy with the song baked in can get the audio muted or the reel limited.
- **WhatsApp:** the copy with music is fine.
- **Paid Meta ads:** commercial songs are not licensed for ads. Use songs you
  have rights to: royalty-free or no-copyright tracks (tag them `ads-safe`,
  language `instrumental`), and pick one in the song picker before making the
  ad's reel.

### Where things live

- `scripts/reel-songs.ts`: the `npm run songs` command, including the song key
  that `known`, `vet`, `add` and `batch` all compare with.
- `reel_tracks`: the library. `reel_songs`: the old catalogue, written by the
  experiment in `harness_experimentation/`; the app never reads it, only
  `known` and `vet` do.
- `tmp/songs.json`: a run's batch file (not committed).
- `src/lib/reels/beats.ts`: the beat analysis (tempo, beats, bars, phrases,
  lifts, hook).
- `src/lib/reels/select.ts`: Gemini's direction (the prompt and the checks on its answer).
- `docs/reels/feedback.md`: tuning that prompt from the "Do you like this reel?"
  answers (`npm run reels:feedback`); the rules it adds live in
  `src/lib/reels/lessons.ts`.
- `src/lib/reels/plan.ts`: song choice and the cut plan, directed or by the rules.
- `src/lib/reels/transitions.ts`: the transitions, and `render-photos.ts` draws them.
- Environment: `GEMINI_API_KEYS` (comma-separated keys, tried in turn; falls
  back to `GEMINI_API_KEY`), optional `GEMINI_REEL_MODELS` (the model ladder,
  default `gemini-3.6-flash,gemini-3.7-flash,gemini-3.8-flash`) and
  `FFMPEG_PATH` (a system ffmpeg instead of the bundled one).

## Run log

One row per run, newest last. The agent adds the row at the end of step 5.

| Date | Ran by | Added (library ids) | Rejected, and why |
|---|---|---|---|
| 2026-09-26 | The first library, before this procedure | Tauba Tauba #1, Kinni Kinni #2, Proper Patola #3, Baller #4, Classy Fashion #5 (instrumental, tagged `no-copyright`, `ads`) | None recorded |
| 2026-09-27 | Antigravity and the owner | 100 trending songs for women's ethnic wear (#100006 to #100105) across Bollywood dance, Punjabi pop, Wedding/Sangeet, Aesthetic twirl, and Regional folk fusion | None (all 100 candidates approved) |
