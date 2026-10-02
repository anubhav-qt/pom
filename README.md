<p align="center">
  <img src="docs/readme/header.svg" alt="PariBelle POM" width="760">
</p>

<p align="center">
  <a href="https://www.paribelle.in/pom">paribelle.in/pom</a>
  &nbsp;·&nbsp; Next.js 15 &nbsp;·&nbsp; Postgres &nbsp;·&nbsp; Drizzle &nbsp;·&nbsp; v1.0.0
</p>

POM is PariBelle's order management system. It takes orders from the marketplaces, runs the
dispatch bench, counts the money, and has an AI agent, Seelie, that can do everything the site
can and make the photos and videos the products need.

## Seelie

Seelie is an AI agent with its own screen in POM. You talk to it in a chat. It shows every step
it takes, its thinking and each tool's result. It asks before it changes anything.

**Runs the shop**
- Finds orders, opens their details and lines up the floor: what to pack, cancellations, scan lookups.
- Works the returns desk, order notes and Finance (profit per order, any marketplace, any period).
- Edits products and stock, pushes stock to the marketplaces and plans restocks.
- Checks and starts marketplace syncs, reads Amazon listings, maps the catalogue and calls SP-API.
- Manages paribelle.in: lists, adds, edits and removes products, uploads photos, and finds Amazon items missing from the store.
- Answers anything else with read-only SQL on the OMS database.

**Makes videos**
- Writes its own ffmpeg filter graph, renders a draft, watches it with sound, fixes it and renders a final. Up to 35 s and 1080p, in any shape.
- Keeps every version in a video library with its recipe. Your likes and notes guide the next ones.
- Cuts out backgrounds (BiRefNet), adds songs from the library, and takes clips up to 300 MB attached in the chat.

**Makes photos**
- Product photoshoots with Gemini 3.1 Flash Image. Seelie gathers every photo of the product, writes a garment spec, plans the shots from templates and shows what each look costs before it shoots. Recurring models keep a set to one person.
- Checks each result against our own photo: a compare sheet and a colour check (CIEDE2000).
- Does every other edit in code, at no cost: cut-outs, backgrounds, catalogue white, crops and marketplace sizes, grading, retouching (LaMa), selections (SlimSAM), upscaling (Real-ESRGAN) and watermark removal.
- Plans around the image model's limit (about 9 images per 5 hours per account), which settings show as a bar.

**Publishes**
- Videos to a paribelle.in product's gallery.
- Photos to paribelle.in, the OMS catalogue or Amazon's image slots. The main slot only takes a real photo on pure white.
- Instagram posts on Paribelle's account: reels, photos, carousels and stories, captions written in the brand's voice. Every post asks.

**Runs Meta ads**
- Reads what posts and ads reach, then suggests an ad: promote a post, a reel or a photo, for traffic to paribelle.in, engagement, video views or reach.
- Every new ad, restart or bigger budget asks, and must fit under the monthly cap set in settings. Seelie may pause an ad or lower its budget on its own.
- Ads are built paused and switched on last, with an end date. One Meta system-user token, pasted in settings, covers posting and ads.

**Researches**
- Searches the web with Google grounding, reads pages, and searches and watches YouTube.

**Runs routines**
- A routine is a message Seelie gets on a schedule (every few hours, daily, chosen weekdays or a day of the month, India time) and answers in the routine's own chat. Make them in Routines on Seelie's screen, or ask in a chat ("every Monday at 9, send me the ads report").
- Ad spend, posts, marketplace and paribelle.in changes still wait for you; each routine can auto-approve changes to the OMS. A note anywhere in the OMS says when a routine ran, and whenever one waits for your approval.
- A routine's chat compacts itself when it passes 60% of the model's context: older runs are summed up for Seelie, the last three stay word for word, and you still see everything.

**How it works**
- Reading never asks. Changes ask with Approve / Deny, unless you turn on auto-approve for a chat. Marketplace, paribelle.in, Instagram, ad spend and other paid changes always ask.
- Models come from your own subscriptions (Google Antigravity, ChatGPT Codex or Claude) through [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). The composer has a model and thinking-level picker, and settings show each account's 5-hour and weekly limits.
- Chats are saved and Seelie names them. The composer shows how much of the model's context the chat uses. A reply keeps running when you close the tab and picks up where it was when you come back.
- Seelie runs on the ThinkPad, next to CLIProxyAPI. On the Vercel fallback it shows offline.

## The rest of POM

| Screen | What it does |
|---|---|
| **Orders** | Amazon orders in three queues: Unshipped, Packed and Shipped (24h). Pick lists, a restock planner and a scan bench that takes a camera or a USB scanner and rejects cancelled parcels. |
| **Returns** | Customer returns: on their way, arrived, not received, done. Scanned in with each item's photo, then marked sellable or not. |
| **Finance** | Real profit per order from settlement lines, for Amazon, Flipkart and Meesho together or one at a time, with a ledger. |
| **PDF printer** | Marketplace label PDFs in, one four-up label sheet out. |
| **Reels** | Beat-matched reels from a shoot or a supplier video, directed by Gemini, with "Do you like this reel?" feedback that tunes the director. |

Amazon syncs live through SP-API: a fast delta sync, report backfills and reconciliation.
Flipkart and Meesho orders, returns and payments are read off their seller portals by an agent
([procedure](docs/portals/procedure.md)). They show in Finance and Seelie, not on Orders.

Parked, built but switched off in [`src/config/features.ts`](src/config/features.ts): the pack
station, inventory management, label cropping, Meesho import and the Flipkart API.

Sign-in uses a password with optional TOTP. Owners and staff share the screens. Settings and
Seelie's owner-only tools are for owners.

## Where it runs

The ThinkPad serves paribelle.in, its API and POM from Docker, with its own Postgres. Vercel,
Render and Supabase stay as the fallback, and the two sides sync every second. See
[`infra/README.md`](infra/README.md).

## Run it locally

```bash
docker compose up -d        # Postgres 16 on port 5433
cp .env.example .env.local  # then fill it in
npm install
npm run db:push
npm run seed:demo           # demo products, orders and logins
npm run dev                 # http://localhost:3000/pom
```

To run Seelie locally:
1. Put the [CLIProxyAPI release](https://github.com/router-for-me/CLIProxyAPI/releases) for your machine in `.cliproxy/bin/`.
2. Set `CLIPROXY_URL=http://127.0.0.1:8317`, `CLIPROXY_API_KEY` and `CLIPROXY_MANAGEMENT_KEY` in `.env.local`.
3. Run `npm run cliproxy` in a second terminal.
4. Connect a subscription from Seelie's settings.

The store tools need `PARIBELLE_API_URL`, and video tools need yt-dlp on the PATH. Media lives
in `.seelie-media/`.

| Command | |
|---|---|
| `npm run typecheck` / `npm run build` | Check and build |
| `npm run check:amazon` / `check:amazon:full` | Test the Amazon connection |
| `npm run backfill:amazon -- --from 2026-01-01` | Pull past orders from reports |
| `npm run reconcile:amazon` | Repair order statuses against Amazon |
| `npm run seed -- <email> <password> <name>` | Make an owner login or reset a password |
| `npm run mfa:reset -- <email>` | Clear a lost authenticator |
| `npm run songs` / `npm run reels:feedback` | Reel songs and feedback |
| `npm run mcp:db` | Read-only SQL over MCP for Claude Desktop or Claude Code ([mcp/](mcp/README.md)) |

## Procedures

Recurring jobs that an agent runs with the owner:
[seller portals](docs/portals/procedure.md), [finding songs](docs/reels/procedure.md) and
[tuning the reel director](docs/reels/feedback.md).
