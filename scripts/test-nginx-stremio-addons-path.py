#!/usr/bin/env python3
"""Offline regression for safe public URL migration; no sudo/network needed."""
from pathlib import Path
import subprocess
import tempfile

script = Path(__file__).with_name('install-nginx-stremio-addons-path.sh').read_text()
assert "<<'PY'\n" in script, 'Missing isolated Python nginx renderer'
renderer = script.split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]

original = r"""server {
    # BEGIN CASEYCZ STREMIO CONFIGURE ROOT REDIRECT
    location ~ "^/enc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:/(?:bombuj|prehrajto))?/?$" {
        access_log off;
        return 302 /stremio-sktonline/configure;
    }
    # END CASEYCZ STREMIO CONFIGURE ROOT REDIRECT
    location ~ "^/enc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/" {
        proxy_pass http://127.0.0.1:7000;
    }
    location = /stremio-sktonline {
        return 301 /stremio-sktonline/;
    }
    location /stremio-sktonline/ {
        limit_req zone=stremio_limit burst=60 nodelay;

        proxy_pass http://127.0.0.1:7003/;
        proxy_redirect /configure /stremio-sktonline/configure;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Prefix /stremio-sktonline;
    }
    location /stremio-sosac/ { proxy_pass http://127.0.0.1:7000/; }
    location /stremio-bombuj/ { proxy_pass http://127.0.0.1:7004/; }
}
"""

def run(site):
    return subprocess.run(['python3', '-c', renderer, str(site)],
                          text=True, capture_output=True)

with tempfile.TemporaryDirectory() as folder:
    site = Path(folder) / 'default'
    site.write_text(original)
    success = run(site)
    assert success.returncode == 0, success.stderr
    output = site.read_text()
    assert 'BEGIN CASEYCZ STREMIO ADDONS PATH MIGRATION' in output
    assert '/stremio-sktonline' not in output
    assert 'location = /stremio-addons {' in output
    assert 'location /stremio-addons/ {' in output
    assert 'proxy_pass http://127.0.0.1:7003/;' in output
    assert 'proxy_redirect /configure /stremio-addons/configure;' in output
    assert 'proxy_set_header X-Forwarded-Prefix /stremio-addons;' in output
    assert 'return 302 /stremio-addons/configure;' in output
    assert 'location /stremio-sosac/' in output
    assert 'location /stremio-bombuj/' in output
    assert 'proxy_pass http://127.0.0.1:7000;' in output

    # The bash installer detects the marker and skips renderer on a second run.
    assert run(site).returncode != 0, 'Renderer should refuse re-running over canonical path'

    other = Path(folder) / 'other'
    other.write_text(original.replace('proxy_pass http://127.0.0.1:7003/;',
                                      'proxy_pass http://127.0.0.1:7000/;'))
    assert run(other).returncode != 0
    assert other.read_text() != output

    other.write_text(original.replace('location = /stremio-sktonline {',
                                      'location = /something-else {'))
    assert run(other).returncode != 0

print('Nginx canonical /stremio-addons migration: offline checks passed')
