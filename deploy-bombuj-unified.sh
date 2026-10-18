#!/usr/bin/env bash
# Bombuj cutover from CaseyCZ/stremio.bombuj to the unified repository.
# Safe to run repeatedly. Never edits Sosac or Nginx, and keeps the old clone.
set -Eeuo pipefail
umask 077

ROOT="/home/ubuntu/stremio.sktonline"
PROVIDER="$ROOT/providers/bombuj"
CONF="$ROOT/ecosystem.bombuj.config.cjs"
OLD_CONF="/home/ubuntu/stremio.bombuj/ecosystem.config.cjs"
STAMP="/home/ubuntu/.stremio-bombuj-unified-revision"
EXPECTED="$PROVIDER/preflight-front.js"
STAGING_PORT=17104
STAGING_PID=""
SWITCHED=0
DEPLOY_OK=0

if [[ "$(git -C "$ROOT" branch --show-current)" != "Master" ]]; then
  echo "Refusing Bombuj migration: unified checkout must be on Master." >&2
  exit 1
fi
if ! git -C "$ROOT" diff --quiet || ! git -C "$ROOT" diff --cached --quiet; then
  echo "Refusing Bombuj migration: tracked local modifications found." >&2
  exit 1
fi
for file in "$EXPECTED" "$CONF" "$PROVIDER/package.json"; do
  test -f "$file" || { echo "Required file absent: $file" >&2; exit 1; }
done
if ! command -v pm2 >/dev/null 2>&1; then
  echo "PM2 is unavailable." >&2
  exit 1
fi

# The provider subtree is content-addressed, so ordinary SKTOnline web changes
# do not cause needless Bombuj restarts. Include PM2/deploy configuration.
REVISION="$(
  { git -C "$ROOT" rev-parse HEAD:providers/bombuj
    sha256sum "$CONF" "$ROOT/deploy-bombuj-unified.sh"; } | sha256sum | cut -d' ' -f1
)"

# PM2's executable path is the actual runtime source of truth, not manifest version.
CURRENT_EXEC="$(pm2 jlist | node -e '
  let body=""; process.stdin.on("data", d=>body+=d).on("end",()=>{
    const list=JSON.parse(body);
    const app=list.find(x=>x.name==="stremio-bombuj");
    console.log(app?.pm2_env?.pm_exec_path || "");
  });
')"
if [[ "$CURRENT_EXEC" == "$EXPECTED" && -f "$STAMP" &&
      "$(cat "$STAMP")" == "$REVISION" ]] &&
   curl -fsS --max-time 10 http://127.0.0.1:7004/manifest.json >/dev/null; then
  echo "Bombuj already running from unified repo; provider revision unchanged."
  exit 0
fi

cleanup_stage() {
  if [[ -n "$STAGING_PID" ]]; then
    kill "$STAGING_PID" 2>/dev/null || true
    wait "$STAGING_PID" 2>/dev/null || true
    STAGING_PID=""
  fi
}
rollback() {
  status="$?"
  trap - ERR
  cleanup_stage
  if [[ "$SWITCHED" == "1" && "$DEPLOY_OK" != "1" ]]; then
    echo "Bombuj migration failed; restoring previous standalone runtime." >&2
    pm2 delete stremio-bombuj >/dev/null 2>&1 || true
    if [[ -f "$OLD_CONF" ]]; then
      pm2 start "$OLD_CONF" --only stremio-bombuj --update-env || true
      pm2 save || true
      curl -fsS --max-time 20 http://127.0.0.1:7004/manifest.json >/dev/null || true
    else
      echo "WARNING: original PM2 config missing at $OLD_CONF; manual recovery needed." >&2
    fi
  fi
  exit "$status"
}
trap cleanup_stage EXIT
trap rollback ERR

# Prepare dependency tree without affecting the live PM2 service.
npm install --prefix "$PROVIDER" --omit=dev --ignore-scripts --no-audit --no-fund
npm --prefix "$PROVIDER" run check
node --check "$CONF"
bash -n "$ROOT/deploy-bombuj-unified.sh"

# Start new Bombuj side-by-side on isolated staging ports (17104+).
PORT="$STAGING_PORT" node "$EXPECTED" >/tmp/caseycz-bombuj-unified-staging.log 2>&1 &
STAGING_PID="$!"
STAGING_READY=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$STAGING_PORT/manifest.json" > /tmp/caseycz-bombuj-unified-staging.json 2>/dev/null; then
    STAGING_READY=1
    break
  fi
  sleep 1
done
if [[ "$STAGING_READY" != "1" ]]; then
  echo "New Bombuj failed staging health check" >&2
  tail -n 35 /tmp/caseycz-bombuj-unified-staging.log || true
  false
fi
node - <<'NODE'
const m=require('/tmp/caseycz-bombuj-unified-staging.json');
const expected=require('/home/ubuntu/stremio.sktonline/providers/bombuj/package.json').version;
if(m.version!==expected)throw Error('staging Bombuj version mismatch');
for(const [type,id] of [['movie','bombuj-movies-search'],['series','bombuj-series-search']]) {
  const c=m.catalogs.find(x=>x.type===type&&x.id===id);
  if(!c||(c.extra||[]).filter(x=>x.name==='search'&&x.isRequired).length!==1)
    throw Error('Missing searchable '+type+' catalog in staging');
}
console.log('Staged Bombuj '+m.version+' verified on port 17104');
NODE

# Preserve continuity: require the new instance to expose the same Stremio
# catalog identities that current installs use, before changing port 7004.
if curl -fsS --max-time 10 http://127.0.0.1:7004/manifest.json >/tmp/caseycz-bombuj-before-cutover.json; then
  node - <<'NODE'
const fs=require('fs');
const a=JSON.parse(fs.readFileSync('/tmp/caseycz-bombuj-before-cutover.json','utf8'));
const b=JSON.parse(fs.readFileSync('/tmp/caseycz-bombuj-unified-staging.json','utf8'));
for(const field of ['id','version'])if(a[field]!==b[field])
  throw Error('Unsafe Bombuj manifest drift at '+field);
const ids=x=>x.catalogs.map(c=>c.type+':'+c.id).sort().join('|');
if(ids(a)!==ids(b))throw Error('Bombuj catalog identities changed');
console.log('Manifest identities and catalog list match live Bombuj');
NODE
fi
cleanup_stage

# The old clone, backup branches, nginx location and URLs remain intact.
SWITCHED=1
pm2 delete stremio-bombuj >/dev/null 2>&1 || true
pm2 start "$CONF" --only stremio-bombuj --update-env

HEALTHY=0
for _ in $(seq 1 40); do
  if curl -fsS --max-time 4 http://127.0.0.1:7004/manifest.json >/tmp/caseycz-bombuj-unified-live.json 2>/dev/null; then
    HEALTHY=1
    break
  fi
  sleep 1
done
if [[ "$HEALTHY" != "1" ]]; then
  echo "Migrated Bombuj failed port 7004 health check" >&2
  pm2 logs stremio-bombuj --lines 40 --nostream || true
  false
fi
pm2 jlist > /tmp/caseycz-bombuj-unified-pm2.json
node - "$EXPECTED" <<'NODE'
const fs=require('node:fs');
const expected=process.argv[2];
const list=JSON.parse(fs.readFileSync('/tmp/caseycz-bombuj-unified-pm2.json','utf8'));
const app=list.find(x=>x.name==='stremio-bombuj');
if(!app||app.pm2_env?.status!=='online'||app.pm2_env.pm_exec_path!==expected)
  throw Error('Bombuj PM2 executable is not the unified provider: '+app?.pm2_env?.pm_exec_path);
const manifest=JSON.parse(fs.readFileSync('/tmp/caseycz-bombuj-unified-live.json','utf8'));
if(manifest.version!=='0.8.1'||!Array.isArray(manifest.catalogs)||manifest.catalogs.length<5)
  throw Error('Migrated manifest response invalid');
console.log('Bombuj PM2 online from '+app.pm2_env.pm_exec_path);
NODE
curl -kfsS --max-time 20 https://130.61.49.108/stremio-bombuj/manifest.json >/dev/null
# Check the connected SKTOnline instance still serves its own manifest.
curl -fsS --max-time 15 http://127.0.0.1:7003/health >/dev/null

printf '%s\n' "$REVISION" > "$STAMP"
chmod 600 "$STAMP"
pm2 save
DEPLOY_OK=1
echo "BOMBUJ_UNIFIED_MIGRATION_SUCCESS: PM2 port 7004 now uses $EXPECTED"
