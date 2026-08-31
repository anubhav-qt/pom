# Order sync — how it works

Two independent lanes feed the same `ingestOrders` pipeline. Neither ever blocks
the other.

## Fast lane — the "Sync now" button

`syncAccount(account, "orders")`, run by the manual **Sync now** button in the
header / Settings.

> **No scheduled sync right now** (decision 2026-08-31). `vercel.json` has no
> `crons` entry and nothing calls `/api/cron/sync` automatically — data is only
> as fresh as the last time someone pressed **Sync now**. The route still exists
> and still works if hit with the `CRON_SECRET`; re-adding the schedule is a
> one-line change to `vercel.json`. Re-enabling it (or moving to push) is a
> [ROADMAP.md](ROADMAP.md) item for v2.

- **Rolling 72-hour window.** It always asks Amazon for
  `LastUpdatedAfter = now − 72h` and ignores any saved cursor for the lookback.
  A skipped sync, a gap between manual syncs, or a little clock skew therefore
  can't leave a hole in recent orders, and re-reading the same window is free
  because every write is an idempotent upsert.
- **Skip-if-unchanged.** Before calling the adapter, the orchestrator loads
  `(externalOrderId → channelUpdatedAt)` for everything it already holds in that
  window and passes it in as `unchangedSince`. For any order whose Amazon
  `LastUpdateDate` matches, the adapter skips the per-order `/orderItems` call
  entirely — that call is the rate-limited part (~0.5 req/sec), so skipping it
  is what keeps a routine sync down to a second or two. `itemsKnownCurrent` on
  the canonical order tells the ingest to leave the existing `order_items` rows
  untouched.
- **`channel_updated_at`** on `orders` is the column that makes the skip
  possible. It's set from `LastUpdateDate` on every ingest, live or backfill.

History older than 72h is **not** the fast lane's job — that's the backfill.

## Backfill lane — one-time, and re-runnable by hand

`backfillAccount(account, { start, end, chunkDays })`, driven by
`npm run backfill:amazon` (`scripts/backfill-amazon.ts`).

- Uses the **Reports API**
  (`GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL`): create a report for a
  date window → poll until `DONE` → download one TSV with every order line.
  **Not** rate-limited per order, so months of history come back in minutes.
- Walks `[start, end]` in `chunkDays` windows (default 30), ingesting each batch
  of ~500 orders through `ingestOrders` as it goes.
- Records itself as a `sync_runs` row with `kind = "backfill"`, so its progress
  and any error land in the same Sync Log as everything else.
- The flat-file report carries no buyer PII, no COD flag and no ship-by date;
  those columns stay null on backfilled orders until the fast lane next touches
  the order while it's still open. Analytics (revenue, SKU, status) are
  unaffected.

**Run once against production before the first deploy:**

```bash
npm run backfill:amazon
```

Default range is **the last 6 months** — the shop didn't trade before that.
Pass `--from YYYY-MM-DD` to go further back. A window Amazon won't build is
logged and skipped, not fatal — the run only fails if *every* window fails.

## Cancellations & RTO — `order_status_events`

Append-only. `ingestOrders` writes one row the first time an order reaches a
given status:

- a real transition of an order we already had (`fromStatus → toStatus`), or
- an order that showed up already terminal (`fromStatus = null`).

Unique on `(order_id, to_status)`, so two overlapping syncs racing on the same
change is harmless. The "Cancelled / RTO" screen is just this table filtered to
`to_status in ('cancelled','rto','returned')` — a cancellation stays a dated
record of its own even after the order row moves on, and it shows up on the very
next sync after Amazon flips the status.

### How status is decided (verified against live data)

This account ships **Amazon Easy Ship**, and its `OrderStatus` stays `Shipped`
even after a parcel is returned — so `mapAmazonStatus` looks at
`EasyShipShipmentStatus` first:

| Signal | Canonical status |
|---|---|
| `EasyShipShipmentStatus = ReturnedToSeller` | `rto` |
| `OrderStatus = Canceled` | `cancelled` |
| `EasyShipShipmentStatus = Delivered` | `delivered` |
| `OrderStatus = Shipped` | `shipped` |
| else (`Pending`, `Unshipped`, …) | `new` |

`ReturnedToSeller` is the **only** signal that an RTO physically reached the
warehouse; it is what puts a record into "ready to check in". The flat-file
backfill report has no Easy Ship column, so historical RTOs come through the
fast lane only.

**COD:** `PaymentMethod` is `"Other"` or blank for most of this account's COD
orders — the tell is the ship service level (`Std IN EZ National COD`), matched
with `/\bCOD\b/i` in both the live and report paths.

### Check-in — three stages

`order_status_events` carries `checked_in_at` / `checked_in_by` / `item_back` /
`checkin_note`. `getCancellationRecords` derives a `stage`:

- **`auto`** — the order never shipped (`from_status` not shipped-ish). Ingest
  closes it on the spot (`checked_in_by` null). Shows on **Completed** as "auto".
- **`awaiting`** — shipped, then `cancelled`/`returned`, and Amazon has **not**
  reported the parcel back. Shows on **Pending** with *no* tick — only a manual
  "mark not returning" write-off.
- **`ready`** — `to_status = rto`, i.e. Amazon marked `ReturnedToSeller`. Shows
  on **Pending** with the **Received & shelved** tick.
- **`done`** — `checked_in_at` set by a person (`checkInCancellation` records
  `item_back` and who). Shows on **Completed**. `reopenCancellation` undoes it.

## Product images

The Orders API gives no image, only an ASIN (`order_items.external_asin`, parsed
from both the live `orderItems` call and the flat-file report). After each
ingest, `enrichCatalogImages` fetches a main image per new ASIN via the Catalog
Items API — **capped at 20 ASINs per run**, fully best-effort (every failure
swallowed), results cached in `catalog_images` keyed by `(channel_account_id,
asin)`. An ASIN with no catalogue image is still recorded (null url) so it isn't
re-requested. Mapped products also get `products.image_url` back-filled. The UI
shows the image where present and a neutral placeholder tile otherwise.

## Schema application

Production applies schema with `npm run db:push` (drizzle-kit), not the
`drizzle/*.sql` migration files — those are kept for reference only. The push for
this change adds: `orders.channel_updated_at`, the `order_status_events` table,
and the `backfill` value on the `sync_kind` enum.

## Deferred — full two-lane sync wired into the app

Not built (decision noted 2026-08-31). The backfill is a script and
`backfillAccount()` only. A future version could:

- expose backfill as an owner-only action in Settings (date range picker →
  triggers `backfillAccount` via `after()` or a queue), with its progress shown
  through the existing `sync_runs` / `/api/sync-progress` plumbing;
- add a `report_jobs` table so a serverless invocation can create a report on
  one run and resume polling on a later one, instead of holding a single
  long-lived process open;
- reuse the same Reports-API client for Amazon **returns**
  (`GET_XML_RETURNS_DATA_BY_RETURN_DATE`), which is the other thing that needs
  persisted job state — see [CHANNELS.md](CHANNELS.md).
