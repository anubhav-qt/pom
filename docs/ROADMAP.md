# Roadmap — v2 and later

Things deliberately left out of v1. None of these block day-to-day use of the
app as it stands (Amazon orders, status, cancellations/RTO, analytics, the
collection sheet).

---

## 1. Labels and pickup scheduling over the API

**Goal:** print Amazon labels and book courier pickups from inside this app, so
nobody has to open Seller Central.

**Blocker (confirmed against live credentials, 2026-08-31):** the SP-API app
holds none of the shipping roles. Every shipping endpoint returns
`403 Unauthorized`:

| Path | Result |
|---|---|
| `POST /easyShip/2022-03-23/timeSlot`, `GET /easyShip/2022-03-23/package` | 403 |
| `GET_EASYSHIP_DOCUMENTS` report | 403 |
| `GET /mfn/v0/shipments` (Buy Shipping) | 403 |
| `POST /shipping/v2/shipments/rates` | 403 |

Re-check any time with `npm run tsx scripts/probe-amazon-fulfillment.ts`.

**This account ships Amazon Easy Ship** (`EasyShipShipmentStatus` is populated on
orders). So the path is:

1. **Developer Central → the app → Edit app → add the "Direct-to-Consumer
   Shipping" role** (covers Easy Ship + Shipping v2 for IN). This is a
   *restricted* role: Amazon requires a data-protection / use-case questionnaire
   and approves it manually — days, sometimes with back-and-forth.
2. **Re-authorise the app** → new LWA refresh token → paste into Settings.
3. **Build the Easy Ship flow** — a stateful job:
   `listHandoverSlots` → `createScheduledPackage(slotId)` (this books the pickup
   *and* mints the label in one call) → `getPackageDocuments` (the label PDF).
   Needs a small `easyship_packages` job table and wiring into the pack screen.
   `fetchLabels` in `src/channels/amazon.ts` currently targets `/mfn/v0/shipments`
   (Buy Shipping) and must branch to Easy Ship for this account.

There is nothing to build against until steps 1–2 are done.

See [CHANNELS.md](CHANNELS.md) for the endpoint-level notes.

---

## 2. Flipkart integration

The adapter (`src/channels/flipkart.ts`) is written against the v3 Marketplace
Seller API but has **never run against live credentials**. To bring it online:

- Get Developer Access credentials from the Flipkart Seller Dashboard
  (`appId` / `appSecret` / `locationId`).
- Verify on first connection: the `/sellers/v3/returns` query params and
  response envelope key; the inventory-update body shape; `locationId` handling.
- Flipkart's unit of work is the **shipment**, not the order — the adapter
  already treats each shipment as one canonical order keyed by `shipmentId`.
- Labels come back as one merged PDF per ≤50 shipments.

Turning it on is: add real credentials in Settings, shake out field names in one
session (the Sync Log shows Amazon-style verbatim errors), flip nothing in code
if the adapter holds up.

---

## 3. Push sync

Syncing is triggered by opening the app, at most once every 30 minutes, plus
the Sync now button. There is no cron (decision 2026-09-10: a schedule was
added and then dropped in favour of the open trigger, which costs nothing when
nobody is looking at the data). Remaining option:

- **Push (no polling):** the Notifications API *is* available to this app
  (`GET /notifications/v1/destinations` → 200; `ORDER_CHANGE` subscription
  allowed). But SP-API push is **not a webhook / websocket** — it only delivers
  to an **Amazon SQS queue** or **EventBridge** you own. That means standing up
  an SQS queue + a consumer (or a Lambda that calls a Vercel webhook), plus a
  low-frequency reconcile sweep as a backstop. Worth it only once order volume
  or "must action within minutes" makes 15-minute latency a real problem.

Re-check with `npm run tsx scripts/probe-amazon-notifications.ts`.

---

## 4. Amazon returns and money — done (Sep 2026)

Customer returns now load from the Returns report
(`GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE`, up to 60 days per report) into the
`returns` table on every sync, and the Returns screen (`/returns`) is on.
Money loads from the Finances API v2024-06-19 into `finance_transactions`
(Finances v0 was retired 28 Aug 2026). Amazon lists deferred money twice; sums
must skip `DEFERRED_RELEASED` rows. A settlement group's RELEASED lines add up
to its payout. `npm run backfill:finance` loads history once. The Finance screen
(`/dashboard`) has an overview and an editable order ledger with CSV/Excel export.

Not built yet: the account-health metrics (Seller Performance report) and
Sales & Traffic (sessions, conversion) reports, both readable with the current
roles.

---

## 5. Backfill as an in-app action

`backfillAccount()` is script-only (`npm run backfill:amazon`). A future version
could expose it as an owner-only Settings action with a date-range picker,
reusing the existing `sync_runs` / `/api/sync-progress` progress plumbing.
