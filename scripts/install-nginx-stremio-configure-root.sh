#!/usr/bin/env bash
# Fix Stremio Configure button: Stremio opens /enc1.TOKEN or
# /enc1.TOKEN/{bombuj,prehrajto} at the server origin, *not* below
# /stremio-sktonline/. The pre-existing nginx rule sends root /enc1.TOKEN/*
# to port 7000 (Sosac), where Configure is not implemented.
#
# Narrow, idempotent, reversible nginx change: only exact directory roots
# redirect to the public shared configuration page. Tokenized manifest,
# catalog and stream paths keep their existing routing.
set -Eeuo pipefail
umask 077

exec 8>/tmp/caseycz-stremio-nginx-configure.lock
flock -w 30 8

link=/etc/nginx/sites-enabled/default
test -e "$link" || { echo "Expected nginx default site not found" >&2; exit 1; }
site="$(readlink -f "$link")"
case "$site" in
  /etc/nginx/sites-available/default|/etc/nginx/sites-enabled/default) ;;
  *) echo "Unexpected nginx target; refusing edit: $site" >&2; exit 1 ;;
esac

marker='BEGIN CASEYCZ STREMIO CONFIGURE ROOT REDIRECT'
if sudo -n grep -Fq "$marker" "$site"; then
  # Check syntax even when the patch was already installed.
  sudo -n nginx -t
  echo "Stremio Configure root redirects already installed."
  exit 0
fi

backup="$(sudo -n mktemp /var/tmp/stremio-nginx-configure.XXXXXXXX)"
sudo -n cp -p -- "$site" "$backup"
sudo -n chmod 600 "$backup"
changed=0
rollback() {
  status=$?
  trap - ERR
  if [[ "$changed" == 1 ]]; then
    echo "Nginx configuration failed; restoring original site." >&2
    sudo -n cp -p -- "$backup" "$site" || true
    sudo -n nginx -t || true
    sudo -n systemctl reload nginx || true
  fi
  sudo -n rm -f -- "$backup" || true
  exit "$status"
}
trap rollback ERR

sudo -n python3 - "$site" <<'PY'
import os
from pathlib import Path
import re
import sys
import tempfile

site = Path(sys.argv[1])
original = site.read_text()
if 'BEGIN CASEYCZ STREMIO CONFIGURE ROOT REDIRECT' in original:
    sys.exit(0)
# The Sosac encrypted routes are preserved. Our precise redirect must be
# *before* the broad /enc1.TOKEN/* -> port 7000 regex.
anchor = re.search(r'(?m)^(?P<indent>[ \t]*)location[ \t]+~[ \t]+"?\^/enc1\\\.', original)
if not anchor:
    raise SystemExit('Expected existing nginx Sosac enc1 route not found; refusing edit')
if '/stremio-sktonline/' not in original:
    raise SystemExit('Nginx site is missing SKTOnline mount; refusing edit')

indent = anchor.group('indent')
block = (
    f'{indent}# BEGIN CASEYCZ STREMIO CONFIGURE ROOT REDIRECT\n'
    f'{indent}# Exact installation directories only; never match /manifest.json or /stream.\n'
    f'{indent}location ~ "^/enc1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+(?:/(?:bombuj|prehrajto))?/?$" {{\n'
    f'{indent}    access_log off;\n'
    f'{indent}    add_header Referrer-Policy "no-referrer" always;\n'
    f'{indent}    add_header Cache-Control "no-store" always;\n'
    f'{indent}    return 302 /stremio-sktonline/configure;\n'
    f'{indent}}}\n'
    f'{indent}# END CASEYCZ STREMIO CONFIGURE ROOT REDIRECT\n'
)
updated = original[:anchor.start()] + block + original[anchor.start():]
fd, temp_name = tempfile.mkstemp(prefix='.stremio-nginx-site-', dir=str(site.parent))
try:
    stat = site.stat()
    os.fchmod(fd, stat.st_mode & 0o777)
    os.fchown(fd, stat.st_uid, stat.st_gid)
    with os.fdopen(fd, 'w') as out:
        out.write(updated)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temp_name, site)
except BaseException:
    try: os.unlink(temp_name)
    except OSError: pass
    raise
PY
changed=1
sudo -n nginx -t
sudo -n systemctl reload nginx
changed=0
trap - ERR
sudo -n rm -f -- "$backup"
echo "Installed Stremio Configure root redirects without altering provider routes."
