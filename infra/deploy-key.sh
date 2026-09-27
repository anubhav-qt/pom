#!/bin/sh
# Gives each repo's CI the key to the ThinkPad's deploy hook (hook.mjs): the GitHub secret
# THINKPAD_DEPLOY_KEY on pom, paribelle-web and paribelle-backend. The key is DEPLOY_KEY
# from the .env if it has one, or else derived from its EDGE_KEY, which is what the hook
# does too, so the ThinkPad needs nothing new. Run it wherever gh is signed in and a copy
# of infra/.env is; again after changing EDGE_KEY or DEPLOY_KEY.
#   infra/deploy-key.sh [path/to/.env]
# It prints only the key's length.
set -eu
env_file=${1:-"$(dirname "$0")/.env"}
setting() { sed -n "s/^$1=//p" "$env_file" | tail -n 1 | tr -d "\r\"'"; }

key=$(setting DEPLOY_KEY)
if [ -z "$key" ]; then
  edge=$(setting EDGE_KEY)
  [ -n "$edge" ] || { echo "no EDGE_KEY or DEPLOY_KEY in $env_file" >&2; exit 1; }
  key=$(printf %s paribelle-deploy | openssl dgst -sha256 -hmac "$edge" | sed 's/^.*= //')
  [ ${#key} -eq 64 ] || { echo "could not derive the key (is openssl installed?)" >&2; exit 1; }
fi

for repo in pom paribelle-web paribelle-backend; do
  printf %s "$key" | gh secret set THINKPAD_DEPLOY_KEY --repo "anubhav-qt/$repo"
done
echo "THINKPAD_DEPLOY_KEY set (${#key} characters) on pom, paribelle-web and paribelle-backend."
