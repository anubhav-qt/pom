-- Our own dispatch-floor state and scan log, kept apart from the marketplace's
-- view of an order. Written by hand rather than by drizzle-kit generate: this
-- schema is maintained with `db:push`, so the generated file also proposed
-- re-creating restock_plan_items, which already exists.
DO $$ BEGIN
  CREATE TYPE "public"."fulfilment_state" AS ENUM('to_pack', 'packed', 'manifested');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  CREATE TYPE "public"."scan_station" AS ENUM('outbound', 'inbound');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "order_fulfilment" (
	"order_id" integer PRIMARY KEY NOT NULL,
	"state" "fulfilment_state" DEFAULT 'to_pack' NOT NULL,
	"packed_at" timestamp with time zone,
	"packed_by" integer,
	"manifested_at" timestamp with time zone,
	"manifested_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "parcel_scans" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer,
	"station" "scan_station" NOT NULL,
	"code" text NOT NULL,
	"matched_on" text,
	"item_back" boolean,
	"note" text,
	"applied" boolean DEFAULT true NOT NULL,
	"rejected_reason" text,
	"scanned_by" integer,
	"scanned_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "order_fulfilment" ADD CONSTRAINT "order_fulfilment_order_id_orders_id_fk"
    FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "order_fulfilment" ADD CONSTRAINT "order_fulfilment_packed_by_users_id_fk"
    FOREIGN KEY ("packed_by") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "order_fulfilment" ADD CONSTRAINT "order_fulfilment_manifested_by_users_id_fk"
    FOREIGN KEY ("manifested_by") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "parcel_scans" ADD CONSTRAINT "parcel_scans_order_id_orders_id_fk"
    FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "parcel_scans" ADD CONSTRAINT "parcel_scans_scanned_by_users_id_fk"
    FOREIGN KEY ("scanned_by") REFERENCES "public"."users"("id");
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "order_fulfilment_state_idx" ON "order_fulfilment" USING btree ("state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "parcel_scans_order_idx" ON "parcel_scans" USING btree ("order_id","scanned_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "parcel_scans_station_idx" ON "parcel_scans" USING btree ("station","scanned_at");
