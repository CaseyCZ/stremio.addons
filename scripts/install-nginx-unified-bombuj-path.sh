#!/usr/bin/env bash
# Move native Bombuj's public nginx mount into the consolidated /stremio-addons/
# namespace. Internal PM2 app/port 7004 and its Stremio addon routes remain intact.
# Old /stremio-bombuj URLs are intentionally retired; user requested no old aliases.
set -Eeuo pipefail
umask 077
exec 8>/tmp/caseycz-stremio-nginx-configure.lock
flock -w 30 8

link=/etc/nginx/sites-enabled/default
test -e "$link" || { echo 'Expected nginx default site missing' >&2; exit 1; }
site="$(readlink -f "$link")"
case "$site" in
  /etc/nginx/sites-available/default|/etc/nginx/sites-enabled/default) ;;
  *) echo "Unexpected nginx target: $site" >&2; exit 1 ;;
esac

marker='BEGIN CASEYCZ UNIFIED BOMBUJ PUBLIC ROUTE'
if sudo -n grep -Fq "$marker" "$site"; then
  sudo -n nginx -t
  echo 'Native Bombuj is already mounted at /stremio-addons/bombuj/.'
  exit 0
fi

backup="$(sudo -n mktemp /var/tmp/stremio-nginx-bombuj.XXXXXXXX)"
sudo -n cp -p -- "$site" "$backup"
sudo -n chmod 600 "$backup"
changed=0
rollback() {
  local code=$?
  trap - ERR
  if [[ "$changed" == 1 ]]; then
    echo 'Bombuj public route migration failed; restoring nginx site.' >&2
    sudo -n cp -p -- "$backup" "$site" || true
    sudo -n nginx -t || true
    sudo -n systemctl reload nginx || true
  fi
  sudo -n rm -f -- "$backup" || true
  exit "$code"
}
trap rollback ERR

sudo -n python3 - "$site" <<'PY'
import os
from pathlib import Path
import re
import sys
import tempfile

site = Path(sys.argv[1])
source = site.read_text()
marker = 'BEGIN CASEYCZ UNIFIED BOMBUJ PUBLIC ROUTE'
if marker in source:
    sys.exit(0)

# Extract only the three existing public Bombuj locations, preserving every
# timeout and forwarded header. Never redirect video bytes through port 7003.
def find_block(location):
    pattern = re.compile(r'(?m)^[ \t]*location[ \t]+' + re.escape(location) + r'[ \t]*\{')
    hits = list(pattern.finditer(source))
    if len(hits) != 1:
        raise SystemExit('Expected one nginx location for ' + location)
    m = hits[0]
    begin = m.start()
    depth = 0
    end = None
    for i in range(source.index('{', begin), len(source)):
        c = source[i]
        if c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if end is None:
        raise SystemExit('Unterminated location ' + location)
    return begin, end, source[begin:end]

old_locations = ['= /stremio-bombuj', '= /stremio-bombuj/', '/stremio-bombuj/']
found = [find_block(s) for s in old_locations]
if not all('return 302 /stremio-bombuj/manifest.json;' in text for _, _, text in found[:2]):
    raise SystemExit('Unexpected legacy Bombuj root redirect')
body = found[2][2]
if 'proxy_pass http://127.0.0.1:7004/;' not in body:
    raise SystemExit('Bombuj public backend is not the expected port 7004')
if 'proxy_read_timeout 120s;' not in body:
    raise SystemExit('Bombuj timeout differs; inspect before migration')
if not re.search(r'(?m)^[ \t]*location[ \t]+/stremio-addons/[ \t]*\{', source):
    raise SystemExit('Shared /stremio-addons/ route not found')
if re.search(r'(?m)^[ \t]*location[ \t]+(?:=\s*)?/stremio-addons/bombuj(?:/|\s)', source):
    raise SystemExit('Native Bombuj is already exposed at target location')

# Disallow unexpected occurrences of the legacy path in live config lines.
for line in source.splitlines():
    if '/stremio-bombuj' not in line or line.lstrip().startswith('#'):
        continue
    if not (
        re.search(r'^\s*location\s+', line)
        or re.search(r'^\s*return\s+302\s+/stremio-bombuj/manifest.json;', line)
    ):
        raise SystemExit('Unexpected legacy Bombuj reference outside known locations')

replacement = []
for index, (_, _, text) in enumerate(found):
    renamed = text.replace('/stremio-bombuj', '/stremio-addons/bombuj')
    if index == 2:
        # Explicit forwarded prefix is useful when using the native provider
        # behind the new public mount, but does not change its relative SDK URLs.
        renamed = renamed.replace(
            'proxy_pass http://127.0.0.1:7004/;',
            'proxy_pass http://127.0.0.1:7004/;\n'
            '        proxy_set_header X-Forwarded-Prefix /stremio-addons/bombuj;'
        )
    replacement.append(renamed)

updated = source
for (start, end, _), text in sorted(zip(found, replacement), reverse=True):
    updated = updated[:start] + text + updated[end:]

# Existing provider block stays in place. Nginx automatically selects
# /stremio-addons/bombuj/ over the shorter /stremio-addons/ prefix.
target_line = re.search(r'(?m)^(?P<space>\s*)location\s+=\s+/stremio-addons/bombuj\s*\{', updated)
if not target_line:
    raise SystemExit('New Bombuj exact-location missing')
mark = target_line.group('space') + '# ' + marker + '\n'
updated = updated[:target_line.start()] + mark + updated[target_line.start():]
if '/stremio-bombuj' in updated:
    raise SystemExit('Legacy public Bombuj path remains after migration')

fd, temp = tempfile.mkstemp(prefix='.stremio-nginx-bombuj-', dir=str(site.parent))
try:
    st = site.stat()
    os.fchmod(fd, st.st_mode & 0o777)
    os.fchown(fd, st.st_uid, st.st_gid)
    with os.fdopen(fd, 'w') as file:
        file.write(updated)
        file.flush()
        os.fsync(file.fileno())
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
echo 'Native Bombuj public path migrated to /stremio-addons/bombuj/ (no legacy alias).'
