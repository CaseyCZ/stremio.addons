'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).on('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('Sledujteto has an isolated encrypted Stremio manifest and configurator', async () => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['addon.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), CONFIG_ENCRYPTION_KEY: 'a'.repeat(64) },
    stdio: 'ignore'
  });
  try {
    let ready = false;
    for (let n = 0; n < 50; n++) {
      if (child.exitCode !== null) throw Error('test server exited before health check');
      try {
        const health = await fetch(origin + '/health');
        ready = health.ok;
        if (ready) break;
      } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, 'local test server is ready');
    const invalid = await fetch(origin + '/api/config-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addonType: 'sledujteto', sledujtetoEmail: 'a@example.invalid' })
    });
    assert.equal(invalid.status, 400);

    const config = await fetch(origin + '/api/config-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addonType: 'sledujteto', uiLanguage: 'cs',
        sledujtetoEmail: 'test@example.invalid', sledujtetoPassword: 'fake-password' })
    });
    assert.equal(config.status, 200);
    const configData = await config.json();
    assert.match(configData.token, /^enc1\./);
    assert.doesNotMatch(configData.token, /test@example\.invalid|fake-password/);
    const tokenPath = '/' + configData.token;

    const manifest = await (await fetch(origin + tokenPath + '/manifest.json')).json();
    assert.equal(manifest.id, 'cz.caseycz.stremio.sledujteto.direct.test');
    assert.equal(manifest.name, 'Sledujteto Direct TEST');
    assert.deepEqual(manifest.resources, ['stream']);
    assert.ok(manifest.idPrefixes.includes('tt'));

    const nested = await (await fetch(origin + tokenPath + '/sledujteto/manifest.json')).json();
    assert.equal(nested.id, manifest.id);
    const invalidId = await (await fetch(origin + tokenPath + '/stream/movie/not-imdb.json')).json();
    assert.deepEqual(invalidId.streams, []);
    const configure = await fetch(origin + tokenPath + '/configure');
    assert.equal(configure.status, 200);
    assert.match(await configure.text(), /data-addon="sledujteto"/);

    // Existing HellSpy manifest remains independent of Sledujteto credentials.
    const hellspyConfig = await (await fetch(origin + '/api/config-token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addonType: 'hellspy' })
    })).json();
    const hellspyManifest = await (await fetch(origin + '/' + hellspyConfig.token + '/manifest.json')).json();
    assert.equal(hellspyManifest.id, 'cz.caseycz.stremio.hellspy.direct.test');
  } finally {
    child.kill();
  }
});
