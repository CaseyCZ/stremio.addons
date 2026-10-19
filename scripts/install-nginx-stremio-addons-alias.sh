#!/usr/bin/env bash
# Public path migration: /stremio-addons/ becomes canonical; existing
# /stremio-sktonline/ install URLs must continue to work unchanged.
# Never rename the PM2 process, server directory, or AES-GCM key/AAD here.
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
marker='BEGIN CASEYCZ STREMIO ADDONS PUBLIC ALIAS'
if sudo -n grep -Fq "$marker" "$site"; then
  sudo -n nginx -t
  echo "Canonical /stremio-addons/ nginx route already installed."
  exit 0
fi

backup="$(sudo -n mktemp /root/stremio-nginx-addons.XXXXXXXX)"
sudo -n cp -a -- "$site" "$backup"
changed=0
restore() {
  local status=$?
  trap - ERR
  if [[ "$changed" == 1 ]]; then
    echo "Restoring nginx configuration because migration failed" >&2
    sudo -n cp -a -- "$backup" "$site" || true
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
marker = 'BEGIN CASEYCZ STREMIO ADDONS PUBLIC ALIAS'
if marker in original:
    sys.exit(0)

old_pattern = re.compile(r'(?m)^(?P<indent>[ \t]*)location[ \t]+/stremio-sktonline/[ \t]*\{[ \t]*$', re.MULTILINE)
anchors = list(old_pattern.finditer(original))
if len(anchors) != 1:
    raise SystemExit('Expected exactly one old SKTOnline nginx location; refusing migration')
anchor = anchors[0]
start = anchor.start()
opening = original.index('{', anchor.start(), anchor.end())
depth = 0
end = -1
for index in range(opening, len(original)):
    if original[index] == '{': depth += 1
    if original[index] == '}':
        depth -= 1
        if depth == 0:
            end = index + 1
            break
if end < 0:
    raise SystemExit('Cannot parse existing old SKTOnline nginx location')
old = original[start:end]
if 'proxy_pass http://127.0.0.1:7003/;' not in old:
    raise SystemExit('Unexpected SKTOnline backend; refusing migration')
if 'proxy_redirect /configure /stremio-sktonline/configure;' not in old:
    raise SystemExit('Unexpected SKTOnline Configure redirect; refusing migration')
if 'proxy_set_header X-Forwarded-Prefix /stremio-sktonline;' not in old:
    raise SystemExit('Unexpected SKTOnline forwarded prefix; refusing migration')
if re.search(r'(?m)^[ \t]*location[ \t]+(?:= )?/stremio-addons(?:/|[ \t])', original):
    raise SystemExit('Canonical path already exists outside migration marker; refusing duplicate')

indent = anchor.group('indent')
new = old.replace('/stremio-sktonline', '/stremio-addons')
if '/stremio-sktonline' in new:
    raise SystemExit('Incomplete route rewrite')
block = (
    f'{indent}# BEGIN CASEYCZ STREMIO ADDONS PUBLIC ALIAS\n'
    f'{indent}# New canonical prefix; old /stremio-sktonline/ remains unchanged.\n'
    f'{indent}location = /stremio-addons {{ return 301 /stremio-addons/; }}\n'
    f'{indent}location = /stremio-addons/ {{ return 302 /stremio-addons/configure; }}\n'
    f'{new}\n'
    f'{indent}# END CASEYCZ STREMIO ADDONS PUBLIC ALIAS\n'
)
updated = original[:start] + block + original[start:]
# Update only our previously installed root-Configure redirect, not legacy routes.
root_start = updated.find('BEGIN CASEYCZ STREMIO CONFIGURE ROOT REDIRECT')
root_end = updated.find('END CASEYCZ STREMIO CONFIGURE ROOT REDIRECT')
if root_start < 0 or root_end <= root_start:
    raise SystemExit('Previous Configure root nginx patch missing; refusing migration')
section = updated[root_start:root_end]
old_redirect = 'return 302 /stremio-sktonline/configure;'
if section.count(old_redirect) != 1:
    raise SystemExit('Expected exactly one old root Configure redirect')
updated = updated[:root_start] + section.replace(old_redirect, 'return 302 /stremio-addons/configure;') + updated[root_end:]

fd, tmp = tempfile.mkstemp(prefix='.stremio-nginx-route-', dir=str(site.parent))
try:
    st = site.stat()
    os.fchmod(fd, st.st_mode & 0o777)
    os.fchown(fd, st.st_uid, st.st_gid)
    with os.fdopen(fd, 'w') as stream:
        stream.write(updated)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, site)
except BaseException:
    try: os.unlink(tmp)
    except OSError: pass
    raise
PY
changed=1
sudo -n nginx -t
sudo -n systemctl reload nginx
changed=0
trap - ERR
sudo -n rm -f -- "$backup"
echo "Canonical /stremio-addons/ is live; /stremio-sktonline/ compatibility preserved."
