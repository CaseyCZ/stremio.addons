#!/usr/bin/env bash
set -euo pipefail

cd "/home/ubuntu/stremio.sktonline"

if [[ "$(git branch --show-current)" != "Master" ]]; then
  echo "Refusing deploy: expected branch Master."
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Refusing deploy: tracked local changes are present."
  git status --short
  exit 1
fi

git fetch origin "Master"
read -r ahead behind < <(git rev-list --left-right --count HEAD...origin/Master)
if [[ "$ahead" != "0" ]]; then
  echo "Refusing deploy: server has $ahead local commit(s) not on GitHub."
  exit 1
fi
git merge --ff-only "origin/Master"

npm install --omit=dev --no-audit --no-fund
npm run version:check
node --check addon.js
node --check api/cinemeta.js
node --check api/sktonline.js
node --check api/sktorrent.js

KEY_FILE="/home/ubuntu/.stremio-sktonline-config-key"
if [[ ! -s "$KEY_FILE" ]]; then
  umask 077
  openssl rand -hex 32 > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  echo "Created SKTOnline configuration encryption key."
fi

pm2 startOrReload ecosystem.config.js --only stremio-sktonline --update-env
pm2 save
curl --retry 15 --retry-delay 1 --retry-connrefused -fsS http://127.0.0.1:7002/health >/dev/null

echo "stremio-sktonline deployed successfully from Master."
