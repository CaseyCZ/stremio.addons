#!/usr/bin/env bash
# One-time PM2 rename without changing code, ports or encryption.
# Old names: stremio-sktonline, stremio-bombuj
# New names: stremio-addons, stremio-addons-bombuj
set -Eeuo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
cd "$ROOT"
MAIN_CONF="$ROOT/ecosystem.config.js"
BOMBUJ_CONF="$ROOT/ecosystem.bombuj.config.cjs"
LOCK=/tmp/stremio-addons-pm2-migration.lock
exec 9>"$LOCK"
flock -w 90 9

STATE="$(mktemp -d /tmp/stremio-addons-pm2-rename.XXXXXXXX)"
CHANGED=0
FINISHED=0

cleanup() { rm -rf -- "$STATE"; }

wait_for_url() {
  local url="$1"
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "No healthy response from $url" >&2
  return 1
}

rollback() {
  local status="$1"
  trap - ERR INT TERM
  if [[ "$CHANGED" == 1 && "$FINISHED" != 1 ]]; then
    echo 'PM2 migration failed; restoring original process names.' >&2
    pm2 delete stremio-addons >/dev/null 2>&1 || true
    pm2 delete stremio-addons-bombuj >/dev/null 2>&1 || true
    # Temporary ecosystem files preserve the existing application cwd,
    # ports and credentials-key reference; no secrets are printed.
    pm2 startOrReload "$STATE/old-main.config.cjs" --only stremio-sktonline --update-env >/dev/null 2>&1 || true
    pm2 startOrReload "$STATE/old-bombuj.config.cjs" --only stremio-bombuj --update-env >/dev/null 2>&1 || true
    if wait_for_url http://127.0.0.1:7003/health &&
       wait_for_url http://127.0.0.1:7004/manifest.json; then
      pm2 save >/dev/null 2>&1 || true
      echo 'Original PM2 names restored; both providers are reachable.' >&2
    else
      echo 'WARNING: rollback requires manual attention; inspect pm2 ls and ports 7003/7004.' >&2
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'rollback $?' ERR
trap 'rollback 130' INT
trap 'rollback 143' TERM

# Required environment and strict ecosystem names.
node - "$MAIN_CONF" "$BOMBUJ_CONF" <<'NODE'
const assert=require('node:assert/strict');
const [mainFile,bombujFile]=process.argv.slice(2);
const main=require(mainFile).apps[0],bombuj=require(bombujFile).apps[0];
assert.equal(main.name,'stremio-addons');
assert.equal(bombuj.name,'stremio-addons-bombuj');
assert.equal(Number(main.env.PORT),7003);
assert.equal(Number(bombuj.env.PORT),7004);
assert.equal(main.env.CONFIG_ENCRYPTION_KEY_FILE,'/home/ubuntu/.stremio-sktonline-config-key');
assert.equal(main.script,'./addon.js');
assert.equal(bombuj.script,'preflight-front.js');
NODE

pm2 jlist > "$STATE/before.json"
MODE="$(node - "$STATE/before.json" "$ROOT" <<'NODE'
const fs=require('node:fs');
const apps=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const root=process.argv[3];
const old=['stremio-sktonline','stremio-bombuj'];
const fresh=['stremio-addons','stremio-addons-bombuj'];
function valid(names) {
  const a=apps.filter(x=>x.name===names[0]);
  const b=apps.filter(x=>x.name===names[1]);
  return a.length===1&&b.length===1&&
    a[0].pm2_env.status==='online'&&b[0].pm2_env.status==='online'&&
    a[0].pm2_env.pm_exec_path===root+'/addon.js'&&
    b[0].pm2_env.pm_exec_path===root+'/providers/bombuj/preflight-front.js'&&
    a[0].pm2_env.pm_cwd===root&&
    b[0].pm2_env.pm_cwd===root+'/providers/bombuj';
}
if(valid(fresh)&&old.every(n=>!apps.some(a=>a.name===n))) process.stdout.write('new');
else if(valid(old)&&fresh.every(n=>!apps.some(a=>a.name===n))) process.stdout.write('old');
else {console.error('Unexpected PM2 names or executable locations; refusing rename.');process.exit(1)}
NODE
)"
if [[ "$MODE" == new ]]; then
  wait_for_url http://127.0.0.1:7003/health
  wait_for_url http://127.0.0.1:7004/manifest.json
  echo 'PM2 already uses stremio-addons and stremio-addons-bombuj.'
  exit 0
fi

test -s /home/ubuntu/.stremio-sktonline-config-key
curl -fsS --max-time 10 http://127.0.0.1:7003/health > "$STATE/before-health.json"
curl -fsS --max-time 15 http://127.0.0.1:7004/manifest.json > "$STATE/before-bombuj.json"
# Preflight syntax and ecosystem settings BEFORE stopping either provider.
node --check "$ROOT/addon.js"
node --check "$ROOT/providers/bombuj/preflight-front.js"
node --check "$MAIN_CONF"
node --check "$BOMBUJ_CONF"

# These rollback configs change ONLY the names; they import the current
# ecosystem files, so all environment, cwd and process parameters are preserved.
node - "$ROOT" "$STATE" <<'NODE'
const fs=require('node:fs');
const path=require('node:path');
const [root,state]=process.argv.slice(2);
for(const [name,source,output] of [
  ['stremio-sktonline','ecosystem.config.js','old-main.config.cjs'],
  ['stremio-bombuj','ecosystem.bombuj.config.cjs','old-bombuj.config.cjs']
]){
  const code="'use strict';\nconst config=require("+JSON.stringify(path.join(root,source))+");\n"+
    "module.exports={apps:[{...config.apps[0],name:"+JSON.stringify(name)+"}]};\n";
  fs.writeFileSync(path.join(state,output),code,{mode:0o600});
}
NODE

# Before replacing PM2 saved state, persist a known-good snapshot.
pm2 save >/dev/null

CHANGED=1
pm2 delete stremio-sktonline >/dev/null
pm2 start "$MAIN_CONF" --only stremio-addons --update-env >/dev/null
wait_for_url http://127.0.0.1:7003/health

pm2 delete stremio-bombuj >/dev/null
pm2 start "$BOMBUJ_CONF" --only stremio-addons-bombuj --update-env >/dev/null
wait_for_url http://127.0.0.1:7004/manifest.json

pm2 jlist > "$STATE/after.json"
node - "$STATE" "$ROOT" <<'NODE'
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const [state,root]=process.argv.slice(2);
const all=JSON.parse(fs.readFileSync(path.join(state,'after.json'),'utf8'));
for(const [name,tail,cwd] of [
  ['stremio-addons','/addon.js',''],
  ['stremio-addons-bombuj','/providers/bombuj/preflight-front.js','/providers/bombuj']
]){
  const found=all.filter(a=>a.name===name);
  assert.equal(found.length,1,name+' must have exactly one PM2 entry');
  const e=found[0].pm2_env;
  assert.equal(e.status,'online');
  assert.equal(e.pm_exec_path,root+tail);
  assert.equal(e.pm_cwd,root+cwd);
}
for(const stale of ['stremio-sktonline','stremio-bombuj'])
  assert.equal(all.filter(a=>a.name===stale).length,0,'old process still exists: '+stale);
const before=JSON.parse(fs.readFileSync(path.join(state,'before-bombuj.json'),'utf8'));
const newConfig=require(root+'/ecosystem.bombuj.config.cjs').apps[0];
const live=JSON.parse(require('node:child_process').execFileSync('curl',['-fsS','--max-time','15','http://127.0.0.1:7004/manifest.json'],{encoding:'utf8'}));
const catalogs=m=>(m.catalogs||[]).map(c=>c.type+':'+c.id).sort();
assert.equal(live.id,before.id,'Bombuj addon ID must remain stable');
assert.equal(live.version,before.version,'Bombuj version must remain stable');
assert.deepEqual(catalogs(live),catalogs(before),'Bombuj catalog IDs must remain stable');
assert.equal(foundOrThrow('stremio-addons-bombuj').pm2_env.BOMBUJ_DIRECT_VOE,newConfig.env.BOMBUJ_DIRECT_VOE);
function foundOrThrow(name){return all.find(a=>a.name===name)||(()=>{throw Error('Missing '+name)})()}
console.log('Validated PM2 names, scripts, ports and Bombuj catalog identities.');
NODE

pm2 save >/dev/null
FINISHED=1
echo 'PM2_RENAME_SUCCESS: stremio-addons:7003; stremio-addons-bombuj:7004.'
