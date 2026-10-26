'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { isStreamtapeCdn, staticStringExpression, extractGate,
  resolveStreamtape } = require('./resolvers/streamtape.js');

const id = 'jrw77oXa8zUzAV4';
const page = `https://streamtape.com/v/${id}`;
const gate = `https://streamtape.com/get_video?id=${id}&token=test_token&stream=1`;
const cdn = 'https://s1.tapecontent.net/video/file.mp4?token=testing';
const html = `<script>document.getElementById('norobotlink').innerHTML = ` +
  `'https://streamtape.com/get_video?id=' + '${id}' + '&token=test_token&stream=1';</script>`;

test('Streamtape extracts literal source without executing arbitrary remote scripts', () => {
  assert.equal(staticStringExpression("'abc' + ('z0123').substring(2)"), 'abc123');
  assert.equal(staticStringExpression("(() => stealCookies())()"), null);
  assert.equal(extractGate(html, id), gate);
  assert.equal(extractGate(html, 'wrong'), null);
  assert(isStreamtapeCdn(cdn));
  assert(!isStreamtapeCdn('https://tapecontent.net.evil.example/secret.mp4'));
  assert(!isStreamtapeCdn('http://s1.tapecontent.net/movie.mp4'));
});

test('Streamtape follows only the signed gate and verifies a tiny MP4 range', async () => {
  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url, init });
    if (url === page) return new Response(html);
    if (url === gate) return new Response(null, { status: 302, headers: { Location: cdn } });
    if (url === cdn) {
      assert.equal(init.headers.Range, 'bytes=0-31');
      return new Response(Buffer.from('000000186674797069736F6D00000000', 'hex'), { status: 206 });
    }
    throw Error('unexpected URL: ' + url);
  };
  const result = await resolveStreamtape(`https://streamtape.com/e/${id}/`, { fetchImpl: mockFetch });
  assert.equal(result.url, cdn);
  assert.equal(result.type, 'mp4');
  assert(result.ephemeral);
  assert.equal(calls.length, 3);
});

test('Streamtape rejects non-CDN redirects and HTML disguised as MP4', async () => {
  const mockFetch = async url => url === page ? new Response(html) :
    new Response(null, { status: 302, headers: { Location: 'https://localhost/secret.mp4' } });
  assert.equal(await resolveStreamtape(`https://streamtape.com/e/${id}`, { fetchImpl: mockFetch }), null);
  const mockHtml = async url => url === page ? new Response(html) : url === gate ?
    new Response(null, { status: 302, headers: { Location: cdn } }) :
    new Response('<html>not an MP4</html>', { status: 200 });
  assert.equal(await resolveStreamtape(`https://streamtape.com/e/${id}`, { fetchImpl: mockHtml }), null);
});

test('Bombuj Streamtape player stays external unless the direct test is enabled', async () => {
  const file = require.resolve('./index.js'), local = createRequire(file);
  const sdk = { addonBuilder: class {
    defineCatalogHandler() {} defineStreamHandler() {} getInterface() { return {}; }
  }, serveHTTP() {} };
  const embed = `https://streamtape.com/e/${id}`;
  for (const enabled of [false, true]) {
    let calls = 0;
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      require: p => p === 'stremio-addon-sdk' ? sdk : p === './resolvers/streamtape.js' ? {
        resolveStreamtape: async url => {
          calls++;
          assert.equal(url, embed);
          return { url: cdn, type: 'mp4' };
        }
      } : local(p),
      module: mod, process: { env: enabled ? { BOMBUJ_DIRECT_STREAMTAPE: '1' } : {} },
      console: { log() {}, warn() {}, error() {} },
      URL, URLSearchParams, AbortSignal, Buffer, Uint8Array,
      fetch: () => { throw Error('no network expected'); }
    });
    const streams = await mod.exports.playersToStreams([
      { provider: 'streamtape.com', language: 'CZ dabing', resolvedUrl: embed }
    ], 'https://www.bombuj.si/online-film-example');
    assert.equal(calls, enabled ? 1 : 0);
    assert.equal(enabled ? streams[0].url : streams[0].externalUrl, enabled ? cdn : embed);
  }
});
