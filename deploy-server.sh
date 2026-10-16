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

before_sha="$(git rev-parse HEAD)"
git fetch origin "Master"
read -r ahead behind < <(git rev-list --left-right --count HEAD...origin/Master)
if [[ "$ahead" != "0" ]]; then
  echo "Refusing deploy: server has $ahead local commit(s) not on GitHub."
  exit 1
fi
git merge --ff-only "origin/Master"
after_sha="$(git rev-parse HEAD)"

# If this deploy script changed in the pulled commits, restart it from the
# freshly checked-out version so the rest of the deployment cannot continue
# with stale commands (for example an old health-check port).
if [[ "$before_sha" != "$after_sha" ]] && git diff --name-only "$before_sha" "$after_sha" -- deploy-server.sh | grep -Fxq 'deploy-server.sh'; then
  echo "deploy-server.sh was updated; restarting with the new version."
  exec bash "$0"
fi

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

healthy=0
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:7003/health >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
if [[ "$healthy" != "1" ]]; then
  echo "SKTOnline health check failed on 127.0.0.1:7003."
  pm2 logs stremio-sktonline --lines 40 --nostream || true
  exit 1
fi

echo "stremio-sktonline deployed successfully from Master."
