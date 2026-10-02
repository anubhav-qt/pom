-- Seelie's video suite: the index of its media files (clips, cut-outs, generated scenes)
-- and its video library (every render with the graph that made it).
-- Additive only (new tables), so the fallback can run the old code meanwhile.
-- Applied by scripts/migrate.mjs on each side (Vercel's build, the ThinkPad's oms-migrate).
--
-- The files themselves are on the ThinkPad's media volume, so these fill only there;
-- infra/sync/policy.json leaves them out of the sync.
CREATE TABLE IF NOT EXISTS "seelie_assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" uuid REFERENCES "seelie_chats"("id") ON DELETE set null,
	"user_id" integer REFERENCES "users"("id") ON DELETE set null,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"file" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"duration" real,
	"has_audio" boolean,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seelie_assets_chat_idx" ON "seelie_assets" USING btree ("chat_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seelie_videos" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" uuid REFERENCES "seelie_chats"("id") ON DELETE set null,
	"user_id" integer REFERENCES "users"("id") ON DELETE set null,
	"title" text NOT NULL,
	"prompt" text,
	"version" integer DEFAULT 0 NOT NULL,
	"versions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"track_id" integer REFERENCES "reel_tracks"("id") ON DELETE set null,
	"liked" boolean,
	"notes" text,
	"published" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seelie_videos_updated_idx" ON "seelie_videos" USING btree ("updated_at");
