-- Seelie's helpers: the steps a helper takes are tool calls tied to the helpers call
-- that started them (parent_call_id, helper = its place in that call), with their result
-- kept on the row (helpers' messages aren't part of the chat); the helpers call keeps
-- each helper's title, model, state and answer.
-- Additive only (new nullable columns), so the fallback can run the old code meanwhile.
ALTER TABLE "seelie_tool_calls" ADD COLUMN IF NOT EXISTS "parent_call_id" text;
--> statement-breakpoint
ALTER TABLE "seelie_tool_calls" ADD COLUMN IF NOT EXISTS "helper" smallint;
--> statement-breakpoint
ALTER TABLE "seelie_tool_calls" ADD COLUMN IF NOT EXISTS "result" jsonb;
--> statement-breakpoint
ALTER TABLE "seelie_tool_calls" ADD COLUMN IF NOT EXISTS "helpers" jsonb;
