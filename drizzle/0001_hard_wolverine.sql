ALTER TYPE "public"."sync_kind" ADD VALUE 'backfill';--> statement-breakpoint
CREATE TABLE "catalog_images" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_account_id" integer NOT NULL,
	"asin" text NOT NULL,
	"image_url" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_status_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"channel_account_id" integer NOT NULL,
	"channel" "channel" NOT NULL,
	"external_order_id" text NOT NULL,
	"from_status" "order_status",
	"to_status" "order_status" NOT NULL,
	"sync_run_id" integer,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_in_at" timestamp with time zone,
	"checked_in_by" integer,
	"item_back" boolean,
	"checkin_note" text
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD COLUMN "external_asin" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "channel_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "easyship_status" text;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "total_estimate" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "mfa_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "catalog_images" ADD CONSTRAINT "catalog_images_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_sync_run_id_sync_runs_id_fk" FOREIGN KEY ("sync_run_id") REFERENCES "public"."sync_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_status_events" ADD CONSTRAINT "order_status_events_checked_in_by_users_id_fk" FOREIGN KEY ("checked_in_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_images_account_asin_idx" ON "catalog_images" USING btree ("channel_account_id","asin");--> statement-breakpoint
CREATE UNIQUE INDEX "order_status_events_order_to_idx" ON "order_status_events" USING btree ("order_id","to_status");--> statement-breakpoint
CREATE INDEX "order_status_events_to_idx" ON "order_status_events" USING btree ("to_status","detected_at");--> statement-breakpoint
CREATE INDEX "order_status_events_account_idx" ON "order_status_events" USING btree ("channel_account_id","detected_at");--> statement-breakpoint
CREATE INDEX "order_status_events_pending_idx" ON "order_status_events" USING btree ("checked_in_at","to_status");