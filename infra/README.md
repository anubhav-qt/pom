# Paribelle on the ThinkPad

The storefront, the API and the OMS run on the ThinkPad (Arch, Docker), with its Postgres as
the source of truth. Vercel, Render and Supabase stay exactly as they are, as the fallback:
when the ThinkPad can't answer (off, asleep, offline, restarting, catching up), requests go
to them instead, and what they write comes back to the ThinkPad before it serves again.
Everything runs on free plans.

```
visitor ─► Cloudflare ─► paribelle-edge Worker ──(tunnel + edge key)──► ThinkPad: gate ─► apps ─► Postgres
                               │                                                                   ▲
                               │ the ThinkPad can't answer                           sync (both ways,
                               ▼                                                      every second)
                  www: Vercel, as before · api: Render ──────────────────────────► Supabase ◄──────┘
```

| Address | ThinkPad (through the tunnel) | Fallback |
|---|---|---|
| `www.paribelle.in` | gate → storefront (`web`) | Vercel: www's DNS record, as today |
| `www.paribelle.in/pom` | gate → OMS (`oms`) | Vercel (the storefront project passes `/pom` to the OMS project, as today) |
| `api.paribelle.in` | gate → API (`api`) | Render, `paribelle-backend.onrender.com` |

`paribelle.in` itself still goes straight to Vercel, which sends visitors on to `www`.

## How it holds together

- **The Worker only forwards.** `paribelle-edge` (`edge/edge.ts`) asks the ThinkPad first,
  and if the ThinkPad can't take the request, sends it on to where it always went. That's
  about a millisecond of CPU a request, inside the free plan: 100,000 requests a day. Past
  that, Cloudflare skips the Worker until the next day ("fail open") and `www` goes straight
  to Vercel, as before the ThinkPad.
- **Pages served by Vercel** call Render directly (their build has Render's address); pages
  served by the ThinkPad call `api.paribelle.in`. So during an outage nothing depends on the
  ThinkPad or the Worker's daily allowance.
- **The gate** (Caddy) only lets in requests carrying `EDGE_KEY`, which only the Worker has,
  and asks the sync before each one. If the sync says the ThinkPad isn't caught up, or an app
  is down, it answers `503 x-paribelle-standby` and the Worker uses the fallback. Nothing on
  the home network listens: the tunnel dials out.
- **Failover** (`edge/failover.ts`): anything the ThinkPad never received (standby, tunnel
  down, gate refused, app unreachable) goes to the fallback, POSTs included. A GET also goes
  there on a 502/503/504, after 8 s without an answer (15 s for the OMS), or on a network
  error. A POST that may have reached the app is never sent twice; the visitor sees an error
  and retries. After a failure the Worker leaves the ThinkPad alone for 20 s.
- **The sync** (`sync/`) keeps each ThinkPad database and its Supabase copy in step, both
  ways, every second. The gate opens only once a pull has found nothing more waiting, so what
  the fallback wrote is on the ThinkPad before it serves. It also runs the ThinkPad's timed
  jobs (below).
- **Parallel work.** The storefront and the OMS each run one process per core (up to 8;
  `cluster.cjs`), so a slow report, PDF or reel holds up one process, not the app. Postgres
  runs parallel queries across the cores. The OMS's order sync runs every marketplace account
  side by side. The API stays one process: its live stock updates and rate limits keep state
  in memory.
- **Ids.** Each cloud sequence is kept 100,000 ahead of the ThinkPad's, so rows created on
  both sides during an outage never share an id. Ids therefore have gaps.
- **Conflicts.** A row changed on both sides between two syncs: the later change wins on
  both, and the losing version is kept in `paribelle_sync.conflicts` for you to look at.
- **Space.** The ThinkPad keeps everything. When a Supabase database passes `PRUNE_AT_MB`,
  old rows (`sync/policy.json`) are deleted from the cloud only, and never copied back. The
  reels' song library is never pruned, so reels keep working on Vercel.

### Timed jobs (on the ThinkPad)

| Job | Every | What |
|---|---|---|
| `oms-orders` | 10 min | the OMS's Amazon/Flipkart sync, while the ThinkPad serves the OMS; accounts already syncing are skipped |
| `render-awake` | 10 min | Render's health check, so it's awake when it's needed (its free plan sleeps after 15 idle minutes) |
| backups | 03:00 | both databases, encrypted, to the `backups` volume and R2 |
| reconcile | 04:00 | a full comparison of each database with its cloud copy |
| heartbeat | 5 min | Healthchecks.io, only while everything is synced and serving |

`docker compose exec sync node src/main.ts status` shows each job's last run.

### Seelie (the ThinkPad only)

Seelie, the OMS's AI agent, reaches its models through CLIProxyAPI (the `cliproxy` service),
which turns the owner's AI subscriptions into one API. Only the OMS reaches it, inside the
stack's network; on Vercel `CLIPROXY_URL` is unset and Seelie shows offline.

- **Keys.** `CLIPROXY_API_KEY` and `CLIPROXY_MANAGEMENT_KEY` in `.env` (`openssl rand -hex 24`
  each). The service writes its config from them at every start; without them it waits,
  unhealthy, and the rest of the stack carries on.
- **Subscriptions.** Sign in from Seelie's settings (the gear): Antigravity, Codex or Claude
  opens in a new tab, and you paste the address it ends on back into Seelie. The sign-ins
  live in the `cliproxy` volume (not in the backups: sign in again after losing the disk).
- **paribelle.in.** Seelie's store tools call the API straight (`http://api:3001/api/v1`),
  with the owner's admin login saved, encrypted, in the OMS database.
- **Chats stay here.** The `seelie_*` tables aren't synced to Supabase (`sync/policy.json`).
- **Videos.** Seelie renders with the image's ffmpeg, one render at a time, at low priority.
  Its media (uploaded clips, renders, fonts, photoshoot pictures, local copies of the OMS
  catalogue photos, and the cut-out, inpainting, selection and upscaling models, downloaded
  on first use) lives in the `seelie-media` volume at `/data/seelie`, not in the database
  and not in the backups. yt-dlp is in the image, pinned (`YTDLP_VERSION` and its
  checksum in the Dockerfile; bump both together when YouTube breaks it).
- **Instagram.** Paste the shop account's long-lived token in Seelie's settings (the
  Instagram panel); it's kept encrypted and renewed by itself. Instagram fetches each reel
  from a signed two-hour link under `SEELIE_PUBLIC_URL` (default `https://www.paribelle.in`,
  which the Worker forwards to `/pom` here), so publishing needs the tunnel up.
- **Photoshoots.** The image model (`gemini-3.1-flash-image`, through the Antigravity
  sign-ins) has a cap Google doesn't show, about 9 images per 5 hours per account; Seelie
  keeps its own ledger (`seelie_image_calls`) and each extra Antigravity sign-in adds to it.
- **paribelle.in product videos** go through the API's admin `POST /upload/product-video`
  (Cloudinary), then last in the product's photos, where the storefront gallery plays them.
- **Version.** The image is pinned to the release Seelie was tested with; to move it, set
  `CLIPROXY_IMAGE` in `.env` and `docker compose up -d cliproxy`.

## Setting up

In this order. Nothing changes for visitors until the last step of 2.

### 1. GitHub

- **pom**: secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (from 2). Every push to
  `production` then tests and publishes the sync's and the OMS's images and deploys the Worker.
- **paribelle-web**: nothing. Every push to `main` publishes the storefront's image.
- **paribelle-backend**: nothing. Every push to `main` publishes the API's image (Render keeps
  building `main` itself, as now).
- The images are public, like breader's: they hold the repositories' code (public anyway)
  and no settings, so the ThinkPad pulls them without logging in. (Were you to make them
  private, `GHCR_TOKEN` in `.env` is a classic token with `read:packages`.)

### 2. Cloudflare (the account breader is on)

`paribelle.in` lives in this account too (moved from its own account on 27 Sep 2026; its
nameservers at GoDaddy are this account's pair).

1. **Tunnel**: Networking › Tunnels › Create Tunnel, named `paribelle-thinkpad`. Its install
   command (any system) ends in the token → `TUNNEL_TOKEN`. Then the tunnel's Routes › Add
   route › Published application: `laptop` . `paribelle.in` → **`http://gate:8080`**
   (Cloudflare adds the DNS record itself).
2. **R2**, for backups: a bucket `paribelle-backups`, with lifecycle rules deleting `daily/`
   after 30 days and `weekly/` after 400. R2 › Manage API tokens › *Object Read & Write* on
   that bucket only → `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`; the S3 endpoint →
   `R2_ENDPOINT`.
3. **API token for GitHub**: My Profile › API Tokens › Create › template *Edit Cloudflare
   Workers*, this account and the `paribelle.in` zone → pom's `CLOUDFLARE_API_TOKEN`; the
   account id (Workers & Pages, right side) → `CLOUDFLARE_ACCOUNT_ID`. Run pom's *deploy*
   workflow: it creates `paribelle-edge`, puts it on `www.paribelle.in/*`, and gives it
   `api.paribelle.in`. Without its key it sends everything to Vercel and Render, so the site
   is unchanged.
4. **Fail open**, once the deploy has made the route (the setting belongs to the route):
   paribelle.in › Workers Routes › `www.paribelle.in/*` › Edit › Request limit failure mode:
   **Fail open (proceed)**. Then a day past the free allowance means Vercel serves, not an
   error page. Each deploy rewrites the route, so the workflow turns this back on after
   `wrangler deploy`; setting it by hand is only needed the first time.
5. **Go live**, once the ThinkPad is up (4): Workers & Pages › paribelle-edge › Settings ›
   Variables and Secrets › Add › type **Secret**, `EDGE_KEY`, the value from `infra/.env`.
   Within a minute pages come from the ThinkPad. Deleting the secret sends everything back to
   Vercel and Render.

### 3. Render

Environment › add `EDGE_KEY`, the same value. With it, the API limits requests per visitor
behind the Worker instead of per Cloudflare address. Leave `THROTTLE_SKIP_PRIVATE` unset there.

### 4. The ThinkPad

```sh
sudo pacman -S --needed docker docker-compose git nano
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"       # then log out and back in

# Never sleep, lid closed or not (the fallback covers it, but it shouldn't be normal).
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo mkdir -p /etc/systemd/logind.conf.d
printf '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\n' |
  sudo tee /etc/systemd/logind.conf.d/lid.conf
# (takes effect after a reboot)

git clone -b production https://github.com/anubhav-qt/pom.git ~/paribelle
cd ~/paribelle/infra
nano .env          # paste the whole settings file in, save
./first-start.sh
```

`first-start.sh` pulls the images, copies both Supabase
databases in (the `bootstrap`: it installs the sync's change log in each Supabase database,
copies it, and records where to continue from), starts everything and installs the updater.
It ends with each app's state, and `403` from `https://laptop.paribelle.in` (the gate is up
and refusing strangers). Then do 2.5.

The settings file is `.env.example` filled in; every line says where its value comes from.
Values marked *same as Render* / *same as Vercel* must be identical there, or people are
signed out, or payments fail, when a request moves between sides. Keep the file in your
password manager.

The backup key: backups are encrypted to `BACKUP_RECIPIENT` (`age1…`), and only its private
half (`age-keygen` makes the pair) can read them. Keep that in your password manager, never on
the ThinkPad.

## Day to day

```sh
cd ~/paribelle/infra
docker compose exec sync node src/main.ts status     # the sync, readiness, jobs
docker compose logs -f --tail=100 sync api web oms
./update.sh                                          # check for new images now (log: update.log)
```

Pushing deploys everything by itself: CI publishes the images and the Worker, Vercel and
Render build as before, and each repo's workflow then calls the ThinkPad's deploy hook, which
pulls this folder and the new images and restarts what changed straight away. A 5-minute
check catches anything a call missed. The stock images (Postgres, Caddy, cloudflared) aren't
updated that way; now and then: `docker compose pull db gate tunnel && docker compose up -d`.
CLIProxyAPI is pinned (see Seelie above).

### The deploy hook

CI calls `POST https://laptop.paribelle.in/_paribelle/deploy` with its key. The gate lets that
one path through without the edge key, to `hook.mjs`, which checks the key and leaves a note
in `.deploy/`; a systemd path unit (`update.sh --install`, added by itself on a ThinkPad set
up before the hook) sees the note and runs `update.sh` at once.

The key is derived from `EDGE_KEY`, so the ThinkPad needs nothing new. Once, and again after
changing `EDGE_KEY`, give it to the three repos' CI from any machine where `gh` is signed in:

```sh
infra/deploy-key.sh /path/to/infra/.env    # sets THINKPAD_DEPLOY_KEY; prints only its length
```

Without that secret CI skips the call, and updates wait for the 5-minute check as before.

### Schema changes

- **The API** (TypeORM migrations): pushing to `main` makes Render migrate Supabase as it
  deploys, and the ThinkPad migrate its own copy (`api-migrate`) before starting the new API.
- **The OMS** (drizzle SQL, `drizzle/NNNN_name.sql`): the same way. Vercel's production build
  migrates the Supabase copy before its new code goes live (`scripts/migrate.mjs`, run from
  `vercel.json`), and the ThinkPad migrates its own (`oms-migrate`) before starting the new
  OMS. Each side records what it ran in `oms_meta.migrations`, which the sync leaves alone.
  Nothing to run by hand; `oms-schema.sh` is still there for a one-off.

Keep migrations additive (new tables, new nullable or defaulted columns): for a few minutes
one side runs the new schema while the other doesn't. The sync copies the columns both sides
have and fills in the rest once both do. A migration that rewrites existing rows runs on both
sides, so each row changes twice and the sync records a conflict per row; harmless when both
give the same result: resolve them all.

### Conflicts

```sh
docker compose exec sync node src/main.ts conflicts shop     # or oms
docker compose exec sync node src/main.ts resolve shop 12,13 # or: all
```

Each shows the table, the key, which side won and the version that lost. Put anything that
matters back by hand, then resolve them.

### Backups

Every night at 03:00 the sync dumps both ThinkPad databases and encrypts them. It keeps the
last 14 in the `backups` volume and uploads each to R2 (`daily/`, and `weekly/` on Sundays).
`docker compose exec sync node src/main.ts backup` takes one now. To read one, where the
private key is:

```sh
age -d -i paribelle-backup.key paribelle-shop-2026-10-01.dump.age > shop.dump
pg_restore -l shop.dump | head      # or restore into a scratch database
```

### Space in the cloud

When a Supabase database passes `PRUNE_AT_MB` (400), the sync deletes its oldest rows by
`sync/policy.json`, from the cloud only. `docker compose exec sync node src/main.ts prune oms
--dry-run` shows what it would delete.

## When things go wrong

- **The ThinkPad is off, asleep or offline.** Vercel and Render answer within seconds (a
  visitor may wait up to 8 s the first time). A form that was open while it switched may need
  a reload: Vercel builds its own copy of each app. Once the ThinkPad is back, the sync pulls
  what the fallback wrote, and only then does the gate open again.
- **Supabase is down** while the ThinkPad is fine: the ThinkPad keeps serving and the sync
  catches the cloud up later. At boot it waits 2 minutes for the cloud, then serves anyway if
  the internet works (`degraded` in `status`).
- **Pushes to the cloud keep failing** (`pushFailingSince` in `status`; the log says *pushes to
  the cloud are failing* and what the push was sending, per table): the ThinkPad keeps serving
  but the cloud copy falls behind, so a fallback would serve old data. A table whose rows are
  too big to send within the 2-minute statement timeout (a rendered reel's video) belongs in
  `localOnly` in `sync/policy.json`.
- **The sync halts** (`status` says why; it lifts by itself once the check passes, and the
  ThinkPad catches up before serving again): usually a cloud database was replaced or reset.
  If it was, point `.env` (and Render, and Vercel) at the new one, then:
  ```sh
  docker compose stop sync
  docker compose run --rm sync node src/main.ts reseed-cloud shop   # fills an empty cloud database from the ThinkPad
  docker compose up -d sync
  ```
- **Everything goes to the fallback** and the Worker's logs say *the gate refused the edge
  key*: `EDGE_KEY` differs between `infra/.env` and the Worker.
- **The ThinkPad's disk is lost.** Put `.env` back and run `./first-start.sh`: it copies the
  cloud in again (everything recent). The history the cloud pruned is in the backups.
- **Moving to another machine.** Stop the old one first (`docker compose down`,
  `./update.sh --uninstall`): two stacks would both answer through the tunnel.

## Files

| | |
|---|---|
| `compose.yml` | the stack |
| `.env.example` | every setting; filled in, it's `.env` (never committed) |
| `first-start.sh` | the first start on a ThinkPad |
| `update.sh` | the updater: on CI's call and every 5 minutes (`--install`, `--uninstall`) |
| `hook.mjs` | the deploy hook CI calls |
| `deploy-key.sh` | gives the three repos' CI the hook's key |
| `cluster.cjs` | one process per core, for the storefront and the OMS |
| `Caddyfile` | the gate |
| `oms-schema.sh` | an OMS schema change on both sides, by hand (normally automatic) |
| `sync/` | the sync and the timed jobs (tests: `docker compose -f sync/test/compose.yml run --rm --build test`) |
| `edge/` | the Worker (tests: `npm test`) |
| `e2e/` | the whole OMS path end to end (`docker compose -f e2e/compose.yml build && (cd e2e && bash test.sh)`) |
