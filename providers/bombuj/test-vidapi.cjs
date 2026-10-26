'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { vidapiId, vidapiMediaUrl, resolveVidapi } = require('./resolvers/vidapi.js');

const cdn = index => `https://cdn.highperformancebrands.site/${index}/playlist.m3u8?sig=test`;
const currentCdn = index => `https://strategicgrowthpartners.site/${index}/playlist.m3u8?sig=test`;

test('VidAPI ID and CDN URL are restricted to verified movie format', () => {
  assert.equal(vidapiId('tt32393988'), 'tt32393988');
  assert.equal(vidapiId('1291595'), null);
  assert(vidapiMediaUrl(cdn('one')));
  assert(vidapiMediaUrl(currentCdn('one')));
  assert(!vidapiMediaUrl('https://cdn.strategicgrowthpartners.site/one/playlist.m3u8'));
  assert(!vidapiMediaUrl('https://strategicgrowthpartners.site.evil.example/master.m3u8'));
  assert(!vidapiMediaUrl('https://strategicgrowthpartners.site@evil.example/master.m3u8'));
  assert(!vidapiMediaUrl('https://highperformancebrands.site.evil.example/master.m3u8'));
  assert(!vidapiMediaUrl('http://cdn.highperformancebrands.site/master.m3u8'));
  assert(!vidapiMediaUrl('https://127.0.0.1/master.m3u8'));
});

test('VidAPI accepts current API CDN after validating the HLS manifest', async () => {
  const apiCalls = [];
  const mockFetch = async (url) => {
    apiCalls.push(url);
    if (url.includes('/api.php?')) return Response.json({ status_code: '200',
      data: { stream_urls: [currentCdn('movie')] } });
    return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1920x1080\nchunk.m3u8\n');
  };
  const stream = await resolveVidapi({ type: 'movie', imdbId: 'tt0468569' }, { fetchImpl: mockFetch });
  assert.equal(stream.url, currentCdn('movie'));
  assert.equal(stream.quality, '1080p');
  assert.equal(apiCalls.length, 2);
});

test('VidAPI resolves all API candidates and prefers highest actual HLS resolution', async () => {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({ url, headers: options?.headers });
    if (url.includes('/api.php?')) {
      return Response.json({ status_code: 200,
        data: { stream_urls: [cdn('low'), cdn('high'), cdn('medium')] } });
    }
    const height = url.includes('/high/') ? 800 : url.includes('/medium/') ? 534 : 266;
    return new Response(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1920x${height}\nmedia.m3u8\n`);
  };
  const result = await resolveVidapi({ type: 'movie', imdbId: 'tt32393988' }, { fetchImpl: mockFetch });
  assert.equal(result.url, cdn('high'));
  assert.equal(result.quality, '800p');
  assert.equal(result.origin, 'https://nextgencloudfabric.com');
  assert.equal(calls.length, 4);
  assert.match(calls[0].url, /imdb=tt32393988&type=movie/);
});

test('unverified movie ID, invalid JSON or poisoned URLs safely fall back', async () => {
  let calls = 0;
  const mockFetch = async () => { calls++; return Response.json({ status_code: 200, data: {
    stream_urls: ['https://localhost/private.m3u8']
  } }); };
  assert.equal(await resolveVidapi({ type: 'movie', imdbId: '' }, { fetchImpl: mockFetch }), null);
  assert.equal(await resolveVidapi({ type: 'series', imdbId: 'tt32393988' }, { fetchImpl: mockFetch }), null);
  assert.equal(calls, 0);
  assert.equal(await resolveVidapi({ type: 'movie', imdbId: 'tt32393988' }, { fetchImpl: mockFetch }), null);
  assert.equal(calls, 1);
});

test('existing Bombuj VidAPI wrapper uses direct only with explicit test switch', async () => {
  const file = require.resolve('./index.js'), local = createRequire(file);
  const sdk = { addonBuilder: class {
    defineCatalogHandler() {} defineStreamHandler() {} getInterface() { return {}; }
  }, serveHTTP() {} };
  const raw = 'https://www.bombuj.si/prehravace_final/vidstream.php?iid=tt32393988';
  for (const enabled of [false, true]) {
    const mod = { exports: {} };
    let directCalls = 0;
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      require: p => p === 'stremio-addon-sdk' ? sdk : p === './resolvers/vidapi.js' ? {
        resolveVidapi: async context => {
          directCalls++;
          assert.equal(context.imdbId, 'tt32393988');
          return { url: cdn('high'), type: 'hls', referer: 'https://nextgencloudfabric.com/', ephemeral: true };
        }
      } : local(p),
      module: mod, process: { env: enabled ? { BOMBUJ_DIRECT_VIDAPI: '1' } : {} },
      console: { log() {}, error() {}, warn() {} },
      URL, URLSearchParams, AbortSignal, Buffer, Uint8Array,
      fetch: () => { throw Error('no network expected'); }
    });
    const streams = await mod.exports.playersToStreams([
      { url: raw, provider: 'vidapi (New)', language: 'EN dab/tit',
        resolvedUrl: 'https://vaplayer.ru/embed/movie/1291595' }
    ], 'https://www.bombuj.si/online-film-example', { type: 'movie' });
    assert.equal(directCalls, enabled ? 1 : 0);
    assert.equal(streams.length, enabled ? 2 : 1);
    assert.equal(enabled ? streams[0].url : streams[0].externalUrl,
      enabled ? cdn('high') : 'https://vaplayer.ru/embed/movie/1291595');
    if (enabled) assert.equal(streams[1].externalUrl, 'https://vaplayer.ru/embed/movie/1291595');
  }
});
