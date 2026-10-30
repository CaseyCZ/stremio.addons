'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) =>
    server.listen(0, '127.0.0.1', resolve).on('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('Prehraj.to keeps a public guest manifest and an isolated encrypted optional-account manifest', async () => {
  const port = await availablePort();
  const origin = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['addon.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), CONFIG_ENCRYPTION_KEY: 'a'.repeat(64) },
    stdio: 'ignore'
  });
  try {
    let running = false;
    for (let i = 0; i < 60; i++) {
      if (child.exitCode !== null) throw Error('test server exited');
      try {
        const health = await fetch(origin + '/health');
        if (health.ok) { running = true; break; }
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(running, true);
    const publicManifest = await (await fetch(origin + '/prehrajto/manifest.json')).json();
    assert.equal(publicManifest.id, 'cz.caseycz.stremio.prehrajto.direct');

    const onlyEmail = await fetch(origin + '/api/config-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addonType: 'prehrajto', prehrajtoEmail: 'a@example.invalid' })
    });
    assert.equal(onlyEmail.status, 400);

    const account = await fetch(origin + '/api/config-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addonType: 'prehrajto', prehrajtoEmail: 'free@example.invalid',
        prehrajtoPassword: 'mock-password' })
    });
    assert.equal(account.status, 200);
    const data = await account.json();
    assert.match(data.token, /^enc1\./);
    assert.doesNotMatch(data.token, /free@example\.invalid|mock-password/);

    const manifest = await (await fetch(origin + '/' + data.token + '/manifest.json')).json();
    assert.equal(manifest.id, publicManifest.id);
    assert.deepEqual(manifest.resources, ['stream']);
    const invalidId = await (await fetch(origin + '/' + data.token +
      '/stream/movie/not-imdb.json')).json();
    assert.deepEqual(invalidId.streams, []);

    const ui = await (await fetch(origin + '/configure')).text();
    assert.match(ui, /id="prehrajtoEmail"/);
    assert.match(ui, /id="prehrajtoPassword"/);
    assert.match(ui, /data-addon="prehrajto"/);
    assert.match(ui, /Bez účtu/);
  } finally {
    child.kill();
  }
});
