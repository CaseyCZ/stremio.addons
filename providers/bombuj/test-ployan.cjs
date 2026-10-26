'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const {
  verifiedContext, selectSearchItem, makeToken, decryptInfo,
  subtitleIndexUrl, resolvePrimewireViaPloyan
} = require('./resolvers/ployan.js');

function encrypt(plain) {
  const salt = Buffer.alloc(8, 7), iv = Buffer.alloc(12, 9);
  const key = crypto.pbkdf2Sync('player', salt, 1000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const cipherText = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return [salt, iv, cipherText].map(x => x.toString('hex')).join('-');
}

test('only unambiguous exact title and release year or precise season can resolve', () => {
  const insidious = { type: 'movie', title: 'Insidious', year: 2011 };
  const items = [
    { t: 'Insidious: Chapter 2', y: 2013, d: 'm', s: 'insidious-chapter-2-2342' },
    { t: 'Insidious', y: 2011, d: 'm', s: 'insidious-2963' }
  ];
  assert.equal(selectSearchItem(items, insidious)?.id, '2963');
  assert.equal(selectSearchItem(items, { ...insidious, year: 2010 }), null);
  assert.equal(selectSearchItem([...items, items[1]], insidious), null);
  assert.equal(verifiedContext({ type: 'movie', title: 'Insidious' }), null);
  assert.equal(selectSearchItem([
    { t: 'Eternally Yours Season 1', d: 's', n: 1, s: 'eternally-yours-season-1-2761' }
  ], { type: 'series', title: 'Eternally Yours', season: 1, episode: 2 })?.id, '2761');
});

test('request token and AES-GCM embed match tested Ployan format', () => {
  const token = makeToken('2761', 2, 3, 1792961006000, count => Buffer.alloc(count, 1));
  assert.equal(decryptInfo(token), '2761+2+3+1792961006');
  assert.equal(decryptInfo(encrypt('https://vidara.to/e/dlXPGcileBF2m-1792961190')),
    'https://vidara.to/e/dlXPGcileBF2m-1792961190');
  assert.equal(decryptInfo('invalid'), null);
  assert.equal(subtitleIndexUrl('2963', 1), 'https://ployan.me/sub/212a25203e22/index.json');
});

test('Primewire film can resolve Ployan direct HLS with all indexed VTT tracks', async () => {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push(url);
    if (url.includes('/searching?')) {
      return Response.json({ data: [{ t: 'Insidious', y: 2011, d: 'm', s: 'insidious-2963' }] });
    }
    if (url.includes('/get/')) {
      assert.equal(decryptInfo(url.split('/get/')[1]).split('+')[2], '1');
      return Response.json({ code: 200, mode: 'direct', info: 'abcdef123' });
    }
    if (url.endsWith('/master.m3u8')) {
      return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2600000,RESOLUTION=1920x1080\n1080.m3u8\n');
    }
    if (url.includes('/sub/')) {
      return Response.json([
        { lang: 'cs', file: '/sub/212a25203e22/cz.vtt' },
        { lang: 'cs', file: '/sub/212a25203e22/cz2.vtt' },
        { lang: 'en', file: '/sub/212a25203e22/en.vtt' }
      ]);
    }
    throw Error('unexpected URL: ' + url);
  };
  const direct = await resolvePrimewireViaPloyan(
    { type: 'movie', title: 'Insidious', year: 2011 }, { fetchImpl: mockFetch });
  assert.equal(direct.type, 'hls');
  assert.equal(direct.quality, '1080p');
  assert.equal(direct.url, 'https://ployan.me/hls/abcdef123/master.m3u8');
  assert.deepEqual(direct.subtitles.map(s => s.lang), ['ces', 'ces', 'eng']);
  assert.equal(direct.ephemeral, true);
  assert.equal(calls.filter(url => url.includes('/get/')).length, 1);
});

test('server 1 failure falls back to server 3 Vidara for exact series episode', async () => {
  const seen = [];
  const mockFetch = async url => {
    seen.push(url);
    if (url.includes('/searching?')) return Response.json({
      data: [{ t: 'Eternally Yours Season 1', d: 's', n: 1, s: 'eternally-yours-season-1-2761' }]
    });
    if (url.includes('/get/')) {
      const [, episode, server] = decryptInfo(url.split('/get/')[1]).split('+');
      assert.equal(episode, '2');
      return server === '1' ? new Response('error', { status: 502 }) : Response.json({
        code: 200, mode: 'embed',
        info: encrypt('https://vidara.to/e/sacZDHAG2rQp9-1792961190')
      });
    }
    if (url.includes('/sub/')) return Response.json([]);
    throw Error('unexpected URL');
  };
  const out = await resolvePrimewireViaPloyan({
    type: 'series', title: 'Eternally Yours', season: 1, episode: 2
  }, { fetchImpl: mockFetch, vidaraResolver: async embed => {
    assert.equal(embed, 'https://vidara.to/e/sacZDHAG2rQp9-1792961190');
    return { url: 'https://s7-s501740.s1q2105.com/hls/test/master.m3u8', type: 'hls' };
  } });
  assert.match(out.url, /s1q2105/);
  assert.equal(seen.filter(url => url.includes('/get/')).length, 2);
  assert.equal(out.subtitles.length, 0);
});

test('unmatched or malformed metadata performs no speculative video fetch', async () => {
  let count = 0;
  const mockFetch = async () => { count++; return Response.json({ data: [] }); };
  assert.equal(await resolvePrimewireViaPloyan({ type: 'movie', title: 'Unknown' },
    { fetchImpl: mockFetch }), null);
  assert.equal(count, 0);
  assert.equal(await resolvePrimewireViaPloyan({ type: 'movie', title: 'Insidious', year: 2011 },
    { fetchImpl: mockFetch }), null);
  assert.equal(count, 1);
});

test('existing Bombuj Primewire player is not altered until test flag enabled', async () => {
  const file = require.resolve('./index.js'), local = createRequire(file);
  const sdk = { addonBuilder: class {
    defineCatalogHandler() {} defineStreamHandler() {} getInterface() { return {}; }
  }, serveHTTP() {} };
  const embed = 'https://primewire.pw/embed/movie?tmdb=1291595';
  for (const enabled of [false, true]) {
    let called = 0;
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      require: p => p === 'stremio-addon-sdk' ? sdk : p === './resolvers/ployan.js' ? {
        resolvePrimewireViaPloyan: async context => {
          called++;
          assert.equal(context.title, 'Insidious');
          return { url: 'https://ployan.me/hls/test/master.m3u8', type: 'hls',
            referer: 'https://ployan.me/watch/', subtitles: [], ephemeral: true };
        }
      } : local(p),
      module: mod, process: { env: enabled ? { BOMBUJ_DIRECT_PLOYAN: '1' } : {} },
      console: { log() {}, error() {}, warn() {} },
      URL, URLSearchParams, AbortSignal, Buffer, Uint8Array,
      fetch: () => { throw Error('no network expected'); }
    });
    const streams = await mod.exports.playersToStreams([
      { provider: 'primewire', language: 'EN dab/tit', resolvedUrl: embed }
    ], 'https://www.bombuj.si/online-film-example',
    { type: 'movie', title: 'Insidious', year: 2011 });
    assert.equal(called, enabled ? 1 : 0);
    assert.equal(streams.length, enabled ? 1 : 0);
    if (enabled) {
      assert.equal(streams[0].url, 'https://ployan.me/hls/test/master.m3u8');
      assert.match(streams[0].description, /EN dab\/tit/);
      assert.equal(streams[0].externalUrl, undefined);
    }
  }
});
