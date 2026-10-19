#!/usr/bin/env bash
# One-time, reversible relocation of the unified checkout; URLs/ports stay stable.
set -Eeuo pipefail
umask 077
OLD=/home/ubuntu/stremio.sktonline
NEW=/home/ubuntu/stremio.addons
CHANGED=0
MOVED=0
DONE=0
STATE="$(mktemp -d /tmp/addons-runtime-relocate.XXXXXX)"
exec 9>/tmp/stremio-sktonline-auto-deploy.lock
flock -n 9 || { echo 'Another addons update is running; retry later.' >&2; exit 1; }
cleanup() { rm -rf "$STATE"; }
rollback() {
  local status=$?
  trap - ERR
  if [[ "$CHANGED" == 1 && "$DONE" != 1 ]]; then
    pm2 delete stremio-sktonline >/dev/null 2>&1 || true
    pm2 delete stremio-bombuj >/dev/null 2>&1 || true
    if [[ "$MOVED" == 1 ]]; then mv -T -- "$NEW" "$OLD" || true; fi
    pm2 start "$OLD/ecosystem.config.js" --only stremio-sktonline --update-env >/dev/null 2>&1 || true
    pm2 start "$OLD/ecosystem.bombuj.config.cjs" --only stremio-bombuj --update-env >/dev/null 2>&1 || true
    pm2 save >/dev/null 2>&1 || true
    echo 'Relocation failed; restored previous directory and PM2 definitions. Check service health.' >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap rollback ERR

if [[ -d "$NEW/.git" && ! -e "$OLD" ]]; then
  echo 'Unified addons directory already relocated.'
  exit 0
fi
[[ -d "$OLD/.git" && ! -L "$OLD" && ! -e "$NEW" ]] || { echo 'Unexpected source/target state; refusing relocation.' >&2; exit 1; }
[[ "$(git -C "$OLD" branch --show-current)" == Master ]] || { echo 'Expected Master.' >&2; exit 1; }
[[ "$(git -C "$OLD" remote get-url origin)" == https://github.com/CaseyCZ/stremio.addons.git ]] || { echo 'Expected unified addons Git remote.' >&2; exit 1; }
git -C "$OLD" diff --quiet && git -C "$OLD" diff --cached --quiet || { echo 'Tracked local changes; refusing relocation.' >&2; exit 1; }
[[ -z "$(find "$OLD" -type l -lname "$OLD/*" -print -quit)" ]] || { echo 'An absolute symlink inside the checkout needs adjustment first.' >&2; exit 1; }
# No service outside this checkout may still depend on its former path.
sudo -n true
DEPENDENCIES="$(sudo -n grep -RIlF "$OLD" /etc/nginx /etc/systemd/system /etc/cron.d /var/spool/cron/crontabs 2>/dev/null || true)"
[[ -z "$DEPENDENCIES" ]] || { echo 'System configurations still reference the old directory:' >&2; printf '%s\n' "$DEPENDENCIES" >&2; exit 1; }
pm2 jlist > "$STATE/pm2-before.json"
node - "$STATE/pm2-before.json" "$OLD" <<'NODE'
const fs=require('node:fs'),all=JSON.parse(fs.readFileSync(process.argv[2]));
for(const [name,tail] of [['stremio-sktonline','/addon.js'],['stremio-bombuj','/providers/bombuj/preflight-front.js']]){
 const apps=all.filter(a=>a.name===name);
 if(apps.length!==1||apps[0].pm2_env?.status!=='online'||apps[0].pm2_env.pm_exec_path!==process.argv[3]+tail)throw Error('Unexpected runtime state: '+name);
}
NODE
npm --prefix "$OLD/providers/bombuj" run check
node --check "$OLD/ecosystem.config.js"
node --check "$OLD/ecosystem.bombuj.config.cjs"
for port in 7003 7004; do curl -fsS --max-time 10 "http://127.0.0.1:$port/manifest.json" > "$STATE/before-$port.json"; done
CHANGED=1
pm2 stop stremio-sktonline >/dev/null
pm2 stop stremio-bombuj >/dev/null
mv -T -- "$OLD" "$NEW"
MOVED=1
# Recreate only these stopped applications so PM2 updates both cwd and script.
pm2 delete stremio-sktonline >/dev/null
pm2 delete stremio-bombuj >/dev/null
pm2 start "$NEW/ecosystem.config.js" --only stremio-sktonline --update-env >/dev/null
pm2 start "$NEW/ecosystem.bombuj.config.cjs" --only stremio-bombuj --update-env >/dev/null
for port in 7003 7004; do
  READY=0
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$port/manifest.json" > "$STATE/after-$port.json" 2>/dev/null; then READY=1; break; fi
    sleep 1
  done
  [[ "$READY" == 1 ]] || false
done
pm2 jlist > "$STATE/pm2-after.json"
node - "$STATE" "$NEW" <<'NODE'
const fs=require('node:fs'),dir=process.argv[2],root=process.argv[3];
const all=JSON.parse(fs.readFileSync(dir+'/pm2-after.json'));
for(const [name,tail,cwd] of [['stremio-sktonline','/addon.js',''],['stremio-bombuj','/providers/bombuj/preflight-front.js','/providers/bombuj']]){
 const apps=all.filter(a=>a.name===name),e=apps[0]?.pm2_env;
 if(apps.length!==1||e?.status!=='online'||e.pm_exec_path!==root+tail||e.pm_cwd!==root+cwd)throw Error('Runtime path verification failed: '+name);
 console.log(JSON.stringify({name,status:e.status,script:e.pm_exec_path,cwd:e.pm_cwd}));
}
for(const port of [7003,7004]){
 const a=JSON.parse(fs.readFileSync(dir+'/before-'+port+'.json')),b=JSON.parse(fs.readFileSync(dir+'/after-'+port+'.json'));
 const ids=m=>(m.catalogs||[]).map(c=>c.type+':'+c.id).sort().join('|');
 if(a.id!==b.id||a.version!==b.version||ids(a)!==ids(b))throw Error('Manifest/catalog identities changed on '+port);
}
NODE
pm2 save >/dev/null
DONE=1
echo 'ADDONS_DIRECTORY_RELOCATION_SUCCESS: /home/ubuntu/stremio.addons; ports 7003/7004 unchanged.'
