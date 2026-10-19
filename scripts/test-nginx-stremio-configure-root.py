#!/usr/bin/env python3
"""Test nginx route insertion offline, without sudo or touching real nginx."""
from pathlib import Path
import re
import subprocess
import tempfile

SCRIPT = Path(__file__).with_name('install-nginx-stremio-configure-root.sh').read_text()
parts = SCRIPT.split("<<'PY'\n", 1)
assert len(parts) == 2, 'Embedded Python nginx renderer missing'
renderer, rest = parts[1].split('\nPY\n', 1)
source = r"""server {
    location = /configure { proxy_pass http://127.0.0.1:7003; }
    location ~ "^/enc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/" {
        proxy_pass http://127.0.0.1:7000;
    }
    location /stremio-sktonline/ { proxy_pass http://127.0.0.1:7003/; }
}
"""
with tempfile.TemporaryDirectory() as folder:
    path = Path(folder) / 'default'
    path.write_text(source)
    run = subprocess.run(['python3', '-c', renderer, str(path)],
                         capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    updated = path.read_text()
    assert updated.count('BEGIN CASEYCZ STREMIO CONFIGURE ROOT REDIRECT') == 1
    assert updated.index('BEGIN CASEYCZ') < updated.index('location ~ "^/enc1')
    assert 'proxy_pass http://127.0.0.1:7000' in updated
    assert 'proxy_pass http://127.0.0.1:7003/' in updated
    assert 'return 302 /stremio-sktonline/configure;' in updated
    assert 'access_log off;' in updated
    pattern = re.search(r'location ~ "(\^/enc1[^\n]+)" \{', updated)
    assert pattern, 'New regex not found'
    route = re.compile(pattern.group(1))
    token = 'enc1.' + '.'.join(['abc123_-', 'def456', 'ghi789'])
    for path_in in ['/' + token, '/' + token + '/',
                    '/' + token + '/bombuj', '/' + token + '/bombuj/',
                    '/' + token + '/prehrajto', '/' + token + '/prehrajto/']:
        assert route.fullmatch(path_in), f'Root Configure not matched: {path_in}'
    for path_out in ['/' + token + '/manifest.json', '/' + token + '/stream/movie/a.json',
                     '/' + token + '/bombuj/manifest.json',
                     '/' + token + '/prehrajto/stream/movie/a.json',
                     '/stremio-sktonline/' + token,
                     '/not_a_token', '/enc1.bad/manifest.json']:
        assert not route.fullmatch(path_out), f'Unsafe route interception: {path_out}'
    again = subprocess.run(['python3', '-c', renderer, str(path)],
                           capture_output=True, text=True)
    assert again.returncode == 0, again.stderr
    assert path.read_text() == updated, 'Route insertion must be idempotent'
    wrong = Path(folder) / 'wrong'
    wrong.write_text('server { location / {} }\n')
    failed = subprocess.run(['python3', '-c', renderer, str(wrong)],
                            capture_output=True, text=True)
    assert failed.returncode != 0, 'Unexpected configuration must be rejected'
print('Nginx root Configure redirect: isolated tests passed')
