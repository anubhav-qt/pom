# Paribelle OMS

Order management for Amazon, Flipkart and Meesho — built to replace a ₹3.5k/month
subscription with something that costs about ₹0 to run and behaves the way the
warehouse actually works.

**Scope of v1:** the daily dispatch loop (order queue → pick → pack → label →
manifest), inventory sync, and returns/RTO check-in. Payment reconciliation and
P&L are deliberately **not** included.

---

## Current scope

The app is deliberately narrowed to **Amazon only**, and to one job: pull
everything Amazon will give us and keep it. The long-term goal is a unified
store across all marketplaces feeding insights, daily reports and a
natural-language chatbot.

Everything else — the packing station, label printing, manifests, inventory
push, returns check-in, Meesho import, Flipkart — is **switched off, not
deleted**, in [`src/config/features.ts`](src/config/features.ts). All of that
code is built and tested; flipping a flag brings it back.

```ts
export const FEATURES = {
  packStation: false,
  labelPrinting: false,
  inventoryManagement: false,
  returns: false,
  meeshoImport: false,
};

export const ENABLED_CHANNELS = ["amazon"] as const;
```

The flags are not cosmetic. A disabled channel is excluded from the cron sync,
the order queue and the settings list, so a parked channel cannot quietly fill
the sync log with failures. Disabled routes redirect to `/orders`.

## What works, and what it depends on

| Capability | Amazon | Flipkart | Meesho |
|---|---|---|---|
| Pull orders | Live (SP-API) | Live (Seller API v3) | File import |
| Shipping labels | Buy Shipping / MFN | Live | From uploaded PDF |
| Push inventory | Live | Live | Manual only |
| Returns / RTO | Not in v1 — see below | Live | Manual only |

The important asymmetry: **Meesho has no self-serve supplier API.** Credentials
are issued to onboarded integration partners, not to individual sellers. So
Meesho works by importing the order sheet and the combined label PDF straight
out of the supplier panel. It implements the same interface as the live
channels, so if API access ever arrives only `src/channels/meesho.ts` changes.

Full per-channel detail, including what still needs verifying against live
credentials, is in [docs/CHANNELS.md](docs/CHANNELS.md).

---

## Local testing (no marketplace accounts needed)

Everything below runs entirely on your machine. Docker is the only prerequisite.

```bash
docker compose up -d
```

That starts Postgres 16 on port **5433** (not 5432, so it cannot collide with an
existing install). `.env.local` already points at it.

```bash
npm install
npm run db:push
npm run seed:demo
npm run dev
```

Sign in at <http://localhost:3000/login>:

| Login | Password | Role |
|---|---|---|
| `dad@paribelle.test` | `password123` | owner |
| `staff@paribelle.test` | `password123` | staff (no settings access) |

`seed:demo` creates 10 products with bins and stock, 3 channel accounts, 30
orders across all three marketplaces with varied statuses and deadlines (two
deliberately late), 8 generated Meesho label PDFs, 3 returns awaiting check-in,
a deliberately unmapped SKU, and one failed sync-log entry. It refuses to run
against anything other than localhost, since it wipes the database first.

### Try the Meesho import

```bash
npm run fixtures:meesho
```

Writes `tmp/meesho-orders.xlsx` and `tmp/meesho-labels.pdf` shaped like real
supplier-panel downloads — including a cancelled row, an unlisted SKU, and a
trailing summary page that matches no order. Upload both at **Settings › Meesho
import**.

### Automated checks

```bash
npm run verify:meesho    # parser + label splitter, no server needed
npm run verify:import    # the upload endpoint, against a running dev server
npm run typecheck
npm run build
```

### Switching to a hosted database

`DATABASE_URL` decides the driver automatically — a `neon.tech` host uses Neon's
HTTP driver, anything else uses normal Postgres over TCP. So moving to
[Neon](https://console.neon.tech) for production is a one-line env change with
no code edits.

Generate real secrets for a deployed instance with:

```bash
node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"
```

### Creating a real login

```bash
npm run seed -- dad@example.com "a-good-password" "Papa"
```

Re-running this against the same email resets the password — that is the
password-reset mechanism for now.

### 4. Connect channels

Sign in, go to **Settings**, and add accounts:

- **Amazon** — Seller Central › Apps & Services › Develop Apps. Register a
  *private* app against your own seller account and complete the self-authorise
  flow to get an LWA refresh token. Put the app's client ID/secret in
  `.env.local` and the refresh token plus seller ID on the account.
- **Flipkart** — Seller Dashboard › Manage Profile › Developer Access › create a
  self-access application. You get an appId and appSecret.
- **Meesho** — just add an account with a name. There is nothing to configure;
  uploads happen on the same Settings page.

### 5. Map your SKUs

Orders arrive with the marketplace's SKU strings. Until each is mapped to a
product, it shows as **unmapped** in the queue and is not stock-controlled. The
Inventory page lists every unmapped SKU seen on a live order with a one-click
mapping form — that is the fastest way to build the catalogue.

---

## Deploying to Vercel

```bash
npx vercel
```

Set `DATABASE_URL`, `AUTH_SECRET`, `CRON_SECRET`, `AMAZON_LWA_CLIENT_ID` and
`AMAZON_LWA_CLIENT_SECRET` in the project's environment variables.

Order sync currently runs **only on demand** — the **Sync now** button in the
header (and per-account in Settings). There is no scheduled cron: `vercel.json`
has no `crons` entry (decision 2026-08-31, see [docs/ROADMAP.md](docs/ROADMAP.md)).
`/api/cron/sync` still exists and still works if called with `CRON_SECRET`, so
re-adding the schedule is a one-line change to `vercel.json`.

A manual sync is the **fast lane**: a rolling 72-hour window, and orders whose
Amazon `LastUpdateDate` is unchanged skip the slow per-order call entirely, so a
routine run is a second or two. One channel failing never stops the others.

Everything older than 72 hours comes from the **backfill** — run it once
against production before the first deploy:

```bash
npm run backfill:amazon
```

It uses the Reports API (one file per date range, no per-order rate limit),
covers the **last 6 months** by default (`--from` to go further), skips windows
it won't build rather than aborting, and is re-runnable from the backend later.

Cancellations and RTO are kept as their own dated records in
`order_status_events`, added on the next sync after Amazon changes the order; a
shipped-then-cancelled order waits under **Pending** until someone confirms the
parcel came back. Product images are pulled from the Catalog Items API
(best-effort, cached). Full detail: [docs/SYNC.md](docs/SYNC.md).

Check the live connection end to end (needs a saved account or a refresh token):

```bash
npm run check:amazon:full
```

> **Note on the free plan:** Vercel Hobby limits cron to once per day. The
> 10-minute schedule needs the Pro plan (~$20/mo), which still lands far under
> ₹3.5k. Alternatively, keep Hobby and drive the same endpoint from an external
> scheduler (cron-job.org, GitHub Actions) using the `CRON_SECRET` bearer token.

---

## The daily loop

1. **Orders** — everything open across all three channels, oldest deadline
   first. Late orders are flagged in red.
2. Select a batch → **Print labels**. One merged PDF in queue order, optionally
   cropped to drop the tax-invoice half and save thermal roll.
3. **Pack** — a scanner-driven screen. Scan the AWB, order ID or packet ID; it
   shows quantities and bin locations, refuses cancelled orders outright, and
   warns on a duplicate scan. Confirming takes stock off the shelf.
4. Back in **Orders**, select the packed batch → **Create manifest** for courier
   handover.

## How stock is kept honest

- `sellable = onHand − reserved − buffer`, floored at zero. That is what gets
  published to Amazon and Flipkart.
- `reserved` is **recomputed from the orders table**, never incremented. A
  derived number cannot drift after a failed sync or a duplicate event.
- `onHand` moves only through `adjustStock()`, which writes an
  `inventory_ledger` row every time. Every unit is accounted for.
- Stock is deducted at **pack** time, not order time — that is the moment the
  unit demonstrably leaves the shelf.
- Returns restock only when someone ticks "sellable". Marketplace returns come
  back damaged often enough that automatic restocking ships used goods to the
  next customer.

---

## Testing

```bash
npm run verify:meesho
```

Builds a realistic Meesho order sheet and label PDF from scratch and runs the
real parser and splitter over them — including the prefix-collision case where
a parent order ID is a substring of its sub-order IDs. This is the one part of
the system with no external API to lean on, so it is proven independently.

```bash
npm run typecheck
npm run build
```

---

## What this does not do

- **No payment reconciliation or P&L.** Out of scope for v1 by choice.
- **No GST reports.**
- **Amazon returns are not synced.** SP-API exposes them only through the
  asynchronous Reports API, which needs persisted job state across invocations.
  Cancellations and RTO still surface through order status changes.
- **Meesho inventory is manual.** No API, no push.
- **Labels for Amazon require Buy Shipping.** Easy Ship sellers need the Easy
  Ship API path — see docs/CHANNELS.md.

## The honest trade-off

This replaces a ₹42k/year bill, but the uptime becomes yours. If a marketplace
changes a report format and labels stop printing on a Monday morning, there is
no support line. The sync log in Settings is built for exactly that moment: it
records every attempt, what it wrote, and the verbatim error.
