-- Reels: "Do you like this reel?", one answer per finished render.
-- Additive only (a new table), so the fallback can run the old code meanwhile.
-- Applied by scripts/migrate.mjs on each side (Vercel's build, the ThinkPad's oms-migrate).
--
-- Jobs are deleted after two days, so each answer keeps its own copy of the reel (`reel`):
-- no foreign key to the job or the song on purpose. docs/reels/feedback.md reads these
-- to improve the directing prompt.
CREATE TABLE IF NOT EXISTS "reel_feedback" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL,
	"version" integer NOT NULL,
	"liked" boolean NOT NULL,
	"kind" text NOT NULL,
	"directed" boolean DEFAULT false NOT NULL,
	"prompt_version" text,
	"model" text,
	"track_id" integer,
	"reel" jsonb NOT NULL,
	"created_by" integer REFERENCES "users"("id"),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reel_feedback_job_version_idx" ON "reel_feedback" USING btree ("job_id","version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reel_feedback_created_idx" ON "reel_feedback" USING btree ("created_at");
