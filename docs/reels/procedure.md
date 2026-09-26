# Reels: adding songs

The Reels screen cuts every reel to a song from the library in the `reel_tracks`
table. This is the procedure for keeping that library fresh. It is written so
that Claude Code or Antigravity can follow it end to end: hand it this file and
say "add these songs" (or "find and add this month's trending songs").

## What a good reel song is

- **Trending now** in Indian women's fashion reels: Punjabi pop, Bollywood
  dance and wedding tracks, the audio people are currently using for kurti,
  suit and co-ord reels.
- **A clear beat.** 85 to 135 BPM is the sweet spot for outfit cuts. Slower
  songs work but reels feel calmer; the picker prefers this range.
- **A hook.** The part everyone uses in reels (the chorus drop, the famous
  line). Its timestamp matters more than anything else (see `--hook`).

## One-time setup (per machine)

1. `npm install` in the repo (this also brings ffmpeg, via `ffmpeg-static`).
2. `.env.local` with `DATABASE_URL` (the same database the site uses).
3. yt-dlp, only to add songs from YouTube links or searches:
   `pip install -U yt-dlp` (any of `yt-dlp`, `py -m yt_dlp`, `python -m yt_dlp`
   works). Without it, download the audio yourself and pass the file.

## Adding songs

### One song

```bash
npm run songs -- add "ytsearch1:Tauba Tauba Karan Aujla official audio" \
  --title "Tauba Tauba" --artist "Karan Aujla" \
  --language punjabi --tags "party,festive" --hook 0:47
```

The input can be a YouTube link, a `ytsearch1:<query>` search (first result),
or a local audio or video file.

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
analysis. Reels only ever use that stretch.

The command prints the result, for example:

```
• Tauba Tauba — Karan Aujla
  saved #1: 95 BPM, 110 beats kept, hook 0:47, stretch 0:39–1:49, 1370 KB
```

Sanity-check it: the BPM should match the song's feel (a half or double of the
real tempo means the beat was misread: try another upload of the song), and the
hook should be what you asked for.

### Many songs

Write a JSON file (anywhere, e.g. `songs.json`) and run
`npm run songs -- batch songs.json`:

```json
[
  { "input": "ytsearch1:Tauba Tauba Karan Aujla official audio", "title": "Tauba Tauba", "artist": "Karan Aujla", "hook": "0:47", "tags": ["party"] },
  { "input": "https://www.youtube.com/watch?v=...", "title": "Kinni Kinni", "artist": "Diljit Dosanjh", "hook": "0:52" },
  { "input": "C:/Downloads/song.mp3", "title": "Classy Fashion", "artist": "InSpin", "language": "instrumental", "tags": ["ads-safe"] }
]
```

A failing song is reported and skipped; the rest still go in.

### Checking a song before adding it

`npm run songs -- check <file | link> [--hook 0:47]` prints tempo, beats,
phrases and the hook without saving anything.

## Looking after the library

```bash
npm run songs -- list              # every song, with use counts and last use
npm run songs -- disable 3         # out of rotation, kept in the database
npm run songs -- enable 3
npm run songs -- remove 3          # gone for good
```

Disable a song once its trend has passed. New songs are favoured on their own:
the picker prefers songs added recently and songs not used lately, so a fresh
batch starts showing up straight away. "Different song" on the screen walks
through the rest, and the song picker there can choose any active song.

## Prompt for Claude Code or Antigravity

> Read docs/reels/procedure.md. Find 5 songs trending this month in Instagram
> reels for Indian women's ethnic wear (Punjabi and Bollywood), not already in
> `npm run songs -- list`. For each, find the official audio on YouTube and the
> timestamp where the part used in reels starts. Write them to songs.json and
> run `npm run songs -- batch songs.json`. Report each song's BPM and hook, and
> flag any whose BPM looks halved or doubled.

## Music rights

- **Instagram / Facebook posts:** post the "No music" download, then add the
  same song inside Instagram, starting at the time the screen shows. Instagram's
  own library licenses it, and the cuts still land on the beat. Uploading the
  copy with the song baked in can get the audio muted or the reel limited.
- **WhatsApp:** the copy with music is fine.
- **Paid Meta ads:** commercial songs are not licensed for ads. Use songs you
  have rights to: royalty-free or no-copyright tracks (tag them `ads-safe`,
  language `instrumental`), and pick one in the song picker before making the
  ad's reel.

## Where things live

- `scripts/reel-songs.ts`: this command.
- `src/lib/reels/beats.ts`: the beat analysis (tempo, beats, bars, phrases,
  lifts, hook).
- `src/lib/reels/plan.ts`: song choice and the cut plan.
- Environment: `GEMINI_API_KEYS` (comma-separated keys, tried in turn; falls
  back to `GEMINI_API_KEY`), optional `GEMINI_REEL_MODELS` (the model ladder,
  default `gemini-3.6-flash,gemini-3.7-flash,gemini-3.8-flash`) and
  `FFMPEG_PATH` (a system ffmpeg instead of the bundled one).
