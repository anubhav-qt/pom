-- paribelle.in, the shop's own storefront, becomes a channel: its orders, exchanges and
-- stock run through the OMS like Amazon's. Additive only (a new enum value; Postgres 12+
-- adds one inside a transaction as long as nothing in it uses the value).
ALTER TYPE "channel" ADD VALUE IF NOT EXISTS 'paribelle';
