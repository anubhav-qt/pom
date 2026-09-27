#!/bin/sh
# Applies one drizzle SQL file to the OMS database on both sides, in one transaction each:
# the ThinkPad's first (the source of truth), then the cloud's (what the fallback uses).
#   infra/oms-schema.sh drizzle/0006_something.sql
#   infra/oms-schema.sh drizzle/0006_something.sql --cloud-only   (the ThinkPad already has it)
#   infra/oms-schema.sh drizzle/0006_something.sql --local-only
# The sync notices the new columns or tables within a minute and reconciles them.
# Additive changes only (new tables, nullable columns) while the fallback may run the old code.
set -eu
[ $# -ge 1 ] || { echo "usage: infra/oms-schema.sh <file.sql> [--local-only|--cloud-only]" >&2; exit 2; }
file=$(realpath "$1")
mode=${2:-both}
cd "$(dirname "$0")"
compose() { docker compose -f compose.yml "$@"; }

if [ "$mode" != --cloud-only ]; then
  echo "ThinkPad (oms):"
  compose exec -T db psql -U paribelle -d oms -v ON_ERROR_STOP=1 --single-transaction < "$file"
fi
if [ "$mode" != --local-only ]; then
  echo "Cloud (OMS_CLOUD_URL):"
  cloud=$(sed -n 's/^OMS_CLOUD_URL=//p' .env | tail -n 1 | tr -d "\r\"'")
  [ -n "$cloud" ] || { echo "OMS_CLOUD_URL is not set in infra/.env" >&2; exit 1; }
  compose exec -T -e PGURL="$cloud" db sh -c 'psql "$PGURL" -v ON_ERROR_STOP=1 --single-transaction' < "$file" || {
    echo "The ThinkPad has the change but the cloud doesn't. Fix the cause, then:" >&2
    echo "  infra/oms-schema.sh $1 --cloud-only" >&2
    exit 1
  }
fi
echo "Done."
