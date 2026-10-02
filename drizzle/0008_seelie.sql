-- Seelie, the OMS's agent: its chats, its runs (one reply each), the transcript, every tool call and its settings.
-- Additive only (new tables), so the fallback can run the old code meanwhile.
-- Applied by scripts/migrate.mjs on each side (Vercel's build, the ThinkPad's oms-migrate).
--
-- Seelie's LLM runs through CLIProxyAPI on the ThinkPad only, so these fill only there;
-- infra/sync/policy.json leaves them out of the sync.
CREATE TABLE IF NOT EXISTS "seelie_chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE cascade,
	"title" text DEFAULT '' NOT NULL,
	"model" text,
	"thinking" text,
	"auto_approve" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seelie_chats_user_updated_idx" ON "seelie_chats" USING btree ("user_id","updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seelie_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chat_id" uuid NOT NULL REFERENCES "seelie_chats"("id") ON DELETE cascade,
	"user_id" integer REFERENCES "users"("id") ON DELETE set null,
	"status" text DEFAULT 'running' NOT NULL,
	"model" text NOT NULL,
	"thinking" text NOT NULL,
	"partial" jsonb,
	"error" text,
	"abort_requested" boolean DEFAULT false NOT NULL,
	"usage" jsonb,
	"owner" text,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seelie_runs_chat_idx" ON "seelie_runs" USING btree ("chat_id","started_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seelie_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" uuid NOT NULL REFERENCES "seelie_chats"("id") ON DELETE cascade,
	"run_id" uuid REFERENCES "seelie_runs"("id") ON DELETE set null,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"message" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seelie_messages_chat_seq_idx" ON "seelie_messages" USING btree ("chat_id","seq");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seelie_tool_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL REFERENCES "seelie_runs"("id") ON DELETE cascade,
	"chat_id" uuid NOT NULL REFERENCES "seelie_chats"("id") ON DELETE cascade,
	"call_id" text NOT NULL,
	"tool" text NOT NULL,
	"kind" text NOT NULL,
	"args" jsonb,
	"summary" text,
	"status" text NOT NULL,
	"approval" text,
	"decided_by" integer REFERENCES "users"("id") ON DELETE set null,
	"decided_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "seelie_tool_calls_run_call_idx" ON "seelie_tool_calls" USING btree ("run_id","call_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seelie_tool_calls_chat_idx" ON "seelie_tool_calls" USING btree ("chat_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seelie_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by" integer REFERENCES "users"("id") ON DELETE set null,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
