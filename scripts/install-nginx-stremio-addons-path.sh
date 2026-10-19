#!/usr/bin/env bash
# Rename the public nginx mount from /stremio-sktonline/ to /stremio-addons/.
# Old URLs intentionally expire; PM2 service, key filename and token AAD stay
# unchanged so newly generated encrypted configs retain their compatibility.
set -Eeuo pipefail
umask 077
exec 8>/tmp/caseycz-stremio-nginx-configure.lock
flock -w 30 8

link=/etc/nginx/sites-enabled/default
test -e "$link" || { echo "Expected nginx site missing" >&2; exit 1; }
site="$(readlink -f "$link")"
case "$site" in
  /etc/nginx/sites-available/default|/etc/nginx/sites-enabled/default) ;;
  *) echo "Unexpected nginx target: $site" >&2; exit 1 ;;
esac
marker='BEGIN CASEYCZ STREMIO ADDONS PATH MIGRATION'
if sudo -n grep -Fq "$marker" "$site"; then
  sudo -n nginx -t
  echo "/stremio-addons/ already installed; no compatibility alias."
  exit 0
fi

backup="$(sudo -n mktemp /var/tmp/stremio-nginx-addons.XXXXXXXX)"
sudo -n cp -p -- "$site" "$backup"
sudo -n chmod 600 "$backup"
changed=0
restore() {
  local status=$?
  trap - ERR
  if [[ "$changed" == 1 ]]; then
    echo "Nginx migration failed; restoring previous nginx configuration." >&2
    sudo -n cp -p -- "$backup" "$site" || true
    sudo -n nginx -t || true
    sudo -n systemctl reload nginx || true
  fi
  sudo -n rm -f -- "$backup" || true
  exit "$status"
}
trap restore ERR

sudo -n python3 - "$site" <<'PY'
import os
from pathlib import Path
import re
import sys
import tempfile

site = Path(sys.argv[1])
original = site.read_text()
marker = 'BEGIN CASEYCZ STREMIO ADDONS PATH MIGRATION'
if marker in original:
    sys.exit(0)

old = '/stremio-sktonline'
new = '/stremio-addons'
if new in original:
    raise SystemExit('Unexpected pre-existing /stremio-addons route; refusing migration')

primary = re.search(r'(?m)^[ \t]*location[ \t]+/stremio-sktonline/[ \t]*\{', original)
if not primary:
    raise SystemExit('Expected original SKTOnline nginx location missing')
# Validate only the existing backend, not an approximate or unknown site.
primary_body = original[primary.start():primary.start() + 850]
for required in (
    'proxy_pass http://127.0.0.1:7003/;',
    'proxy_redirect /configure /stremio-sktonline/configure;',
    'proxy_set_header X-Forwarded-Prefix /stremio-sktonline;'
):
    if required not in primary_body:
        raise SystemExit('Unexpected nginx SKTOnline upstream; refusing migration: ' + required)

if not re.search(r'(?m)^[ \t]*location[ \t]+=[ \t]+/stremio-sktonline[ \t]*\{', original):
    raise SystemExit('Expected legacy no-trailing-slash location missing')

root_begin = original.find('BEGIN CASEYCZ STREMIO CONFIGURE ROOT REDIRECT')
root_end = original.find('END CASEYCZ STREMIO CONFIGURE ROOT REDIRECT')
if root_begin < 0 or root_end <= root_begin:
    raise SystemExit('Existing root Configure route patch missing')
if 'return 302 /stremio-sktonline/configure;' not in original[root_begin:root_end]:
    raise SystemExit('Unexpected root Configure redirect; refusing migration')

# Only known nginx route, proxy and redirect lines may contain the legacy path.
# Refuse to silently rewrite any unrelated URL or proxy on this nginx server.
allowed = (
    r'location\s+(?:=\s+)?/stremio-sktonline',
    r'proxy_redirect\s+/configure\s+/stremio-sktonline',
    r'proxy_set_header\s+X-Forwarded-Prefix\s+/stremio-sktonline',
    r'return\s+30[1278]\s+/stremio-sktonline',
)
for line in original.splitlines():
    if old not in line or line.lstrip().startswith('#'):
        continue
    if not any(re.search(expr, line) for expr in allowed):
        raise SystemExit('Unexpected legacy path outside known locations; refusing migration')

# Replace public mount and its forwarded headers while retaining same :7003.
updated = original.replace(old, new)
# Include /stremio-addons/ default landing route: app.get('/') redirects to
# /configure, which proxy_redirect remaps to /stremio-addons/configure.
anchor = re.search(r'(?m)^(?P<indent>[ \t]*)location[ \t]+/stremio-addons/[ \t]*\{', updated)
if not anchor:
    raise SystemExit('Missing migrated canonical location')
marker_block = anchor.group('indent') + '# ' + marker + '\n'
updated = updated[:anchor.start()] + marker_block + updated[anchor.start():]
if old in updated:
    raise SystemExit('Old public URL still found after migration')

fd, temp = tempfile.mkstemp(prefix='.stremio-nginx-route-', dir=str(site.parent))
try:
    st = site.stat()
    os.fchmod(fd, st.st_mode & 0o777)
    os.fchown(fd, st.st_uid, st.st_gid)
    with os.fdopen(fd, 'w') as stream:
        stream.write(updated)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temp, site)
except BaseException:
    try: os.unlink(temp)
    except OSError: pass
    raise
PY
changed=1
sudo -n nginx -t
sudo -n systemctl reload nginx
changed=0
trap - ERR
sudo -n rm -f -- "$backup"
echo "Nginx public path migrated to /stremio-addons/ (no old URL alias)."
