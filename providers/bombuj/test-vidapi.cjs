'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { vidapiId, vidapiMediaUrl, resolveVidapi } = require('./resolvers/vidapi.js');

const cdn = index => `https://cdn.highperformancebrands.site/${index}/playlist.m3u8?sig=test`;
const currentCdn = index => `https://strategicgrowthpartners.site/${index}/playlist.m3u8?sig=test`;

test('VidAPI accepts public media CDNs without accepting local or malformed URLs', () => {
  assert.equal(vidapiId('tt32393988'), 'tt32393988');
  assert.equal(vidapiId('1291595'), null);
  assert(vidapiMediaUrl(cdn('one')));
  assert(vidapiMediaUrl(currentCdn('one')));
  assert(vidapiMediaUrl('https://cdn.strategicgrowthpartners.site/one/playlist.m3u8'));
  assert(vidapiMediaUrl('https://another-cdn.net/master.m3u8'));
  assert(vidapiMediaUrl('https://cdn.samplemedia.net/movie.mp4'));
  assert(!vidapiMediaUrl('https://strategicgrowthpartners.site.evil.example/master.m3u8'));
  assert(!vidapiMediaUrl('https://strategicgrowthpartners.site@evil.example/master.m3u8'));
  assert(!vidapiMediaUrl('https://highperformancebrands.site.evil.example/master.m3u8'));
  assert(!vidapiMediaUrl('http://cdn.highperformancebrands.site/master.m3u8'));
  assert(!vidapiMediaUrl('https://127.0.0.1/master.m3u8'));
  assert(!vidapiMediaUrl('https://localhost/master.m3u8'));
});

test('VidAPI passes an unrecognized public CDN directly without fetching it on Oracle', async () => {
  const candidate = 'https://cdn.otherplayer.net/2026/master.m3u8?token=test';
  const calls = [];
  const events = [];
  const mockFetch = async (url) => {
    calls.push(url);
    if (!url.includes('/api.php?')) throw Error('unknown CDN must not be probed');
    return Response.json({ status_code: 200, data: { stream_urls: [candidate] } });
  };
  const result = await resolveVidapi({ type: 'movie', imdbId: 'tt27047903' },
    { fetchImpl: mockFetch, onDiagnostic: event => events.push(event) });
  assert.equal(result.url, candidate);
  assert.equal(result.type, 'hls');
  assert.equal(calls.length, 1);
  assert(events.some(event => event.stage === 'media' && event.mediaUrl === candidate));
});

test('VidAPI retains CDN URL when server-side HLS inspection is temporarily unreadable', async () => {
  const mockFetch = async (url) => url.includes('/api.php?')
    ? Response.json({ status_code: 200, data: { stream_urls: [currentCdn('movie')] } })
    : new Response('temporarily blocked', { status: 403 });
  const result = await resolveVidapi({ type: 'movie', imdbId: 'tt27047903' }, { fetchImpl: mockFetch });
  assert.equal(result.url, currentCdn('movie'));
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

test('VidAPI returns every original API candidate, highest known resolution first', async () => {
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
  assert.deepEqual(result.map(x => x.url), [cdn('high'), cdn('medium'), cdn('low')]);
  assert.deepEqual(result.map(x => x.quality), ['800p', '534p', '266p']);
  assert(result.every(x => x.origin === 'https://nextgencloudfabric.com'));
  assert.equal(calls.length, 4);
  assert.match(calls[0].url, /imdb=tt32393988&type=movie/);
});

test('VidAPI returns all distinct unprobed public HLS alternatives unchanged', async () => {
  const sourceUrls = [
    'https://leadgenerationblueprint.site/video/one/master.m3u8?sig=one',
    'https://leadgenerationblueprint.site/video/two/master.m3u8?sig=two',
    'https://leadgenerationblueprint.site/video/three/master.m3u8?sig=three'
  ];
  const events = [], calls = [];
  const result = await resolveVidapi({ type: 'movie', imdbId: 'tt27047903' }, {
    fetchImpl: async url => {
      calls.push(url);
      if (!url.includes('api.php?')) throw Error('Unrecognized CDN must not be fetched');
      return Response.json({ status_code: '200', data: { stream_urls: [...sourceUrls, sourceUrls[0]] } });
    },
    onDiagnostic: event => events.push(event)
  });
  assert.deepEqual(result.map(x => x.url), sourceUrls);
  assert(result.every(x => x.type === 'hls' && x.ephemeral));
  assert.equal(calls.length, 1);
  assert.equal(events.filter(e => e.result === 'direct-unverified').length, 3);
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
    assert.equal(streams.length, enabled ? 1 : 0);
    if (enabled) {
      assert.equal(streams[0].url, cdn('high'));
      assert.equal(streams[0].externalUrl, undefined);
    }
  }
});

test('Bombuj publishes every VidAPI alternative as its exact direct URL', async () => {
  const file = require.resolve('./index.js'), local = createRequire(file);
  const sdk = { addonBuilder: class {
    defineCatalogHandler() {} defineStreamHandler() {} getInterface() { return {}; }
  }, serveHTTP() {} };
  const originalUrls = [cdn('first'), cdn('second'), cdn('third')];
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: p => p === 'stremio-addon-sdk' ? sdk : p === './resolvers/vidapi.js' ? {
      resolveVidapi: async () => originalUrls.map(url => ({ url, type: 'hls', ephemeral: true }))
    } : local(p),
    module: mod, process: { env: { BOMBUJ_DIRECT_VIDAPI: '1' } },
    console: { log() {}, error() {}, warn() {} },
    URL, URLSearchParams, AbortSignal, Buffer, Uint8Array,
    fetch: () => { throw Error('unexpected network'); }
  });
  const streams = await mod.exports.playersToStreams([{ provider: 'vidapi (New)',
    language: 'EN dab/tit', url: 'https://www.bombuj.si/prehravace_final/vidstream.php?iid=tt27047903',
    resolvedUrl: 'https://vaplayer.ru/embed/movie/1291595' }],
  'https://www.bombuj.si/online-film-example', { type: 'movie', imdbId: 'tt27047903' });
  assert.deepEqual(Array.from(streams, x => x.url), originalUrls);
  assert(streams.every(x => !x.externalUrl && x.behaviorHints.notWebReady));
});
