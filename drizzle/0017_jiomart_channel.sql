-- JioMart becomes a channel. Like Flipkart and Meesho, its orders, returns and payments come in
-- from its seller panel (docs/portals/procedure.md) until JioMart gives us API access.
-- Additive only (a new enum value; Postgres 12+ adds one inside a transaction as long as nothing
-- in it uses the value).
ALTER TYPE "channel" ADD VALUE IF NOT EXISTS 'jiomart';
