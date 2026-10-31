-- paribelle.in's orders ship through Logixmitra (src/lib/logixmitra): each new order is
-- pushed there, booked with the cheapest courier, and followed by its AWB. One row per
-- order, keyed by the order so the two databases can't both mint one. Additive only.
CREATE TABLE IF NOT EXISTS "logixmitra_shipments" (
  "order_id" integer PRIMARY KEY NOT NULL REFERENCES "orders"("id") ON DELETE cascade,
  "state" text DEFAULT 'new' NOT NULL,
  "lm_order_id" text,
  "reference_id" text,
  "courier" text,
  "awb" text,
  "rate" numeric(10, 2),
  "cod_amount" numeric(12, 2),
  "tracking_status" text,
  "store_state" text,
  "error" text,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_try_at" timestamp with time zone,
  "locked_until" timestamp with time zone,
  "booked_at" timestamp with time zone,
  "tracked_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "logixmitra_shipments_state_idx" ON "logixmitra_shipments" ("state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "logixmitra_shipments_awb_idx" ON "logixmitra_shipments" ("awb");
