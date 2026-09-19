CREATE TABLE "finance_transactions" (
	"transaction_id" text PRIMARY KEY NOT NULL,
	"channel_account_id" integer NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"description" text,
	"posted_at" timestamp with time zone NOT NULL,
	"external_order_id" text,
	"group_id" text,
	"deferred_id" text,
	"total" numeric(12, 2) NOT NULL,
	"principal" numeric(12, 2) DEFAULT '0' NOT NULL,
	"tax" numeric(12, 2) DEFAULT '0' NOT NULL,
	"promo" numeric(12, 2) DEFAULT '0' NOT NULL,
	"tcs_tds" numeric(12, 2) DEFAULT '0' NOT NULL,
	"fees" numeric(12, 2) DEFAULT '0' NOT NULL,
	"postage" numeric(12, 2) DEFAULT '0' NOT NULL,
	"refund_commission" numeric(12, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_finance" (
	"order_id" integer PRIMARY KEY NOT NULL,
	"cost_price" numeric(12, 2),
	"note" text,
	"updated_by" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "refund_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "label_cost" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "returns" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "finance_transactions" ADD CONSTRAINT "finance_transactions_channel_account_id_channel_accounts_id_fk" FOREIGN KEY ("channel_account_id") REFERENCES "public"."channel_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_finance" ADD CONSTRAINT "order_finance_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_finance" ADD CONSTRAINT "order_finance_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "finance_tx_order_idx" ON "finance_transactions" USING btree ("external_order_id");--> statement-breakpoint
CREATE INDEX "finance_tx_posted_idx" ON "finance_transactions" USING btree ("posted_at");--> statement-breakpoint
CREATE INDEX "finance_tx_group_idx" ON "finance_transactions" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "finance_tx_deferred_idx" ON "finance_transactions" USING btree ("deferred_id");