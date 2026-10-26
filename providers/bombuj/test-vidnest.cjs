'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { vidnestId, vidnestMediaUrl, decodeAlphabet, resolveVidnest } = require('./resolvers/vidnest.js');

const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const alphabet = 'RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/=';
const encode = data => Buffer.from(JSON.stringify(data)).toString('base64')
  .replace(/[A-Za-z0-9+/=]/g, char => alphabet[base64.indexOf(char)]);
const cdn = 'https://pwcloud.animanga.fun/hls/test/master.m3u8';

test('VidNest decodes the tested custom alphabet and accepts only trusted HLS host', () => {
  const data = { sources: [{ url: cdn }] };
  assert.deepEqual(decodeAlphabet(encode(data)), data);
  assert.equal(decodeAlphabet('not-an-encoded-playlist'), null);
  assert.equal(vidnestId('1291595'), '1291595');
  assert.equal(vidnestId('tt32393988'), null);
  assert(vidnestMediaUrl(cdn));
  assert(!vidnestMediaUrl('https://pwcloud.animanga.fun.evil.example/master.m3u8'));
  assert(!vidnestMediaUrl('http://pwcloud.animanga.fun/master.m3u8'));
  assert(!vidnestMediaUrl('https://localhost:1234/master.m3u8'));
});

test('VidNest resolves exact movie ID and series episode without a video proxy', async () => {
  const paths = [];
  const mockFetch = async url => {
    paths.push(url);
    if (url.startsWith('https://new.vidnest.fun/')) return Response.json({
      encrypted: true, data: encode({ sources: [{ url: cdn }] })
    });
    if (url === cdn) return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1920x1080\nindex-f2-v1-a1.m3u8\n');
    throw Error('unexpected fetch');
  };
  const movie = await resolveVidnest({ type: 'movie', tmdbId: '1291595' }, { fetchImpl: mockFetch });
  assert.equal(movie.url, cdn);
  assert.equal(movie.quality, '1080p');
  assert(movie.ephemeral);
  assert(paths.some(path => path.endsWith('/moviesapi/movie/1291595')));

  paths.length = 0;
  const tv = await resolveVidnest({ type: 'series', tmdbId: '1291595', season: 1, episode: 3 }, { fetchImpl: mockFetch });
  assert.equal(tv.url, cdn);
  assert(paths.some(path => path.endsWith('/moviesapi/tv/1291595/1/3')));

  paths.length = 0;
  const videasy = await resolveVidnest({ type: 'movie', tmdbId: '1291595' },
    { fetchImpl: mockFetch, backends: ['videasy'] });
  assert.equal(videasy.url, cdn);
  assert(paths.some(path => path.endsWith('/videasy/movie/1291595')));
  assert(!paths.some(path => path.includes('/moviesapi/')));
});

test('VidNest rejects unknown identifiers, untrusted results and malformed episodes', async () => {
  let count = 0;
  const mockFetch = async () => {
    count++;
    return Response.json({ encrypted: false, sources: [{ url: 'https://localhost:8443/evil.m3u8' }] });
  };
  assert.equal(await resolveVidnest({ type: 'movie', tmdbId: 'tt32393988' }, { fetchImpl: mockFetch }), null);
  assert.equal(await resolveVidnest({ type: 'series', tmdbId: '123', season: -1, episode: 0 }, { fetchImpl: mockFetch }), null);
  assert.equal(count, 0);
  assert.equal(await resolveVidnest({ type: 'movie', tmdbId: '1291595' }, { fetchImpl: mockFetch }), null);
  assert.equal(count, 4);
});

test('Bombuj VidNest wrapper never publishes a web player', async () => {
  const file = require.resolve('./index.js'), local = createRequire(file);
  const sdk = { addonBuilder: class {
    defineCatalogHandler() {} defineStreamHandler() {} getInterface() { return {}; }
  }, serveHTTP() {} };
  const original = 'https://www.bombuj.si/prehravace_final/vidnest.php?iid=1291595';
  const embed = 'https://vidnest.fun/movie/1291595';
  for (const enabled of [false, true]) {
    let called = 0;
    const mod = { exports: {} };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      require: p => p === 'stremio-addon-sdk' ? sdk : p === './resolvers/vidnest.js' ? {
        vidnestId, resolveVidnest: async context => {
          called++;
          assert.equal(context.tmdbId, '1291595');
          return { url: cdn, type: 'hls', quality: '1080p', ephemeral: true };
        }
      } : local(p),
      module: mod, process: { env: enabled ? { BOMBUJ_DIRECT_VIDNEST: '1' } : {} },
      console: { log() {}, warn() {}, error() {} },
      URL, URLSearchParams, AbortSignal, Buffer, Uint8Array,
      fetch: () => { throw Error('no network expected'); }
    });
    const streams = await mod.exports.playersToStreams([
      { url: original, resolvedUrl: embed, provider: 'vidnest (New)', language: 'EN dab/tit' }
    ], 'https://www.bombuj.si/online-film-example', { type: 'movie' });
    assert.equal(called, enabled ? 1 : 0);
    assert.equal(streams.length, enabled ? 1 : 0);
    if (enabled) {
      assert.equal(streams[0].url, cdn);
      assert.equal(streams[0].externalUrl, undefined);
    }
  }
});

test('Bombuj VidLink and Videasy may use exact-ID VidNest backend in isolation', async () => {
  const file = require.resolve('./index.js'), local = createRequire(file);
  const sdk = { addonBuilder: class {
    defineCatalogHandler() {} defineStreamHandler() {} getInterface() { return {}; }
  }, serveHTTP() {} };
  for (const source of ['vidlink', 'videasy']) {
    const mod = { exports: {} };
    let seen = 0;
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      require: p => p === 'stremio-addon-sdk' ? sdk : p === './resolvers/vidnest.js' ? {
        vidnestId, resolveVidnest: async (context, options) => {
          seen++;
          assert.equal(context.tmdbId, '1291595');
          assert.equal(options.backends[0], source);
          return { url: cdn, type: 'hls', ephemeral: true };
        }
      } : local(p),
      module: mod, process: { env: { [`BOMBUJ_DIRECT_${source.toUpperCase()}`]: '1' } },
      console: { log() {}, warn() {}, error() {} },
      URL, URLSearchParams, AbortSignal, Buffer, Uint8Array,
      fetch: () => { throw Error('no network expected'); }
    });
    const streams = await mod.exports.playersToStreams([{
      provider: source, language: 'EN dab/tit',
      url: `https://www.bombuj.si/prehravace_final/${source}.php?iid=1291595`,
      resolvedUrl: `https://${source === 'vidlink' ? 'vidlink.pro' : 'player.videasy.net'}/movie/1291595`
    }], 'https://www.bombuj.si/online-film-example', { type: 'movie' });
    assert.equal(seen, 1);
    assert.equal(streams.length, 1);
    assert.equal(streams[0].url, cdn);
    assert.equal(streams[0].externalUrl, undefined);
  }
});
