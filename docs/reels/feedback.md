# Reels: tuning the AI director from feedback

Under every finished reel the Reels screen asks **"Do you like this reel?"**
(Yes / No). Each answer is saved in the `reel_feedback` table with a copy of
the reel as it was: the song, every scene (photo, seconds, transition),
Gemini's direction and its verdict on every photo, and which model and prompt
version directed it. Reel jobs are deleted after two days; the answers stay.

This is the procedure for turning those answers into a better prompt. It is
written so that Claude Code or Antigravity can follow it end to end with the
owner: hand it this file and say "review the reel feedback".

## When to run it

- Every 20 or so new answers, or once a month, whichever comes first.
- Sooner if the owner says reels have got worse.
- Not before a prompt version has about 10 answers: fewer than that is noise.

## What is where

- `src/lib/reels/lessons.ts`: `LESSONS`, the house rules feedback has taught
  (one short sentence each, added to the prompt after the general direction,
  and they win where the two disagree), and `PROMPT_VERSION`.
- `src/lib/reels/select.ts`: the prompt itself (`SYSTEM` and `prompt()`), and
  the checks on Gemini's answer.
- `npm run reels:feedback`: the answers, read-only.

## The review

1. **Read the answers.** Start from the date of the last review in the log
   below:

   ```bash
   npm run reels:feedback -- --since 2026-10-01
   ```

   It prints the like rate for each prompt version (and for reels the rules
   made with AI off, and video reels, which say nothing about the prompt),
   then liked against disliked AI-directed reels side by side: length,
   scenes, seconds per scene, share of photos kept, BPM, transitions, moods.
   Then the songs, then the latest answers one by one.

2. **Look closer where something stands out.** `--json` prints every answer
   with its whole reel: the scenes in order, Gemini's reason for keeping or
   dropping each photo, its mood, the song and the cue.

   ```bash
   npm run reels:feedback -- --since 2026-10-01 --json > tmp/feedback.json
   ```

   Useful questions: do disliked reels run longer or shorter? Hold photos too
   long or cut too fast? Lean on one transition? Drop the photos the owner
   would have kept (a back view, a close-up of the embroidery)? Pick songs of
   one kind (slow, a language, a BPM range)? A song makes one reel, so judge
   the kind of song, not the song.

3. **Tell the owner what you found** before changing anything: the like
   rate, the two or three patterns with the numbers behind them, and the
   change you propose for each. A pattern from one or two answers is a guess:
   say so, and wait for more.

4. **Make the change the owner agrees to.** Prefer one or two small changes
   per review, so the next review can tell which one worked:
   - a house rule: add one sentence to `LESSONS` in
     `src/lib/reels/lessons.ts`, e.g. `"Keep the whole reel under 14 seconds
     of photos."`;
   - a change to the general direction (the seconds ranges, the taste rules
     for transitions, what to keep and drop): edit `prompt()` or `SYSTEM` in
     `src/lib/reels/select.ts`. When a rule in `LESSONS` has been folded into
     the prompt this way, take it out of `LESSONS`.

   Numbers the code checks, like the 0.5 to 3 seconds a scene may hold, are
   also enforced in `normaliseDirection` (select.ts) and the planner
   (`plan.ts`); change those too if the prompt's ranges move.

5. **Bump `PROMPT_VERSION`** in `lessons.ts`: today's date and a counter,
   e.g. `2026-10-14.1`. Every reel directed from then on is counted under it.

6. **Check it.** `npm run typecheck`, then make two or three reels on the
   Reels screen on localhost (`npm run dev`, AI on) from a real shoot, and
   look at "AI's plan (JSON)" under each to see the change took. The owner
   tests on localhost before anything is pushed or deployed.

7. **Log the review** in the table below: the date, the answers reviewed,
   the like rate of the version reviewed, what changed and why, and the new
   version.

8. **Next time**, start by comparing the new version's like rate with the
   old one's. If it went down, undo the change (and log that too).

## Prompt to paste

> Read docs/reels/feedback.md and review the reel feedback since the last
> review in its log. Show me the like rate and what liked and disliked reels
> have in common, and propose at most two changes to the prompt. Don't change
> anything until I agree.

## Review log

| Date | Answers reviewed | Like rate (version) | Change | New version |
|---|---|---|---|---|
| 2026-09-27 | none yet | – | Feedback started. Prompt as it was, no house rules. | 2026-09-27.1 |
