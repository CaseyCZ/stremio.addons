#!/usr/bin/env python3
"""Offline test for migration of Bombuj public nginx location to unified namespace."""
from pathlib import Path
import subprocess
import tempfile

script = Path(__file__).with_name('install-nginx-unified-bombuj-path.sh').read_text()
assert "<<'PY'\n" in script
renderer = script.split("<<'PY'\n", 1)[1].split('\nPY\n', 1)[0]

old = r"""server {
    location = /stremio-bombuj {
        return 302 /stremio-bombuj/manifest.json;
    }
    location = /stremio-bombuj/ {
        return 302 /stremio-bombuj/manifest.json;
    }
    location /stremio-bombuj/ {
        proxy_pass http://127.0.0.1:7004/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }
    location /stremio-addons/ {
        proxy_pass http://127.0.0.1:7003/;
        proxy_redirect /configure /stremio-addons/configure;
        proxy_set_header X-Forwarded-Prefix /stremio-addons;
    }
    location /stremio-sosac/ { proxy_pass http://127.0.0.1:7000/; }
}
"""

def run(path):
    return subprocess.run(['python3', '-c', renderer, str(path)],
                          text=True, capture_output=True)

with tempfile.TemporaryDirectory() as directory:
    nginx = Path(directory) / 'default'
    nginx.write_text(old)
    result = run(nginx)
    assert result.returncode == 0, result.stderr
    updated = nginx.read_text()
    assert 'BEGIN CASEYCZ UNIFIED BOMBUJ PUBLIC ROUTE' in updated
    assert '/stremio-bombuj' not in updated, 'Legacy public route must be removed'
    assert 'location = /stremio-addons/bombuj {' in updated
    assert 'location = /stremio-addons/bombuj/ {' in updated
    assert 'location /stremio-addons/bombuj/ {' in updated
    assert 'return 302 /stremio-addons/bombuj/manifest.json;' in updated
    assert 'proxy_pass http://127.0.0.1:7004/;' in updated
    assert 'proxy_set_header X-Forwarded-Prefix /stremio-addons/bombuj;' in updated
    assert 'proxy_http_version 1.1;' in updated
    assert 'proxy_read_timeout 120s;' in updated
    assert 'location /stremio-addons/ {' in updated
    assert 'proxy_pass http://127.0.0.1:7003/;' in updated
    assert 'location /stremio-sosac/' in updated
    assert 'proxy_pass http://127.0.0.1:7000/;' in updated

    # A second invocation of the *renderer* itself must be a no-op; the shell
    # installer separately checks the marker before running it.
    again = run(nginx)
    assert again.returncode == 0, again.stderr
    assert nginx.read_text() == updated

    # A changed backend must not be silently migrated.
    wrong = Path(directory) / 'wrong'
    wrong.write_text(old.replace('proxy_pass http://127.0.0.1:7004/;',
                                 'proxy_pass http://127.0.0.1:7000/;'))
    failure = run(wrong)
    assert failure.returncode != 0
    assert wrong.read_text() != updated

    wrong.write_text(old.replace('location /stremio-addons/ {',
                                 'location /another-service/ {'))
    assert run(wrong).returncode != 0

print('Unified Bombuj public path migration tests passed')
