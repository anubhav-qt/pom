#!/bin/sh
# Keeps the ThinkPad on the latest images and settings. It runs as soon as CI says a new
# image is up (each repo's workflow calls the deploy hook, hook.mjs, whose note a systemd
# path unit watches), and every 5 minutes anyway (a systemd timer), in case a call was missed.
#   infra/update.sh --install     start updating (both; re-running it is harmless)
#   infra/update.sh --uninstall   stop
#   infra/update.sh               check once now
# It pulls this checkout (compose.yml, the Caddyfile, …) and the images, and restarts only
# what changed, and only while the stack is running, so a stack you stopped yourself stays
# stopped. The API's and the OMS's migrations run first (api-migrate, oms-migrate); if one
# fails, the old app keeps running and the next check tries again.
set -eu
cd "$(dirname "$0")"
DIR=$(pwd)
UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT=paribelle-update
APPS="api web oms sync"

# The note the deploy hook leaves (./.deploy is mounted into it), as it was when this run
# began: a new one arriving mid-run means another pass at the end.
NOTE="$DIR/.deploy/requested"
SEEN=${SEEN-$(cat "$NOTE" 2>/dev/null || true)}
export SEEN

install_units() {
    mkdir -p "$UNITS" "$DIR/.deploy"
    cat > "$UNITS/$UNIT.service" <<EOF
[Unit]
Description=Update the Paribelle stack to the latest images

[Service]
Type=oneshot
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/sh "$DIR/update.sh"
StandardOutput=append:$DIR/update.log
StandardError=append:$DIR/update.log
EOF
    cat > "$UNITS/$UNIT.timer" <<EOF
[Unit]
Description=Check for new Paribelle images every 5 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
    cat > "$UNITS/$UNIT.path" <<EOF
[Unit]
Description=Update the Paribelle stack as soon as CI publishes a new image

[Path]
PathChanged=$NOTE
Unit=$UNIT.service

[Install]
WantedBy=paths.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now "$UNIT.timer" "$UNIT.path"
    # Without lingering, a user's timers only run while they're logged in.
    loginctl enable-linger "$(id -un)" 2>/dev/null ||
      echo "Also run: sudo loginctl enable-linger $(id -un)   (so checks run before you log in)"
    echo "Updating when CI publishes, and checking every 5 minutes. Log: $DIR/update.log"
}

case "${1:-}" in
  --install)
    install_units
    exit 0 ;;
  --uninstall)
    systemctl --user disable --now "$UNIT.timer" "$UNIT.path" 2>/dev/null || true
    rm -f "${UNITS:?}/${UNIT:?}.service" "${UNITS:?}/${UNIT:?}.timer" "${UNITS:?}/${UNIT:?}.path"
    systemctl --user daemon-reload
    echo "Stopped checking for new images."
    exit 0 ;;
esac

# A ThinkPad set up before the deploy hook has only the timer: add the path unit once.
[ -f "$UNITS/$UNIT.path" ] || ! command -v systemctl >/dev/null 2>&1 || install_units >/dev/null 2>&1 ||
  echo "$(date '+%F %T') could not add the path unit; run infra/update.sh --install"

compose() { docker compose -f compose.yml "$@"; }
docker info >/dev/null 2>&1 || exit 0 # Docker isn't running yet
[ -n "$(compose ps --quiet gate)" ] || exit 0 # the stack is stopped

# The settings first. The pull may rewrite this very script, and sh reads a script as it
# goes, so after a change it starts over from the new copy (one compound command, read
# whole before it runs).
if [ "${1:-}" != --pulled ] && git rev-parse --git-dir >/dev/null 2>&1; then
  before=$(git rev-parse HEAD)
  git pull --ff-only --quiet || echo "$(date '+%F %T') git pull failed; using the checkout as it is"
  [ "$(git rev-parse HEAD)" = "$before" ] || exec /bin/sh "$DIR/update.sh" --pulled
fi

# Private images (not the default): log in with GHCR_TOKEN from .env, if it's there.
setting() { sed -n "s/^$1=//p" .env | tail -n 1 | tr -d "\r\"'"; }
token=$(setting GHCR_TOKEN)
[ -z "$token" ] || printf '%s' "$token" |
  docker login ghcr.io -u "$(setting GHCR_USER)" --password-stdin >/dev/null 2>&1 ||
  echo "$(date '+%F %T') ghcr.io refused GHCR_TOKEN: is it expired?"

compose pull --quiet $APPS api-migrate oms-migrate
stale=""
replaced=""
[ "${1:-}" = --pulled ] && stale=" settings"
for app in $APPS; do
  running=$(compose ps --quiet "$app")
  [ -n "$running" ] || continue
  image=$(docker inspect --format '{{.Config.Image}}' "$running")
  want=$(docker image inspect --format '{{.Id}}' "$image")
  have=$(docker inspect --format '{{.Image}}' "$running")
  [ "$want" = "$have" ] || { stale="$stale $app"; replaced="$replaced $have"; }
done

if [ -n "$stale" ]; then
  echo "$(date '+%F %T') updating:$stale"
  compose up -d --remove-orphans
  # Only the images this update replaced: other projects on this machine (breader) keep theirs.
  [ -z "$replaced" ] || docker image rm $replaced >/dev/null 2>&1 || true
fi

# Files a container reads once, at start (bind mounts): compose doesn't restart it when one
# changes, and the gate has no admin API to reload through. Restart it when its file differs
# from the one it last started with (.mounted; on the first run here, restart once).
restart=""
for entry in Caddyfile:gate hook.mjs:hook; do
  file=${entry%%:*}
  sum="$file $(sha256sum "$file" | cut -c1-64)"
  grep -qxF "$sum" .mounted 2>/dev/null || restart="$restart ${entry#*:}"
done
if [ -n "$restart" ]; then
  echo "$(date '+%F %T') restarting for new settings:$restart"
  compose up -d --no-recreate $restart >/dev/null 2>&1 || true
  compose restart $restart
  for file in Caddyfile hook.mjs; do echo "$file $(sha256sum "$file" | cut -c1-64)"; done > .mounted
fi

# CI called again while this ran (another repo's image, say): go round once more.
if [ "$(cat "$NOTE" 2>/dev/null || true)" != "$SEEN" ]; then
  SEEN=$(cat "$NOTE" 2>/dev/null || true) exec /bin/sh "$DIR/update.sh"
fi
