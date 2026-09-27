#!/bin/sh
# The first start on a ThinkPad, after infra/.env is in place:
#   infra/first-start.sh
# Pulls the images (logging in first if .env has a GHCR_TOKEN), copies both Supabase databases in (once),
# starts everything and installs the 5-minute updater. Safe to run again: what's done is skipped.
set -eu
cd "$(dirname "$0")"
compose() { docker compose -f compose.yml "$@"; }
setting() { sed -n "s/^$1=//p" .env | tail -n 1 | tr -d "\r\"'"; }

[ -f .env ] || { echo "infra/.env is missing: put the filled-in file there first (README.md)." >&2; exit 1; }
chmod 600 .env
docker info >/dev/null 2>&1 || { echo "Docker isn't running: sudo systemctl enable --now docker" >&2; exit 1; }

token=$(setting GHCR_TOKEN)
if [ -n "$token" ]; then
  printf '%s' "$token" | docker login ghcr.io -u "$(setting GHCR_USER)" --password-stdin >/dev/null
  echo "Logged in to ghcr.io."
fi

echo "Pulling images…"
compose pull --quiet
compose up -d --wait db

# A database is bootstrapped once the sync has recorded where to continue from.
bootstrapped() {
  n=$(compose exec -T db psql -U paribelle -d "$1" -tAc \
    "select count(*) from paribelle_sync.state where key in ('pull', 'push', 'cloud_instance')" 2>/dev/null || echo 0)
  [ "$n" = 3 ]
}
for pair in shop oms; do
  if bootstrapped "$pair"; then
    echo "$pair: already copied from the cloud."
  else
    echo "$pair: copying the cloud database to the ThinkPad…"
    compose run --rm --no-deps sync node src/main.ts bootstrap "$pair"
  fi
done

echo "Starting everything (a couple of minutes)…"
compose up -d
i=0
until [ "$(compose ps --format '{{.Health}}' api web oms | grep -c '^healthy')" = 3 ] || [ $i -ge 60 ]; do
  sleep 5
  i=$((i + 1))
done
./update.sh --install

echo
compose ps --format 'table {{.Service}}\t{{.Status}}'
echo
compose exec -T sync node src/main.ts status | grep -E '"(name|ready)"' || true
echo
printf 'The gate from outside (expect 403): '
curl -s -o /dev/null -w '%{http_code}\n' https://laptop.paribelle.in/ || echo "no answer yet (is the tunnel's public hostname set?)"
