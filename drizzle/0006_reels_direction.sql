-- Reels: each song makes one reel, and Gemini directs photo reels.
-- Additive only (nullable columns), so the fallback can run the old code meanwhile.
-- Applied by scripts/migrate.mjs on each side (Vercel's build, the ThinkPad's oms-migrate).
--
-- `used_at`/`used_by_job`: the reel a song went into. A used song leaves the library for
-- good; the job keeps it for remakes, and gives it back if it moves on to another song.
-- No foreign key on purpose: jobs are deleted after two days, and the song stays used.
ALTER TABLE "reel_tracks" ADD COLUMN IF NOT EXISTS "used_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "reel_tracks" ADD COLUMN IF NOT EXISTS "used_by_job" integer;
--> statement-breakpoint
-- Gemini's direction for a photo reel: scenes, seconds, song and transitions (ReelDirection).
ALTER TABLE "reel_jobs" ADD COLUMN IF NOT EXISTS "direction" jsonb;
