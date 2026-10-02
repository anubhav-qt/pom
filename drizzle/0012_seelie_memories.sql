-- What each user told Seelie to remember, read into every chat of theirs until deleted.
-- Additive only (a new table), so the fallback can run the old code meanwhile.
-- Applied by scripts/migrate.mjs on each side; infra/sync/policy.json leaves it out.
CREATE TABLE IF NOT EXISTS "seelie_memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"text" text NOT NULL,
	"chat_id" uuid REFERENCES "seelie_chats"("id") ON DELETE set null,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seelie_memories_user_idx" ON "seelie_memories" USING btree ("user_id","created_at");
