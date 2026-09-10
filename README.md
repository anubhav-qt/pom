<div align="center">

# 📦 Paribelle OMS

**Self-Hosted Multi-Channel Order Management & Dispatch System**

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
│       ├── scan.ts               # Universal barcode match engine (order ID, AWB, return ID)
│       └── stores/               # Zustand client caches for instant tab switching
└── scripts/                      # DB seeding, reconciliation, and channel validation CLI
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
| **Outbound Scanner** | ✅ Active | ZXing WebCam / HID | Barcode lookup, stock decrement, and dispatch transition. |
| **Label Crop Engine** | ⏸️ Parked | PDF-Lib | Crops shipping label from tax invoice to save thermal paper. |

---

## 🔒 Security & Compliance

- **Amazon SP-API Compliance**: Follows data protection rules with strict token rotation, AES encryption of credentials at rest, and zero persistent storage of personally identifiable buyer data beyond order completion.
- **Role-Based Routing**: Critical administrative functions (inventory resets, channel credentials, sync overrides) are restricted to owners.
- **Session Security**: Stateless, short-lived JWT sessions stored in HTTP-only, SameSite cookies scoped strictly to the `/pom` base path.

---

<div align="center">
  <sub>Built with care for PariBelle. High-throughput dispatch engineering at ₹0 monthly software cost.</sub>
</div>
