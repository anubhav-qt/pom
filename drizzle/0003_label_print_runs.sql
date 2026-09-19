CREATE TABLE "label_print_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"pdf" "bytea" NOT NULL,
	"label_count" integer NOT NULL,
	"sheet_count" integer NOT NULL,
	"sources" jsonb NOT NULL,
	"labels" jsonb NOT NULL,
	"duplicate_order_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"frames_removed" integer DEFAULT 0 NOT NULL,
	"unstamped" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "label_print_runs" ADD CONSTRAINT "label_print_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "label_print_runs_created_idx" ON "label_print_runs" USING btree ("created_at");
