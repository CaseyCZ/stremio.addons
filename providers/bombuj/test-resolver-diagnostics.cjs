'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { resolveVidnest } = require('./resolvers/vidnest.js');
const { resolveStreamtape } = require('./resolvers/streamtape.js');
const { resolveVidapi } = require('./resolvers/vidapi.js');

test('VidNest logs the exact failing API request and HTTP code', async () => {
  const events = [];
  const url = 'https://new.vidnest.fun/moviesapi/movie/155';
  const result = await resolveVidnest({ type: 'movie', tmdbId: '155' }, {
    backends: ['moviesapi'],
    fetchImpl: async actual => {
      assert.equal(actual, url);
      return new Response('forbidden', { status: 403 });
    },
    onDiagnostic: event => events.push(event)
  });
  assert.equal(result, null);
  assert.deepEqual(events, [{ stage: 'api', backend: 'moviesapi', result: 'failed',
    reason: 'http-403', requestUrl: url }]);
});

test('Streamtape and VidAPI log exact requested URLs on HTTP failure', async () => {
  const streamtape = [];
  assert.equal(await resolveStreamtape('https://streamtape.com/e/jrw77oXa8zUzAV4', {
    fetchImpl: async () => new Response('blocked', { status: 403 }),
    onDiagnostic: event => streamtape.push(event)
  }), null);
  assert.equal(streamtape[0].reason, 'http-403');
  assert.equal(streamtape[0].requestUrl, 'https://streamtape.com/v/jrw77oXa8zUzAV4');

  const vidapi = [];
  assert.equal(await resolveVidapi({ type: 'movie', imdbId: 'tt0468569' }, {
    fetchImpl: async () => new Response('blocked', { status: 403 }),
    onDiagnostic: event => vidapi.push(event)
  }), null);
  assert.equal(vidapi[0].reason, 'http-403');
  assert.equal(vidapi[0].requestUrl,
    'https://streamdata.vaplayer.ru/api.php?imdb=tt0468569&type=movie');
});

test('private Bombuj log includes exact player, attempted, and handed-off media URLs', async () => {
  const file = require.resolve('./index.js');
  const local = createRequire(file);
  const sdk = { addonBuilder: class {
    defineCatalogHandler() {} defineStreamHandler() {} getInterface() { return {}; }
  }, serveHTTP() {} };
  for (const enabled of [true, false]) {
    const messages = [], mod = { exports: {} };
    const embed = 'https://mixdrop.ag/e/fixture?directsub=test';
    const direct = 'https://mxcontent.net/movie.mp4?token=temporary123';
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      require: p => p === 'stremio-addon-sdk' ? sdk : local(p), module: mod,
      process: { env: { BOMBUJ_SHOW_ALL_SOURCES: '1',
        ...(enabled ? { BOMBUJ_RESOLVER_LOG_URLS: '1' } : {}) } },
      console: { log: value => messages.push(String(value)), error() {}, warn() {} },
      URL, URLSearchParams, AbortSignal, Buffer, Uint8Array,
      fetch: async () => new Response(`<script>MDCore.wurl="${direct}"</script>`)
    });
    const streams = await mod.exports.playersToStreams([
      { provider: 'Mixdrop', language: 'CZ dabing', resolvedUrl: embed }
    ], 'https://www.bombuj.si/online-film-fixture');
    assert.equal(streams[0].url, direct);
    assert.equal(streams[1].externalUrl, embed);
    const entries = messages.filter(line => line.startsWith('[BOMBUJ RESOLVER] '))
      .map(line => JSON.parse(line.replace('[BOMBUJ RESOLVER] ', '')));
    const parse = entries.find(item => item.stage === 'parse');
    const handed = entries.find(item => item.stage === 'result' && item.result === 'direct');
    assert.equal(parse.result, 'found');
    assert.equal(handed.result, 'direct');
    assert.equal(parse.requestId, handed.requestId);
    if (enabled) {
      assert.equal(parse.playerUrl, embed);
      assert.equal(parse.requestUrl, embed);
      assert.equal(parse.mediaUrl, direct);
      assert.equal(handed.handedToStremio, direct);
    } else {
      assert(!('playerUrl' in parse));
      assert(!('requestUrl' in parse));
      assert(!('mediaUrl' in parse));
      assert(!('handedToStremio' in handed));
      assert(!messages.join('').includes('temporary123'));
    }
  }
});
