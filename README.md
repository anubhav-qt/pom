<div align="center">

# 📦 Paribelle OMS

**Self-Hosted Multi-Channel Order Management & Dispatch System**

[![Version](https://img.shields.io/badge/version-1.0.0-0ea5e9?style=for-the-badge)](#-changelog)
[![Next.js](https://img.shields.io/badge/Next.js-15%20App%20Router-black?style=for-the-badge&logo=next.js)](https://nextjs.org/)
[![React](https://img.shields.io/badge/React-19-61dafb?style=for-the-badge&logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178c6?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16%20%2F%20Neon-336791?style=for-the-badge&logo=postgresql)](https://neon.tech/)
[![Drizzle ORM](https://img.shields.io/badge/Drizzle-ORM-c5f74f?style=for-the-badge&logo=drizzle)](https://orm.drizzle.team/)
[![TailwindCSS](https://img.shields.io/badge/Tailwind-CSS-38bdf8?style=for-the-badge&logo=tailwindcss)](https://tailwindcss.com/)
[![Amazon SP-API](https://img.shields.io/badge/Amazon-SP--API-ff9900?style=for-the-badge&logo=amazon)](https://developer-docs.amazon.com/sp-api/)
[![Vercel](https://img.shields.io/badge/Deploy-Vercel-black?style=for-the-badge&logo=vercel)](https://vercel.com/)

**Production Endpoint:** [https://paribelle.in/pom](https://paribelle.in/pom) &nbsp;|&nbsp; **Direct Preview:** [https://pom-vert.vercel.app/pom](https://pom-vert.vercel.app/pom)

```
─────────────────────────────────────────────────────────────
  replaces a ₹42,000/year SaaS bill with zero-cost serverless
─────────────────────────────────────────────────────────────
```

</div>

---

## 💡 Why This Exists

Commercial e-commerce OMS tools in India charge between ₹3,500 and ₹15,000 every month for basic order sync, inventory deduction, and barcode scanning. Most are bloated with slow UIs, aggressive lock-ins, and rigid workflows that do not match the physical reality of an Indian warehouse.

**Paribelle OMS (POM)** is an in-house dispatch and order management engine built specifically for our operations. It runs on serverless Next.js and Neon PostgreSQL at virtually **₹0/month**, while offering:

1. **Sub-second fast-lane sync**: Amazon SP-API delta sync runs in 1 to 2 seconds by skipping unchanged records.
2. **Instant UI interactions**: Tab switches, sub-queue views, and date range switches load from a client-side cache with 0ms server latency.
3. **Physical bench alignment**: The 3-stage dispatch pipeline separates Amazon's marketplace opinions from the warehouse floor.
4. **Resilient stock control**: Stock deduction occurs at physical scan time, and reservations are computed directly from live orders.

---

## 🔄 3-Stage Dispatch Workflow

Marketplaces like Amazon Easy Ship flip an order's status to `Shipped` the second a seller downloads shipping labels in Seller Central. On the warehouse floor, however, the parcel has only been boxed: it still sits on a rack waiting to be scanned and handed to the delivery courier.

POM solves this by decoupling marketplace opinion (`orders.status`) from warehouse floor reality (`orderFulfilment.state`):

```
┌───────────────────────────┐      ┌───────────────────────────┐      ┌───────────────────────────┐
│        1. UNSHIPPED       │      │         2. PACKED         │      │      3. SHIPPED (24H)     │
│                           │ ---> │                           │ ---> │                           │
│ Awaiting label generation │      │ Label printed on Amazon   │      │ Scanned at outbound bench │
│ on Amazon Seller Central. │      │ (EasyShip: PendingPickUp) │      │ within the last 24 hours. │
│ Pending orders badged red.│      │ Awaiting dispatch scan.   │      │ Manifested & stock moved. │
└───────────────────────────┘      └───────────────────────────┘      └───────────────────────────┘
```

| Queue Stage | Source & Data Predicate | Floor Meaning |
|---|---|---|
| **Unshipped** | `orders.status IN ('new', 'ready_to_pack')` AND `orderFulfilment.state = 'to_pack'` AND `easyshipStatus <> 'PendingPickUp'` | New orders awaiting label creation. Orders with payment clearance pending on Amazon display a subtle red **pending** badge. |
| **Packed** | (`orders.easyshipStatus = 'PendingPickUp'` OR `orderFulfilment.state = 'packed'`) AND `orderFulfilment.state <> 'manifested'` | Shipping label downloaded on Amazon Seller Central. The parcel is boxed and awaiting physical barcode scanning at dispatch. |
| **Shipped (24h)** | `orderFulfilment.state = 'manifested'` AND `manifestedAt >= now() - INTERVAL '24 hours'` | Confirmed outbound scans within the past 24 hours. Distinct from the top navigation "Shipped" tab which retains all-time historical channel dispatches. |

---

## 🏛️ Architecture & System Topology

POM is mounted at `/pom` behind our primary storefront (`paribelle.in`) via Next.js multi-zone rewrites, functioning as a standalone service with zero runtime coupling:

```
                      paribelle.in (Storefront / Proxy)
                                    │
                  ┌─────────────────┴─────────────────┐
                  ▼                                   ▼
        Storefront Routes (/)                 Rewrite (/pom/*)
                  │                                   │
      paribelle-web (Next.js 14)                      ▼
                                            POM OMS (Next.js 15)
                                          (Base path: /pom)
                                            │               │
                 ┌──────────────────────────┴────┐          │
                 ▼                               ▼          ▼
       Neon Serverless Postgres           Amazon SP-API   Web Barcode Scanner
         (Orders, Shipments, Ledger)     (Orders, Sync)  (Outbound & Inbound)
```

### Directory Structure

```
f:\oms\
├── src/
│   ├── app/
│   │   ├── (app)/
│   │   │   ├── orders/           # 3-stage queue, pick lists, planner, barcode scanner
│   │   │   ├── dashboard/        # KPIs, sales analytics, multi-range client cache
│   │   │   ├── inventory/        # Stock ledger, on-hand adjustments, SKU mappings
│   │   │   ├── returns/          # Inbound returns check-in & condition assessment
│   │   │   ├── seelie/           # Seelie, the AI agent: chats, timeline, composer, settings
│   │   │   └── settings/         # Channel credentials, manual sync triggers
│   │   ├── api/
│   │   │   ├── cron/sync/        # Scheduled / triggered channel ingest route
│   │   │   └── labels/           # Thermal label crop & bulk PDF generation
│   │   └── login/                # Password & TOTP multi-factor authentication
│   ├── channels/
│   │   ├── amazon.ts             # Amazon SP-API LWA auth, rate-limited orderItems, reports
│   │   ├── flipkart.ts           # Flipkart Seller API integration
│   │   └── meesho.ts             # Meesho order-sheet & label splitter
│   ├── db/
│   │   ├── schema.ts             # Drizzle ORM schema (PostgreSQL)
│   │   └── index.ts              # Neon HTTP serverless / TCP node-postgres client
│   └── lib/
│       ├── fulfilment.ts         # Bench state machine & queue predicates
│       ├── profit.ts             # Finance: profit per marketplace, or all of them together
│       ├── reels/                # Beat-matched reels: AI direction, songs, rendering, feedback
│       ├── seelie/               # Seelie's engine, prompt, model accounts (CLIProxyAPI), tools
│       ├── scan.ts               # Universal barcode match engine (order ID, AWB, return ID)
│       └── stores/               # Zustand client caches for instant tab switching
├── packages/                     # pi-ai and pi-agent: Seelie's harness, a vendored pi fork (npm workspaces)
├── docs/                         # Procedures for Claude Code / Antigravity, runbooks
└── scripts/                      # DB seeding, reconciliation, portal import, songs, reel feedback CLI
```

---

## ⚡ Core Engine Features

### 1. Dual-Track Sync: Fast-Lane & Historical Backfill
- **Fast-Lane Delta (72h)**: Compares Amazon's `LastUpdateDate` against our stored timestamp. If unchanged, the rate-limited `orderItems` API call is bypassed. Routine syncs take 1 to 2 seconds.
- **Bulk Reports Backfill**: Pulls months of historical sales in seconds via the flat-file Orders Report, bypassing per-operation token bucket throttles.

### 2. Client-Side State Cache (Zustand)
- Order queues and analytics dashboards are cached in memory.
- Switching between **Unshipped**, **Packed**, and **Shipped (24h)** updates the URL with `window.history.pushState` and renders instantly with zero loading spinners.
- The cache auto-invalidates on manual scans, pack actions, or sync completions.

### 3. Barcode Scanning Station
- Works via camera stream on mobile devices or USB barcode guns on desktop benches.
- Accepts any barcode on the label: Order ID, courier AWB, or Easy Ship packet ID.
- Automatically rejects cancelled or returned orders with an audio-visual warning to prevent sending dead parcels.

### 4. Deterministic Stock Ledger
- Formula: `sellable = onHand - reserved - buffer`, floored at zero.
- `reserved` is never stored or manually incremented: it is recomputed dynamically from open orders to eliminate drift.
- `onHand` moves exclusively through an append-only `inventory_ledger`.

---

## 🚀 Quick Start (Local Setup)

### 1. Prerequisites
- **Node.js 20+** & npm
- **Docker Desktop** (for local PostgreSQL instance)

### 2. Start Local Database
```bash
# Starts PostgreSQL 16 on port 5433 (avoiding conflicts with default 5432)
docker compose up -d
```

### 3. Install & Seed
```bash
npm install
npm run db:push

# Seeds demo products, channel accounts, sample orders, and thermal label PDFs
npm run seed:demo
```

### 4. Run Development Server
```bash
npm run dev
```

Seelie needs CLIProxyAPI next to the dev server (without `CLIPROXY_URL` it shows offline). Put the [release](https://github.com/router-for-me/CLIProxyAPI/releases) for your machine in `.cliproxy/bin/` (gitignored), set `CLIPROXY_URL=http://127.0.0.1:8317`, `CLIPROXY_API_KEY` and `CLIPROXY_MANAGEMENT_KEY` in `.env.local`, run `npm run cliproxy` in a second terminal, then connect a subscription in Seelie's settings (gear). Its store tools appear when `PARIBELLE_API_URL` points at a paribelle.in API (`…/api/v1`); test them against a local one only. Its video tools keep their media in `.seelie-media/` (gitignored; `SEELIE_MEDIA_DIR` moves it) and need yt-dlp on the PATH (or `YTDLP_PATH`) for YouTube and songs; the first background cut-out downloads its 115 MB model there, and the photo tools download theirs (LaMa, SlimSAM, Real-ESRGAN) on first use.

Visit **http://localhost:3000/pom** (or configured port) and log in:

| Account | Password | Role | Scope |
|---|---|---|---|
| `admin@paribelle.com` | `mbr0UALs1MnVGKWe@6` | Owner | Full system & settings access |
| `dad@paribelle.test` | `password123` | Owner | Full access (demo data) |
| `staff@paribelle.test` | `password123` | Staff | Dispatch queue & scan stations only |

---

## 🛠️ CLI Utilities & Verification Scripts

POM comes with dedicated CLI scripts for maintenance and channel debugging:

```bash
# Database & Authentication
npx tsx scripts/seed.ts "<email>" "<password>" "<name>"   # Create owner login or reset password
npx tsx scripts/mfa-reset.ts "<email>"                    # Reset MFA for lost authenticator

# Channel Connectivity & Sync
npm run check:amazon                                      # Amazon SP-API configuration audit
npm run check:amazon:full                                 # End-to-end token & orders test
npm run backfill:amazon -- --from 2026-01-01              # Bulk ingest historical reports
npm run reconcile:amazon                                  # Repair order statuses against Amazon

# Reels (see docs/reels/procedure.md and docs/reels/feedback.md)
npm run songs -- known                                    # Every song the database knows, used or not
npm run songs -- vet songs.json                           # Check a candidate batch before adding it
npm run songs -- batch songs.json                         # Add songs (audio, beats, hook)

# Seelie
npm run cliproxy                                          # Run CLIProxyAPI from .cliproxy/ for local Seelie
npm run reels:feedback                                    # "Do you like this reel?" answers, by prompt version

# Verification & Test Suites
npm run verify:meesho                                     # Test Meesho PDF splitter & parser
npm run typecheck                                         # Static TypeScript check (tsc --noEmit)
npm run build                                             # Production Next.js build
```

---

## 📋 Feature Flags & Marketplace Support

Marketplaces and features can be activated or parked without code removal in [`src/config/features.ts`](src/config/features.ts):

| Module | Status | Mode | Notes |
|---|:---:|---|---|
| **Amazon SP-API** | ✅ Active | Live API | Full order sync, Easy Ship tracking, and inventory push. |
| **Flipkart API** | ⏸️ Parked | Live API (v3) | Built and tested. Re-enabled by adding to `ENABLED_CHANNELS`. |
| **Meesho Ingest** | ⏸️ Parked | File Parser | Excel order sheet and PDF label splitter ready in UI. |
| **Flipkart & Meesho data** | ✅ Active | Seller-portal procedure | Orders, returns and payments read off the portals in Claude's browser ([`docs/portals/procedure.md`](docs/portals/procedure.md)), counted in Finance and by Seelie. Not on the Orders screen. |
| **Finance** | ✅ Active | Settlement lines | Real profit per order, for one marketplace or all of them (switch at the rail's right end). |
| **Reels** | ✅ Active | Gemini + ffmpeg | Beat-matched reels from a shoot or a supplier video; "Do you like this reel?" feedback tunes the AI director. |
| **Seelie** | ✅ Active (ThinkPad) | AI agent | The OMS's agent on its own screen: orders, returns, money, catalogue, sync, reels, read-only SQL and paribelle.in, with every step shown and Approve/Deny on changes. Makes videos of the products (its own ffmpeg graphs, watched and fixed draft by draft), product photoshoots (the only thing that uses the image model's limited budget) and photo edits in code, searches the web and YouTube, and publishes to paribelle.in, the OMS catalogue, Amazon's image slots and Instagram when asked. Models through CLIProxyAPI on the ThinkPad only; offline on Vercel. |
| **Outbound Scanner** | ✅ Active | ZXing WebCam / HID | Barcode lookup, stock decrement, and dispatch transition. |
| **Label Crop Engine** | ⏸️ Parked | PDF-Lib | Crops shipping label from tax invoice to save thermal paper. |

---

## 🔒 Security & Compliance

- **Amazon SP-API Compliance**: Follows data protection rules with strict token rotation, AES encryption of credentials at rest, and zero persistent storage of personally identifiable buyer data beyond order completion.
- **Role-Based Routing**: Critical administrative functions (inventory resets, channel credentials, sync overrides) are restricted to owners.
- **Session Security**: Stateless, short-lived JWT sessions stored in HTTP-only, SameSite cookies scoped strictly to the `/pom` base path.

---

## 🧭 Procedures (for Claude Code and Antigravity)

Recurring jobs are written as procedures an agent follows with the owner. Each one records at its end what the next run needs, so runs get quicker.

| Procedure | What it does | Start it with |
|---|---|---|
| [`docs/portals/procedure.md`](docs/portals/procedure.md) | The owner logs in to Flipkart Seller Hub and the Meesho Supplier Panel in Claude's browser; Claude reads the orders, returns and payments there and writes them to the database, so Finance covers every marketplace. The first run reads everything; later runs start where the last one stopped. | "Read docs/portals/procedure.md and run it." |
| [`docs/reels/procedure.md`](docs/reels/procedure.md) | Finds trending songs on YouTube with the owner, after checking every song the database already has or has used, and adds the approved ones to the reel library. | "Read docs/reels/procedure.md and let's find new songs." |
| [`docs/reels/feedback.md`](docs/reels/feedback.md) | Reads the "Do you like this reel?" answers and proposes changes to the reel director's prompt. | "Read docs/reels/feedback.md and review the reel feedback." |

---

## 📜 Changelog

The version lives in `package.json` and shows at the foot of Settings.

### Unreleased

- **Seelie** replaces the assistant popup: an AI agent on its own screen (after Reels in the switcher; the AI button on phones) that can do what the site does, with every step, its thinking and each tool's result shown, and Approve / Deny on changes (paribelle.in and marketplace changes always ask). Chats are saved and listed in the header rail; a model and thinking-level picker and each subscription's 5-hour and weekly limits sit in the composer and settings. It runs on the ThinkPad, through CLIProxyAPI (the `cliproxy` service); on Vercel it shows offline.
- **Seelie's video suite.** Seelie edits videos itself: it writes an ffmpeg filter graph (any filter, sandboxed to its own media), renders a draft, watches it with sound, fixes it and renders a final (up to 35 s and 1080p, any shape). Every version is kept in a video library with its recipe, and the owner's likes and notes guide the next ones. Around it: background removal (BiRefNet, on the CPU), Google-grounded web search, page reading, YouTube search and watching, and adding library songs. Clips up to 300 MB can be attached in the composer (uploaded in pieces with a progress chip); finished videos have Download and Share, and go to a paribelle.in product's gallery or to Instagram as a reel, each after an Approve.
- **Seelie's product studio.** Product photoshoots with Gemini 3.1 Flash Image: Seelie gathers every photo of a product (the OMS, Amazon's catalogue, paribelle.in, the chat), studies them up close, writes a garment spec, plans a shot list from Nunjucks prompt templates (free to check), and shoots after an Approve that shows each look and what it costs. Recurring models (personas) keep a set to one person. Every result comes with a compare sheet and colour check (CIEDE2000) against our own photo, and is fixed in code before any retake. Everything else is code, not generation: cut-outs and backgrounds, catalogue white, crops and marketplace sizes (presets checked against the official docs), grading and light, retouching (LaMa), selections (SlimSAM), upscaling (Real-ESRGAN) and removing Gemini's visible watermark. The image model's hidden cap (about 9 images per 5 hours per account) is kept in a ledger: Seelie plans around it, looks that hit it wait for the owner's "continue", Seelie's settings show an Image generation bar, and a note anywhere in the OMS says when photoshoots are back. Pictures Seelie makes show in the chat with Download, and go to paribelle.in, the OMS catalogue photo (on paribelle.in's image host, with a copy kept on the ThinkPad) or Amazon's image slots (the main slot only for a real photo on pure white), each after an Approve. Unchosen attempts are cleared after 30 days.
### 1.0.0 (2026-09-27)

- **Every marketplace in Finance.** Flipkart and Meesho orders, returns and payments are read off their seller portals by Claude in its browser (the owner logs in; `docs/portals/procedure.md`) and written in the same shape as Amazon's settlement lines. Finance adds all marketplaces together, with a switch for one at a time; the assistant's sales figures count them all too.
- **Reel feedback.** Under every finished reel: "Do you like this reel?" The answer is saved with a copy of the reel and the prompt version that directed it; `npm run reels:feedback` and `docs/reels/feedback.md` turn the answers into prompt changes.
- **Procedures** for the seller portals, finding songs, and tuning the reel director (above).
- Songs: `npm run songs -- known` and `vet` check every song the database already has, including the older experiment's catalogue, before new ones are suggested.
- Every product photo opens full screen when tapped, the Orders table's rows, the Returns desk, the Finance ledger and the Reels photos included.
- The scan bench shows what a scan found: the order and each item's photo, name, size and colour, before asking whether it came back sellable.

### 0.1.0

Everything before: Amazon SP-API sync, the 3-stage dispatch bench, Finance and the Ledger, the Returns desk, the PDF label printer, Reels, and the ThinkPad hosting with the Vercel/Render fallback.

---

<div align="center">
  <sub>Built with care for PariBelle. High-throughput dispatch engineering at ₹0 monthly software cost.</sub>
</div>
