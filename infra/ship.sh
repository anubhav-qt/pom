#!/usr/bin/env bash
# Ships PariBelle to production from this machine: what GitHub's CI did, run here instead
# (as breader's infra/ship.sh does). Run it from POM's dev branch, in Git Bash on Windows:
#
#   infra/ship.sh              every step, in order
#   infra/ship.sh images hook  only the steps named (check always runs first)
#
# Steps: check, test, push, images, edge, hook, live.
#   push    POM: dev, then dev merged into production. paribelle-web and paribelle-backend: main.
#           Vercel (POM's fallback, and it migrates the cloud database) and Render (the API's
#           fallback) build those pushes themselves, as before.
#   images  the ThinkPad's images on GHCR, each built from a clean checkout of what was pushed:
#           pom, paribelle-sync and pom-render from production, paribelle-web and
#           paribelle-backend from main. One already published for that commit is skipped.
#   edge    the edge Worker (infra/edge), only when it changed or is named.
#   hook    tells the ThinkPad to update now (infra/hook.mjs); it does within 5 minutes anyway.
#   live    waits until www.paribelle.in/pom and api.paribelle.in answer with the new commits.
#
# Settings come from infra/.env.ship (copy infra/.env.ship.example).
set -euo pipefail
cd "$(dirname "$0")/.."
POM=$(pwd)

OWNER=anubhav-qt
REGISTRY=ghcr.io/$OWNER
SETTINGS=infra/.env.ship
STEPS=(check test push images edge hook live)
# paribelle.in's zone and account on Cloudflare (the edge Worker's).
ZONE_ID=c0e3f99f1ee15de925d96bad2f39d652
export CLOUDFLARE_ACCOUNT_ID=84647e95d51947e4149cbfc398afc4e1

say() {
  printf '\n== %s\n' "$*"
}

fail() {
  printf '\nship: %s\n' "$*" >&2
  exit 1
}

# The edge Worker ships when infra/edge changed since what production had, or when named.
EDGE_CHANGED=no

# Is this machine ready, and is every repo what it says it is?
step_check() {
  say "check"
  [ "$(git branch --show-current)" = dev ] || fail "ship POM from dev, not $(git branch --show-current)"
  [ -z "$(git status --porcelain)" ] || fail "POM: commit or put away your changes first"
  git fetch -q origin dev production
  git merge-base --is-ancestor origin/dev HEAD || fail "POM: origin/dev has commits you don't: pull first"
  # Production only ever holds merges of dev, so merging dev in again must give dev's own files.
  [ "$(git merge-tree --write-tree origin/production HEAD)" = "$(git rev-parse 'HEAD^{tree}')" ] ||
    fail "POM: production has changes dev doesn't: merge origin/production into dev first"
  if ! git diff --quiet origin/production HEAD -- infra/edge; then
    EDGE_CHANGED=yes
  fi

  [ -f "$SETTINGS" ] || fail "copy infra/.env.ship.example to $SETTINGS and fill it in"
  set -a
  # shellcheck source=/dev/null
  . "$SETTINGS"
  set +a
  WEB_DIR=${WEB_DIR:-../paribelle/marketplace-web}
  API_DIR=${API_DIR:-../paribelle/marketplace-backend}
  local dir
  for dir in "$WEB_DIR" "$API_DIR"; do
    [ -d "$dir/.git" ] || fail "no repository at $dir (WEB_DIR / API_DIR in $SETTINGS)"
    [ "$(git -C "$dir" branch --show-current)" = main ] || fail "$dir: ship from main"
    git -C "$dir" fetch -q origin main
    git -C "$dir" merge-base --is-ancestor origin/main HEAD || fail "$dir: origin/main has commits you don't: pull first"
    if [ -n "$(git -C "$dir" status --porcelain --untracked-files=no)" ]; then
      echo "$dir has uncommitted changes; they aren't shipped (images build from its last commit)"
    fi
  done

  docker info > /dev/null 2>&1 || fail "start Docker first"
  gh auth status > /dev/null 2>&1 || fail "sign in to GitHub: gh auth login"
  gh auth status 2>&1 | grep -q "write:packages" ||
    fail "let gh publish images: gh auth refresh -s write:packages"
  gh auth token | docker login ghcr.io -u "$OWNER" --password-stdin > /dev/null 2>&1 ||
    fail "couldn't sign Docker in to ghcr.io with gh's token"
}

# Type checks and tests: POM, the sync against its stand-ins, and the edge Worker.
step_test() {
  say "test"
  [ -d node_modules ] || npm ci
  npm run typecheck
  # The sync's tests run in Linux containers, so from an LF checkout of this commit.
  local tree ok=yes
  tree=$(mktemp -d)
  git -c core.autocrlf=false -c core.eol=lf worktree add -q --detach "$tree" HEAD
  docker compose -f "$tree/infra/sync/test/compose.yml" run --rm --build test || ok=no
  docker compose -f "$tree/infra/sync/test/compose.yml" down -v
  git worktree remove --force "$tree"
  [ "$ok" = yes ] || fail "the sync's tests failed"
  (cd infra/edge && npm ci --no-audit --no-fund && npm test && npm run typecheck)
}

step_push() {
  say "push"
  git push origin dev
  # dev merged into production without leaving dev (production's files are dev's, see check).
  local tree commit
  tree=$(git rev-parse 'HEAD^{tree}')
  if [ "$(git rev-parse 'origin/production^{tree}')" = "$tree" ]; then
    echo "production already has dev's files"
  else
    commit=$(git commit-tree "$tree" -p origin/production -p HEAD -m "Merge branch 'dev' into production")
    git push origin "$commit:refs/heads/production"
    git fetch -q origin production
  fi
  local dir
  for dir in "$WEB_DIR" "$API_DIR"; do
    git -C "$dir" push origin main
  done
}

# Builds one image from a clean checkout of a commit, unless GHCR has it already.
#   image <repo dir> <commit> <name> <context in the repo> [docker build options…]
image() {
  local dir=$1 sha=$2 name=$3 context=$4
  shift 4
  if docker buildx imagetools inspect "$REGISTRY/$name:$sha" > /dev/null 2>&1; then
    echo "$name:${sha:0:7} is published already"
    return
  fi
  local tree
  tree=$(mktemp -d)
  # LF endings whatever this machine checks out with: the files run in Linux containers.
  git -C "$dir" -c core.autocrlf=false -c core.eol=lf worktree add -q --detach "$tree" "$sha"
  echo "building $name at ${sha:0:7}"
  if ! docker buildx build --platform linux/amd64 \
    --build-arg "RELEASE=$sha" "$@" \
    -t "$REGISTRY/$name:latest" -t "$REGISTRY/$name:$sha" \
    --push "$tree/$context"; then
    git -C "$dir" worktree remove --force "$tree"
    fail "$name didn't build"
  fi
  git -C "$dir" worktree remove --force "$tree"
}

step_images() {
  say "images"
  git fetch -q origin production
  local pom web api
  pom=$(git rev-parse origin/production)
  web=$(git -C "$WEB_DIR" rev-parse HEAD)
  api=$(git -C "$API_DIR" rev-parse HEAD)
  image "$POM" "$pom" pom . --target runtime
  image "$POM" "$pom" paribelle-sync infra/sync --target runtime
  image "$POM" "$pom" pom-render infra/render
  # NEXT_PUBLIC_* are built in: production's, except that pages from the ThinkPad call
  # api.paribelle.in (the edge Worker), where Vercel's call Render directly.
  image "$WEB_DIR" "$web" paribelle-web . --target runtime \
    --build-arg NEXT_PUBLIC_API_URL=https://api.paribelle.in \
    --build-arg NEXT_PUBLIC_APP_URL=https://www.paribelle.in \
    --build-arg NEXT_PUBLIC_LOOKBOOK_ENABLED=false \
    --build-arg NEXT_PUBLIC_COD_ENABLED=true
  image "$API_DIR" "$api" paribelle-backend .
}

step_edge() {
  say "edge"
  if [ "$EDGE_CHANGED" = no ] && [[ ! " $* " =~ " edge " ]]; then
    echo "infra/edge hasn't changed"
    return
  fi
  [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || fail "CLOUDFLARE_API_TOKEN is empty in $SETTINGS (needed for the Worker)"
  export CLOUDFLARE_API_TOKEN
  (cd infra/edge && npm ci --no-audit --no-fund && npx wrangler deploy)
  # wrangler deploy rewrites the Worker's routes, which turns "fail open" back off. With it on,
  # a day past the free allowance means Vercel serves www, not an error page.
  local api="https://api.cloudflare.com/client/v4/zones/$ZONE_ID/workers/routes" id
  id=$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$api" |
    node -e 'const r=JSON.parse(require("fs").readFileSync(0)).result.find(r=>r.pattern==="www.paribelle.in/*");process.stdout.write(r?r.id:"")')
  [ -n "$id" ] || fail "no www.paribelle.in/* route"
  curl -fsS -X PUT -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$api/$id" \
    -d '{"pattern":"www.paribelle.in/*","script":"paribelle-edge","request_limit_fail_open":true}' > /dev/null
  echo "Worker deployed, fail open on"
}

# The hook's key: THINKPAD_DEPLOY_KEY, or derived from the ThinkPad's .env as hook.mjs does.
deployKey() {
  if [ -n "${THINKPAD_DEPLOY_KEY:-}" ]; then
    printf %s "$THINKPAD_DEPLOY_KEY"
    return
  fi
  [ -n "${THINKPAD_ENV:-}" ] && [ -f "$THINKPAD_ENV" ] || return 0
  local key edge
  key=$(sed -n 's/^DEPLOY_KEY=//p' "$THINKPAD_ENV" | tail -n 1 | tr -d "\r\"'")
  if [ -z "$key" ]; then
    edge=$(sed -n 's/^EDGE_KEY=//p' "$THINKPAD_ENV" | tail -n 1 | tr -d "\r\"'")
    [ -n "$edge" ] || return 0
    key=$(printf %s paribelle-deploy | openssl dgst -sha256 -hmac "$edge" | sed 's/^.*= //')
  fi
  printf %s "$key"
}

step_hook() {
  say "hook"
  local key
  key=$(deployKey)
  if [ -z "$key" ]; then
    echo "no deploy key (THINKPAD_ENV or THINKPAD_DEPLOY_KEY in $SETTINGS): the ThinkPad updates at its next 5-minute check"
    return
  fi
  curl -fsS --max-time 20 --retry 3 --retry-all-errors -X POST \
    -H "Authorization: Bearer $key" -H "X-Paribelle-Repo: ship.sh" \
    https://laptop.paribelle.in/_paribelle/deploy ||
    echo "the ThinkPad didn't answer; it updates at its next 5-minute check"
}

# Waits until the ThinkPad's OMS and API report the commits just shipped.
step_live() {
  say "live"
  local pom api
  pom=$(git rev-parse origin/production)
  api=$(git -C "$API_DIR" rev-parse HEAD)
  waitFor "www.paribelle.in/pom" "curl -fsS https://www.paribelle.in/pom/api/health | grep -q $pom" "$pom"
  waitFor "api.paribelle.in" "curl -fsS https://api.paribelle.in/api/v1/health | grep -q $api" "$api"
  echo "all live: POM ${pom:0:7}, API ${api:0:7}"
}

# Tries `$2` every 10 seconds for up to 15 minutes.
waitFor() {
  local tries=0
  until eval "$2" > /dev/null 2>&1; do
    tries=$((tries + 1))
    [ "$tries" -lt 90 ] || fail "$1 isn't on ${3:0:7} after 15 minutes (infra/update.log on the ThinkPad says why)"
    sleep 10
  done
  echo "$1 is on ${3:0:7}"
}

main() {
  local wanted=("$@")
  if [ ${#wanted[@]} -eq 0 ]; then
    wanted=("${STEPS[@]}")
  fi
  local step
  for step in "${wanted[@]}"; do
    [[ " ${STEPS[*]} " =~ " $step " ]] || fail "no step called $step (steps: ${STEPS[*]})"
  done
  step_check
  for step in "${wanted[@]}"; do
    if [ "$step" = edge ]; then
      step_edge "$@"
    elif [ "$step" != check ]; then
      "step_$step"
    fi
  done
}

main "$@"
