-- Reels: the song library, and the short-lived jobs that turn uploads into an MP4.
-- Additive only. Apply with: npx tsx scripts/apply-migration.ts drizzle/0005_reels.sql
--
-- `reel_tracks` is a new name on purpose: the experiment in harness_experimentation/
-- left a `reel_songs` table (pgvector) in this database, and it is not touched here.
CREATE TABLE IF NOT EXISTS "reel_tracks" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"artist" text NOT NULL,
	"language" text DEFAULT 'punjabi' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bpm" real NOT NULL,
	"source" text,
	"window_start" real DEFAULT 0 NOT NULL,
	"duration" real NOT NULL,
	"audio" bytea NOT NULL,
	"audio_mime" text DEFAULT 'audio/mp4' NOT NULL,
	"analysis" jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reel_tracks_title_artist_idx" ON "reel_tracks" USING btree ("title","artist");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reel_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_by" integer REFERENCES "users"("id"),
	"kind" text NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"error" text,
	"ai_failed" boolean DEFAULT false NOT NULL,
	"picks" jsonb,
	"plan" jsonb,
	"track_id" integer REFERENCES "reel_tracks"("id") ON DELETE SET NULL,
	"tried_tracks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output" bytea,
	"output_silent" bytea,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reel_jobs_created_idx" ON "reel_jobs" USING btree ("created_at");
--> statement-breakpoint
-- The player reads the MP4 in slices. EXTERNAL keeps the bytes uncompressed in
-- TOAST (video does not compress anyway), so substring() fetches only the slice.
ALTER TABLE "reel_jobs" ALTER COLUMN "output" SET STORAGE EXTERNAL;
--> statement-breakpoint
ALTER TABLE "reel_jobs" ALTER COLUMN "output_silent" SET STORAGE EXTERNAL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reel_job_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" integer NOT NULL REFERENCES "reel_jobs"("id") ON DELETE CASCADE,
	"kind" text NOT NULL,
	"idx" integer NOT NULL,
	"name" text,
	"bytes" bytea NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reel_job_files_slot_idx" ON "reel_job_files" USING btree ("job_id","kind","idx");
