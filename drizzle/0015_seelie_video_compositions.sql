-- Seelie's videos are HTML compositions now (src/lib/seelie/media/composition.ts): a video
-- keeps the storyboard being worked on, and each version in `versions` the composition
-- that made it. Additive only (a new nullable column), so the fallback can run the old
-- code meanwhile.
ALTER TABLE "seelie_videos" ADD COLUMN IF NOT EXISTS "composition" jsonb;
