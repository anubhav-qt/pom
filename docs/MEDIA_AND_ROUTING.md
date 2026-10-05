# Media on R2, and requests straight to the ThinkPad

Status on 2026-10-05: the Cloudflare side of R2 is done and tested. No code is written
yet. The Render settings wait for a Render login.

## Why

- **The Worker cap.** Every page, file and API call on www and api goes through the
  `paribelle-edge` Worker, and the free plan allows 100,000 Worker requests a day. That is
  about 1,200 to 1,500 shoppers a day. Past it, www falls back to Vercel (its route fails
  open), api.paribelle.in returns errors (a custom domain can't fail open), and Seelie is
  offline until 05:30 IST, when the count resets.
- **Cloudinary.** Product photos are served as unresized originals, 80 to 447 KB each. If
  the account is on the free plan, its monthly credits run out at roughly 200 new shoppers
  a day.
- **The fix.** Photos and videos come from R2 (no egress fees, cached by Cloudflare, and
  video is allowed there). www and api point straight at the tunnel, so no Worker runs per
  request. A small scheduled Worker checks the ThinkPad every 5 seconds and moves DNS to
  Vercel and Render when it fails.

## Part 1: media on R2

### Done (2026-10-05, Magicalfizz Cloudflare account)

- **Bucket** `paribelle-media`: Asia-Pacific, Standard storage.
- **Public address** `https://media.paribelle.in`: an R2 custom domain, Active. Cloudflare
  added the `media` CNAME by itself. The r2.dev address stays off.
- **CORS**: GET and HEAD from `https://www.paribelle.in`, `https://paribelle.in` and
  `http://localhost:3000`, any header, cached for a day.
- **Keys**
  - `paribelle-thinkpad` is the key the sync already uses for backups. It now covers both
    `paribelle-backups` and `paribelle-media`. Editing a key keeps its value, so the
    `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` already in the ThinkPad's `infra/.env`
    work for media too. Nothing new has to reach the ThinkPad.
  - `paribelle-render` is new: Object Read & Write on `paribelle-media` only, for
    paribelle-backend on Render. Its values sit in `~/anubhav/.paribelle-render-r2.env`
    on the Mac (chmod 600, in no repo), together with `R2_ENDPOINT`, `R2_MEDIA_BUCKET`
    and `MEDIA_URL`.
- **Tested** with a small text file: the upload through the S3 API returned 200;
  `media.paribelle.in` served it with `access-control-allow-origin` for www; the same key
  got 403 on `paribelle-backups`; the delete returned 204, so the bucket is empty again.

### Settings the code will read

```
R2_ENDPOINT=https://84647e95d51947e4149cbfc398afc4e1.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=...        (ThinkPad: already in infra/.env; Render: paribelle-render)
R2_SECRET_ACCESS_KEY=...
R2_MEDIA_BUCKET=paribelle-media
MEDIA_URL=https://media.paribelle.in
```

### Still to do

1. **Render** (needs a Render login): paribelle-backend, then Environment, then Import
   from .env, and paste the file above. Use "Save only" until the code that reads these
   is deployed.
2. **paribelle-backend**: `CloudinaryService` becomes an R2 uploader.
   - Resize with sharp at upload time to a few WebP widths (for example 320, 640, 1080
     and 1600). Nobody resizes on request after that.
   - Name each file by its content hash, and upload with
     `Cache-Control: public, max-age=31536000, immutable`.
   - Upload videos as they are, with the same cache header.
   - Files: `src/common/services/cloudinary.service.ts`, `src/common/common.module.ts`,
     `rehost-amazon-images.js`, `fix-broken-images.js`, `import-catalogue.js`,
     `build-amazon-import.js`, `CLOUDINARY_INTEGRATION.md`, `.env.example`, `Dockerfile`.
   - In `infra/compose.yml`, pass the `R2_*` settings and `MEDIA_URL` to the `api`
     service too.
3. **paribelle-web**: `next.config.js` and `src/lib/heroSectionImages.ts`. Pick the
   width per screen with `srcset`.
4. **pom**: `src/app/api/photos/route.ts` (its `CLOUDINARY_URL` check),
   `src/lib/photo-src.ts`, `src/lib/seelie/media/catalogue.ts`,
   `src/lib/seelie/media/library.ts`, `src/lib/seelie/tools/store.ts`,
   `infra/compose.yml`, `infra/.env.example`, `infra/README.md`.
5. **Moving what exists.** A script finds every Cloudinary address in both databases
   (shop and OMS), downloads each file, makes the sizes, uploads them to R2 and rewrites
   the addresses. It runs on the ThinkPad, and the sync carries the change to Supabase.
   Cloudinary stays as it is until everything is checked; then cancel it.
6. **Check caching.** The text test file came back `cf-cache-status: DYNAMIC`, because
   Cloudflare doesn't cache `.txt` by default. Check that a real `.webp` and `.mp4` show
   `HIT` on the second request. If they don't, add a Cache Rule for media.paribelle.in.

**Space.** On 2026-10-05 the account's R2 held 3 GB in all (`paribelle-backups` 2.48 GB,
`breader-files` 0.53 GB). The first 10 GB are free, then $0.015 per GB a month. Backups
keep 30 dailies and 400 days of weeklies, so they will keep growing. Check Cloudinary's
total size before moving.

## Part 2: requests straight to the ThinkPad

Nothing is done yet. The plan:

1. **DNS.** Point `www` and `api` at the tunnel, the way `laptop.paribelle.in` is today.
   `api.paribelle.in` is a Worker custom domain now, not a DNS record, so it has to be
   removed from the Worker before the CNAME can be added.
2. **Cache rule** for `/_next/static/*` on www, so Cloudflare serves the site's files
   itself.
3. **Gate** (`infra/Caddyfile`).
   - Stop requiring `X-Paribelle-Edge-Key`.
   - Take the visitor's IP from `Cf-Connecting-IP`, which the API's rate limits use too.
   - Take the site from `Host` instead of `X-Paribelle-Host`.
   - Keep sending `/.well-known/acme-challenge/*` to Vercel (the edge Worker does this
     today in `edge.ts`), or Vercel can't renew its certificate for www.
4. **Failover Worker** `paribelle-failover`.
   - A cron runs once a minute, and each run makes 12 checks, 5 seconds apart.
   - It checks `laptop.paribelle.in` directly (not www, which may already point at
     Vercel): `/pom/api/health` and `/api/v1/health`. A 5xx, a timeout, or an
     `x-paribelle-standby` or `x-paribelle-gate` header counts as down.
   - After two misses in a row, it points `www` at Vercel and `api` at Render through
     the Cloudflare API. That needs a token with DNS edit on the zone, kept as a Worker
     secret.
   - It moves back only after several good checks in a row, with the sync caught up.
   - The cost: 1,440 runs a day, which is 1.4% of the 100,000 cap. The checks are
     subrequests (12 of the 50 allowed per run) and don't count toward it. CPU stays far
     under 10 ms.
5. **Render custom domain.** Add `api.paribelle.in` to paribelle-backend on Render, so
   the flip to Render serves the right certificate. Check the workspace's custom domain
   limit first.
6. **What it costs in failover speed.** A sudden ThinkPad death means about 10 to 30
   seconds of errors (two missed checks, then Cloudflare applying the DNS change), where
   the Worker today switches per request, instantly. Seelie is offline on the fallback,
   the same as now.
7. **Deploys.** Change `.github/workflows/deploy.yml`: it deploys `paribelle-edge` and
   re-sets the www route's fail-open today. It should deploy `paribelle-failover`
   instead. Update `infra/README.md`.
8. **Remove `paribelle-edge` last.** Until then, turning its route back on is the
   rollback.

Order: Part 1 first, since visitors see no change; then Part 2.
