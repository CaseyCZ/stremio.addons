'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { vidlinkId, publicMediaUrl, vidlinkStreams, resolveVidlink } = require('./resolvers/vidlink.js');

const url = size => `https://bcdn.hakunaymatata.com/videos/test-${size}.mp4?token=short`;
const token = 'a+b/c?secret=fixture';
const fixture = () => ({ sourceId: 'mwVault', stream: {
  id: 'primary', type: 'file', TTL: 3600,
  qualities: {
    '360': { url: url(360), type: 'mp4' },
    '480': { url: url(480), type: 'mp4' },
    '1080': { url: url(1080), type: 'mp4' },
    '720': { url: 'https://localhost/video.mp4', type: 'mp4' }
  },
  captions: [
    { id: 'en', language: 'English', url: 'https://cdn.example.org/subs/en.vtt' },
    { id: 'bad', language: 'English', url: 'http://localhost/subs/en.vtt' }
  ]
} });

test('VidLink validates TMDb IDs and HTTPS media URLs', () => {
  assert.equal(vidlinkId('1291595'), '1291595');
  assert.equal(vidlinkId('tt32393988'), null);
  assert(publicMediaUrl(url(360), 'mp4'));
  assert(!publicMediaUrl('http://bcdn.hakunaymatata.com/v.mp4', 'mp4'));
  assert(!publicMediaUrl('https://bcdn.hakunaymatata.com.evil.test/v.mp4', 'mp4'));
  assert(!publicMediaUrl('https://127.0.0.1/v.mp4', 'mp4'));
  assert(!publicMediaUrl('https://bcdn.hakunaymatata.com/e/player', 'mp4'));
});

test('VidLink returns every genuine MP4 quality highest-first and preserves VTT tracks', () => {
  const streams = vidlinkStreams(fixture());
  assert.deepEqual(streams.map(x => x.quality), ['1080p', '480p', '360p']);
  assert.deepEqual(streams.map(x => x.url), [url(1080), url(480), url(360)]);
  assert.equal(streams[0].subtitles.length, 1);
  assert.equal(streams[0].subtitles[0].lang, 'English');
  assert(streams.every(x => !x.externalUrl && x.type === 'mp4'));
});

test('VidLink uses yesterday’s tested token → movie API, never downloads MP4', async () => {
  const calls = [], events = [];
  const streams = await resolveVidlink({ type: 'movie', tmdbId: '1291595' }, {
    fetchImpl: async (actual, options) => {
      calls.push(actual);
      if (calls.length === 1) {
        assert.equal(actual, 'https://enc-dec.app/api/enc-vidlink?text=1291595');
        assert.match(options.headers['User-Agent'], /^Mozilla\/5\.0 /);
        return Response.json({ status: 'success', result: token });
      }
      assert.equal(actual, 'https://vidlink.pro/api/b/movie/' + encodeURIComponent(token));
      assert.equal(options.headers.Origin, 'https://vidlink.pro');
      assert.match(options.headers['User-Agent'], /^Mozilla\/5\.0 /);
      return Response.json(fixture());
    },
    onDiagnostic: event => events.push(event)
  });
  assert.equal(calls.length, 2);
  assert.equal(streams.length, 3);
  assert.equal(streams[0].url, url(1080));
  assert.equal(events.filter(x => x.stage === 'parse' && x.result === 'found').length, 3);
});

test('VidLink fails closed on untested TV routes and HTTP errors', async () => {
  assert.equal(await resolveVidlink({ type: 'series', tmdbId: '1291595', season: 1, episode: 1 }, {
    fetchImpl: () => { throw Error('TV route is not verified'); }
  }), null);
  const events = [];
  const denied = await resolveVidlink({ type: 'movie', tmdbId: '1291595' }, {
    fetchImpl: async () => new Response('blocked', { status: 403 }),
    onDiagnostic: event => events.push(event)
  });
  assert.equal(denied, null);
  assert.equal(events[0].reason, 'http-403');
});
