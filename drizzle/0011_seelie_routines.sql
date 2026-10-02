-- Seelie's routines (a message on a schedule, replying in the routine's own chat) and a
-- compacted chat's summary (what Seelie reads in place of its oldest messages).
-- Additive only (a new table, nullable columns), so the fallback can run the old code meanwhile.
-- Applied by scripts/migrate.mjs on each side; infra/sync/policy.json leaves the table out.
CREATE TABLE IF NOT EXISTS "seelie_routines" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"chat_id" uuid REFERENCES "seelie_chats"("id") ON DELETE set null,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"schedule" jsonb NOT NULL,
	"model" text,
	"thinking" text,
	"auto_approve" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_run_id" uuid REFERENCES "seelie_runs"("id") ON DELETE set null,
	"last_note" text,
	"seen_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seelie_routines_due_idx" ON "seelie_routines" USING btree ("enabled","next_run_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seelie_routines_user_idx" ON "seelie_routines" USING btree ("user_id");
--> statement-breakpoint
ALTER TABLE "seelie_chats" ADD COLUMN "summary" text;
--> statement-breakpoint
ALTER TABLE "seelie_chats" ADD COLUMN "summary_through" integer;
