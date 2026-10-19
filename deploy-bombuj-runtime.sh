#!/usr/bin/env bash
# Update only an already-unified Bombuj runtime. Never use the former clone.
set -Eeuo pipefail
umask 077
ROOT=/home/ubuntu/stremio.sktonline
PROVIDER="$ROOT/providers/bombuj"
EXPECTED="$PROVIDER/preflight-front.js"
CONF="$ROOT/ecosystem.bombuj.config.cjs"
PREVIOUS="${BOMBUJ_PREVIOUS_REV:-}"
STAMP=/home/ubuntu/.stremio-bombuj-runtime-revision
STAGE_PORT=17104
STAGE_PID=""
SWITCHED=0
HEALTHY=0
STATE="$(mktemp -d /tmp/bombuj-runtime-update.XXXXXX)"

cleanup() {
  if [[ -n "$STAGE_PID" ]]; then
    kill "$STAGE_PID" 2>/dev/null || true
    wait "$STAGE_PID" 2>/dev/null || true
    STAGE_PID=""
  fi
  rm -rf "$STATE"
}
rollback() {
  local status=$?
  trap - ERR
  if [[ "$SWITCHED" == 1 && "$HEALTHY" != 1 ]]; then
    echo 'Bombuj health check failed; restoring previous provider revision.' >&2
    if [[ -s "$STATE/previous.tar" ]]; then
      tar -xf "$STATE/previous.tar" -C "$ROOT" || true
      BOMBUJ_DIRECT_VOE="$PREVIOUS_VOE" pm2 restart stremio-bombuj --update-env >/dev/null 2>&1 || true
      if curl -fsS --max-time 10 http://127.0.0.1:7004/manifest.json >/dev/null; then
        pm2 save >/dev/null 2>&1 || true
        echo 'Previous Bombuj runtime restored; rollback leaves tracked files to reconcile before another deploy.' >&2
      else
        echo 'Previous runtime health could not be confirmed; server intervention is required.' >&2
      fi
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap rollback ERR

cd "$ROOT"
[[ "$(git branch --show-current)" == Master ]] || { echo 'Bombuj update requires Master.' >&2; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo 'Tracked local changes; refusing Bombuj update.' >&2; exit 1; }
[[ -n "$PREVIOUS" ]] || { echo 'Previous revision is required for rollback.' >&2; exit 1; }
git archive "$PREVIOUS" providers/bombuj ecosystem.bombuj.config.cjs > "$STATE/previous.tar"
pm2 jlist > "$STATE/pm2.json"
node - "$STATE/pm2.json" "$EXPECTED" "$STATE/previous-voe" <<'NODE'
const fs=require('node:fs');
const apps=JSON.parse(fs.readFileSync(process.argv[2],'utf8')).filter(x=>x.name==='stremio-bombuj');
if(apps.length!==1||apps[0].pm2_env?.pm_exec_path!==process.argv[3]||apps[0].pm2_env?.status!=='online')
  throw Error('Expected exactly one online Bombuj process from the unified provider');
fs.writeFileSync(process.argv[4],String(apps[0].pm2_env.BOMBUJ_DIRECT_VOE??apps[0].pm2_env.BOMBUJ_TEST_DIRECT_VOE??'0'));
NODE
PREVIOUS_VOE="$(cat "$STATE/previous-voe")"
DESIRED_VOE="$(node -e "process.stdout.write(String(require(process.argv[1]).apps.find(x=>x.name==='stremio-bombuj').env.BOMBUJ_DIRECT_VOE??'0'))" "$CONF")"
[[ "$DESIRED_VOE" =~ ^[01]$ ]] || { echo 'Invalid VOE switch in config.' >&2; exit 1; }
REVISION="$( { git rev-parse HEAD:providers/bombuj; sha256sum "$CONF" "$ROOT/deploy-bombuj-runtime.sh"; } | sha256sum | cut -d' ' -f1 )"
if [[ "$PREVIOUS_VOE" == "$DESIRED_VOE" && -f "$STAMP" && "$(cat "$STAMP")" == "$REVISION" ]] && curl -fsS --max-time 5 http://127.0.0.1:7004/manifest.json >/dev/null; then
  echo 'Bombuj runtime revision unchanged; no restart needed.'
  exit 0
fi
curl -fsS --max-time 10 http://127.0.0.1:7004/manifest.json > "$STATE/before.json"
npm --prefix "$PROVIDER" run check
node --check "$CONF"
# Refuse occupied staging ports before starting any additional process.
node - "$STAGE_PORT" <<'NODE'
const net=require('node:net'),servers=[];
(async()=>{try{for(let p=+process.argv[2];p<+process.argv[2]+5;p++){
 const s=net.createServer();servers.push(s);
 await new Promise((ok,no)=>s.once('error',no).listen(p,'127.0.0.1',ok));
}}catch{process.exitCode=1;}finally{for(const s of servers)s.close();}})();
NODE
PORT="$STAGE_PORT" BOMBUJ_DIRECT_VOE="$DESIRED_VOE" node "$EXPECTED" > "$STATE/staging.log" 2>&1 &
STAGE_PID=$!
READY=0
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$STAGE_PORT/manifest.json" > "$STATE/staged.json" 2>/dev/null; then READY=1; break; fi
  sleep 1
done
[[ "$READY" == 1 ]] || { echo 'Bombuj isolated staging health check failed.' >&2; exit 1; }
node - "$STATE/before.json" "$STATE/staged.json" <<'NODE'
const fs=require('node:fs'),a=JSON.parse(fs.readFileSync(process.argv[2])),b=JSON.parse(fs.readFileSync(process.argv[3]));
const ids=m=>m.catalogs.map(x=>x.type+':'+x.id).sort().join('|');
if(a.id!==b.id||a.version!==b.version||ids(a)!==ids(b))throw Error('Bombuj manifest/catalog identities changed');
NODE
kill "$STAGE_PID"
wait "$STAGE_PID" 2>/dev/null || true
STAGE_PID=""
SWITCHED=1
pm2 startOrReload "$CONF" --only stremio-bombuj --update-env >/dev/null
for _ in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:7004/manifest.json > "$STATE/live.json" 2>/dev/null; then HEALTHY=1; break; fi
  sleep 1
done
[[ "$HEALTHY" == 1 ]] || false
# Keep rollback enabled until runtime path, count and VOE switch are verified.
HEALTHY=0
pm2 jlist > "$STATE/pm2.json"
node - "$STATE/pm2.json" "$EXPECTED" "$DESIRED_VOE" <<'NODE'
const fs=require('node:fs'),apps=JSON.parse(fs.readFileSync(process.argv[2])).filter(x=>x.name==='stremio-bombuj');
if(apps.length!==1||apps[0].pm2_env?.status!=='online'||apps[0].pm2_env?.pm_exec_path!==process.argv[3]||apps[0].pm2_env?.BOMBUJ_DIRECT_VOE!==process.argv[4])throw Error('Bombuj runtime/VOE switch verification failed');
NODE
pm2 save >/dev/null
printf '%s\n' "$REVISION" > "$STAMP"
HEALTHY=1
echo "Bombuj updated from unified provider; direct VOE=$DESIRED_VOE; existing port 7004 preserved."
