'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { vidaraEmbed, vidaraCdnUrl, subtitleEntries, resolveVidara } = require('./resolvers/vidara.js');

const embed = 'https://vidara.to/e/dlXPGcileBF2m-1792961190';
const master = 'https://s1-s501740.97bf1.com/hls/2DNfwqPl9MrP3duVZ3DzUrHEabRO9tVy/master.m3u8?token=signed';
const playlist = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2600000,RESOLUTION=1924x1080\n1080/index.m3u8\n';

test('recognizes signed Vidara embed and removes only time suffix from filecode', () => {
  assert.equal(vidaraEmbed(embed)?.filecode, 'dlXPGcileBF2m');
  assert.equal(vidaraEmbed('https://vxcagb.com/e/abc')?.filecode, 'abc');
  assert.equal(vidaraEmbed('http://vidara.to/e/abc'), null);
  assert.equal(vidaraEmbed('https://vidara.to.evil.example/e/abc'), null);
  assert.equal(vidaraEmbed('https://vidara.to:8443/e/abc'), null);
});

test('accepts expected CDN master playlists but no arbitrary destinations', () => {
  assert(vidaraCdnUrl(master));
  assert(vidaraCdnUrl('https://s7-s501740.s1q2105.com/hls/abc/master.m3u8'));
  assert(!vidaraCdnUrl('https://localhost/hls/abc/master.m3u8'));
  assert(!vidaraCdnUrl('http://s1-s501740.97bf1.com/hls/abc/master.m3u8'));
  assert(!vidaraCdnUrl('https://s1-s501740.97bf1.com/evil.m3u8'));
});

test('Vidara flow resolves HLS and keeps all distinct valid subtitle URLs', async () => {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/stream')) return Response.json({ streaming_url: master,
      subtitles: [{ lang: 'cs', file: 'https://subs.example/one.vtt' },
        { language: 'cze', url: 'https://subs.example/two.vtt' },
        { lang: 'en', file: 'https://subs.example/en.vtt' }] });
    if (url === master) return new Response(playlist, { status: 200 });
    throw new Error('unexpected URL');
  };
  const out = await resolveVidara(embed, { fetchImpl: mockFetch });
  assert.equal(out.url, master);
  assert.equal(out.quality, '1080p');
  assert.equal(out.type, 'hls');
  assert.equal(out.ephemeral, true);
  assert.deepEqual(out.subtitles.map(x => x.lang), ['ces', 'ces', 'eng']);
  assert.deepEqual(JSON.parse(calls[0].options.body),
    { filecode: 'dlXPGcileBF2m', device: 'web' });
  assert.equal(calls[1].options.headers.Referer, embed);
});

test('invalid target, oversized API response or non-HLS body fails closed', async () => {
  assert.equal(await resolveVidara('https://evil.test/e/code', { fetchImpl() {
    throw Error('should not fetch');
  } }), null);
  let count = 0;
  const unsafe = async () => {
    count += 1;
    return Response.json({ streaming_url: 'https://evil.test/master.m3u8' });
  };
  assert.equal(await resolveVidara(embed, { fetchImpl: unsafe }), null);
  assert.equal(count, 1);
  const huge = async () => new Response('x'.repeat(131073), { status: 200 });
  assert.equal(await resolveVidara(embed, { fetchImpl: huge }), null);
  const notHls = async url => url.endsWith('/api/stream')
    ? Response.json({ streaming_url: master })
    : new Response('<html>not a playlist</html>', { status: 200 });
  assert.equal(await resolveVidara(embed, { fetchImpl: notHls }), null);
});

test('invalid or repeated subtitles are not exposed as duplicate tracks', () => {
  const tracks = subtitleEntries([
    { lang: 'cs', url: 'https://subs.example/one.vtt' },
    { lang: 'cs', url: 'https://subs.example/one.vtt' },
    { lang: 'en', file: 'http://subs.example/two.vtt' },
    { lang: 'sk', file: 'https://subs.example/three.srt' }
  ]);
  assert.deepEqual(tracks.map(x => x.lang), ['ces', 'slk']);
});

test('existing Bombuj pipeline uses Vidara only when opted in, preserving original embed fallback', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const file = require.resolve('./index.js');
  const local = createRequire(file);
  const sdk = {
    addonBuilder: class {
      defineCatalogHandler() {}
      defineStreamHandler() {}
      getInterface() { return {}; }
    },
    serveHTTP() {}
  };
  for (const enabled of [false, true]) {
    const mod = { exports: {} };
    let calls = 0;
    const testResolver = {
      vidaraEmbed,
      async resolveVidara(url) {
        calls += 1;
        assert.equal(url, embed);
        return { url: master, type: 'hls', quality: '1080p',
          referer: embed, origin: 'https://vidara.to',
          subtitles: [{ id: 'cz', lang: 'ces', url: 'https://subs.example/czech.vtt' }] };
      }
    };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      require: p => p === 'stremio-addon-sdk' ? sdk :
        p === './resolvers/vidara.js' ? testResolver : local(p),
      module: mod, process: { env: enabled ? { BOMBUJ_DIRECT_VIDARA: '1' } : {} },
      console: { log() {}, error() {}, warn() {} },
      URL, URLSearchParams, AbortSignal, Buffer, Uint8Array,
      fetch: () => { throw Error('no internet in integration test'); }
    });
    const found = await mod.exports.playersToStreams([
      { provider: 'Vidara', language: 'EN dab/tit', resolvedUrl: embed }
    ], 'https://www.bombuj.si/online-film-example');
    assert.equal(calls, enabled ? 1 : 0);
    assert.equal(found.length, enabled ? 2 : 1);
    if (enabled) {
      assert.equal(found[0].url, master);
      assert.equal(found[1].externalUrl, embed);
      assert.equal(found[0].subtitles[0].lang, 'ces');
      assert.equal(found[0].behaviorHints.proxyHeaders.request.Origin, 'https://vidara.to');
      assert.equal(found[0].description, 'EN dab/tit • přímý HLS • 1080p');
    } else {
      assert.equal(found[0].externalUrl, embed);
    }
  }
});
