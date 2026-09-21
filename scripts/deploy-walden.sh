#!/usr/bin/env bash
# Sync the working tree to walden and (re)start the stack behind the Cloudflare Tunnel.
#   scripts/deploy-walden.sh            # deploy
#   HOST=other-box scripts/deploy-walden.sh
set -euo pipefail
HOST=${HOST:-walden}
DEST=${DEST:-src/yield-analytics-demo}
cd "$(dirname "$0")/.."
rsync -az --delete --exclude .git --exclude .env --exclude exports/ --exclude web/node_modules --exclude web/dist \
  --exclude __pycache__ ./ "$HOST:$DEST/"
ssh "$HOST" "cd $DEST && test -f .env || { echo 'missing $DEST/.env on $HOST (copy .env.example)'; exit 1; }
  docker compose --profile tunnel up -d --build --remove-orphans && docker compose ps --format '{{.Service}}\t{{.Status}}'"
