'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { byseEmbedId } = require('./resolvers/byse.js');

test('Bombuj resolves BYSE and all VidLink MP4 qualities without mutating source player URLs', async () => {
  const path = require.resolve('./index.js');
  const local = createRequire(path);
  const messages = [], calls = [];
  const mod = { exports: {} };
  const sdk = { addonBuilder: class {
    defineCatalogHandler() {} defineStreamHandler() {} getInterface() { return {}; }
  }, serveHTTP() {} };
  vm.runInNewContext(fs.readFileSync(path, 'utf8'), {
    require: specifier => {
      if (specifier === 'stremio-addon-sdk') return sdk;
      if (specifier === './resolvers/byse.js') return {
        byseEmbedId,
        resolveByse: async embed => {
          calls.push(embed);
          return { url: 'https://edge1-frankfurt-sprintcdn.owphbf24.com/test/master.m3u8',
            type: 'hls', quality: '1080p', referer: 'https://n1mwq.org/' };
        }
      };
      if (specifier === './resolvers/vidlink.js') return {
        resolveVidlink: async context => {
          assert.equal(context.tmdbId, '1291595');
          return ['1080', '480', '360'].map(label => ({
            url: `https://bcdn.hakunaymatata.com/test-${label}.mp4`,
            type: 'mp4', quality: `${label}p`, subtitles: [{ lang: 'en', url: 'https://cdn.example.org/en.vtt' }]
          }));
        }
      };
      return local(specifier);
    },
    module: mod,
    process: { env: { BOMBUJ_DIRECT_BYSE: '1', BOMBUJ_DIRECT_VIDLINK: '1',
      BOMBUJ_RESOLVER_LOG_URLS: '1' } },
    console: { log: line => messages.push(line), error() {}, warn() {} },
    URL, URLSearchParams, AbortSignal, Buffer, Uint8Array,
    fetch: () => { throw Error('unexpected fetch'); }
  });

  const players = [
    { provider: 'byse.sx', language: 'CZ dabing',
      resolvedUrl: 'https://bysekoze.com/e/3sdq9djzqcqe/' },
    { provider: 'vidlink', language: 'EN dab/tit',
      url: 'https://www.bombuj.si/prehravace_final/vidlink.php?iid=1291595',
      resolvedUrl: 'https://vidlink.pro/movie/1291595?sub_file=https%3A%2F%2Fcdn.example.org%2Fcz.vtt&sub_label=CZSK' }
  ];
  const originals = JSON.parse(JSON.stringify(players));
  const streams = await mod.exports.playersToStreams(players,
    'https://www.bombuj.si/online-film-insidious', { type: 'movie' });
  assert.deepEqual(players, originals);
  assert.equal(calls.length, 1);
  assert.equal(streams.length, 4);
  assert(streams.every(stream => Boolean(stream.url) && !('externalUrl' in stream)));
  assert.equal(streams[0].url, 'https://edge1-frankfurt-sprintcdn.owphbf24.com/test/master.m3u8');
  assert.deepEqual(Array.from(streams.slice(1), stream => stream.url), ['1080', '480', '360']
    .map(label => `https://bcdn.hakunaymatata.com/test-${label}.mp4`));
  assert.equal(new Set(Array.from(streams, stream => stream.behaviorHints.filename)).size, 4);
  assert.match(streams[0].description, /CZ dabing/);
  assert(streams.slice(1).every(stream => stream.description.includes('EN dab/tit')));
  assert.equal(streams[0].behaviorHints.notWebReady, true);
  assert(streams[0].behaviorHints.proxyHeaders);
  assert(streams.slice(1).every(stream => stream.description.includes('WEB TEST')));
  assert(streams.slice(1).every(stream => !('notWebReady' in stream.behaviorHints)));
  assert(streams.slice(1).every(stream => !('proxyHeaders' in stream.behaviorHints)));
  assert(streams.slice(1).every(stream => stream.subtitles.some(sub => sub.url.endsWith('/cz.vtt'))));

  const logs = messages.filter(line => line.startsWith('[BOMBUJ RESOLVER] '))
    .map(line => JSON.parse(line.slice('[BOMBUJ RESOLVER] '.length)));
  const handoffs = logs.filter(entry => entry.handedToStremio);
  assert.equal(handoffs.length, 4);
  assert.deepEqual(handoffs.map(entry => entry.handedToStremio), Array.from(streams, stream => stream.url));
  assert.equal(handoffs[0].playerUrl, players[0].resolvedUrl);
  assert.equal(handoffs[1].playerUrl, players[1].resolvedUrl);
});
