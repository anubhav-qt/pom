-- Seelie's product studio: garments it has studied, personas (recurring models),
-- photoshoots with every attempt, and the ledger of image-model calls the image
-- budget is worked out from (the account's cap shows nowhere else).
-- Additive only (new tables), so the fallback can run the old code meanwhile.
-- Applied by scripts/migrate.mjs on each side; infra/sync/policy.json leaves these out.
CREATE TABLE IF NOT EXISTS "seelie_garments" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"spec" jsonb,
	"photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_by" integer REFERENCES "users"("id") ON DELETE set null,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seelie_personas" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seelie_shoots" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" uuid REFERENCES "seelie_chats"("id") ON DELETE set null,
	"user_id" integer REFERENCES "users"("id") ON DELETE set null,
	"title" text NOT NULL,
	"garment_key" text REFERENCES "seelie_garments"("key") ON DELETE set null,
	"persona_id" integer REFERENCES "seelie_personas"("id") ON DELETE set null,
	"brief" text,
	"looks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"liked" boolean,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seelie_shoots_updated_idx" ON "seelie_shoots" USING btree ("updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "seelie_image_calls" (
	"id" serial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"chat_id" uuid REFERENCES "seelie_chats"("id") ON DELETE set null,
	"shoot_id" integer REFERENCES "seelie_shoots"("id") ON DELETE set null,
	"look" text,
	"model" text NOT NULL,
	"size" text,
	"aspect" text,
	"refs" integer DEFAULT 0 NOT NULL,
	"outcome" text NOT NULL,
	"reset_at" timestamp with time zone,
	"ms" integer,
	"error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seelie_image_calls_at_idx" ON "seelie_image_calls" USING btree ("at");
