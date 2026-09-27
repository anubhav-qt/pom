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

**TODO (wanted, not started):**

- **Account health** on the Finance screen: late-shipment, cancellation and
  on-time-delivery rates, defect rates and account status, from the
  `GET_V2_SELLER_PERFORMANCE_REPORT` report (readable with today's roles).
- **Sales & Traffic**: sessions, page views and conversion per product, from
  `GET_SALES_AND_TRAFFIC_REPORT` (also readable today).
- Return-label cost: the Returns report says the seller pays ₹92–₹138 per label,
  but no matching charge appears anywhere in the Finances ledger (checked on 347
  returns older than 45 days). Re-check periodically; if Amazon starts billing it,
  add it to the order net.

---

## 5. Backfill as an in-app action

`backfillAccount()` is script-only (`npm run backfill:amazon`). A future version
could expose it as an owner-only Settings action with a date-range picker,
reusing the existing `sync_runs` / `/api/sync-progress` progress plumbing.

---

## 6. Flipkart and Meesho: look through the first run's data

**TODO (next session):** the first seller-portal run (2026-09-27, see
[portals/procedure.md](portals/procedure.md)) wrote 178 Flipkart and 986 Meesho
orders, their returns and 1,732 money lines, reconciled to the rupee against
every payout. Nobody has looked through it in the app yet. Go through it in a
session of its own:

- Finance with the marketplace switch on Flipkart, then Meesho: do the month
  totals, fees, return costs and "Money with …" match what the portals show?
- Ledger › Orders: open a few orders of each kind (delivered, RTO, customer
  return, exchange, claim) and check each one's lines add up.
- Link the SKUs: 30 of Flipkart's 32 and all 18 of Meesho's are unlinked, so
  those orders show sales and fees but no profit.
- Flipkart takes TDS at 5%, not 0.1%: the PAN is probably not linked or active.
- 40 Flipkart orders from Feb–Mar with no payments were left out; they are only
  in the FY report, which is a download.
- Meesho return reasons were not read (`fetchReturnClaims` allows about one
  call a minute); read them on the next run.
- The two upcoming Meesho payouts differ from the portal (10-01: ₹−175 against
  ₹−157; 10-05: ₹0 against ₹488.98) because Meesho's order timeline lags; check
  that the next run replaces them.
- Build `npm run portal -- save` from the two generators in
  `tmp/portals/2026-09-27/` (`gen-flipkart.mjs`, `gen-meesho.mjs`). `tmp/` is
  not in git, so they are only on the machine that ran it.
