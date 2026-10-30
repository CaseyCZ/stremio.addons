'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHellspyClient } = require('../api/hellspy-experimental');
const { findHellspyStreams, hellspySubtitles, subtitleLanguage, safeFilename } = require('../api/hellspy');

const fileHash = 'aabbccddeeff0011';
const file = (id, title) => ({ objectType: 'GWSearchVideo', id, fileHash, title, size: 3335428645 });

test('HellSpy keeps all 42 valid VTT tracks, including second language variants', () => {
  const languages = ['ara', 'ces', 'eng', 'eng1', 'slk', 'zho', 'zho1', 'zho2',
    ...Array.from({ length: 34 }, (_, index) => 'x' + index)];
  const raw = languages.map((language, index) => ({ id: 1000 + index, language, title: language,
    url: `https://sixseven.onecdn1.net/file.vtt?token=${index}` }));
  const tracks = hellspySubtitles(raw, 30476403);
  assert.equal(tracks.length, 42);
  assert.equal(tracks.find(track => track.label.includes('CES')).lang, 'ces');
  assert.equal(tracks.find(track => track.label.includes('SLK')).lang, 'slk');
  assert.equal(tracks.find(track => track.label.includes('ENG1')).lang, 'eng');
  assert.equal(tracks.find(track => track.label.includes('ZHO2')).lang, 'zho');
  assert.equal(new Set(tracks.map(track => track.id)).size, 42);
  assert.equal(subtitleLanguage('eng1'), 'eng');
  assert.equal(safeFilename('../../upload/movie.mp4'), 'movie.mp4');
});

test('HellSpy ignores invalid subtitle URLs without dropping healthy languages', () => {
  const tracks = hellspySubtitles([
    { id: 1, language: 'ces', url: 'https://cdn.example.org/file.vtt?t=abc' },
    { id: 2, language: 'slk', url: 'http://cdn.example.org/file.vtt' },
    { id: 3, language: 'eng', url: 'https://cdn.example.org/file.srt' },
    { id: 4, language: 'eng', url: 'https://cdn.example.org/file.vtt?t=abc' }
  ], 1);
  assert.deepEqual(tracks.map(track => track.lang), ['ces', 'eng']);
});

test('HellSpy maps matching episodes to direct CDN with all available VTTs', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push([url, options]);
    if (url.includes('/gw/search?')) return { ok: true, status: 200, json: async () => ({ items: [
      file(30476403, 'Ted Lasso S04E01 CZ Titulky chemon'),
      file(30493116, 'Ted Lasso S04E09 CZ Titulky'),
      file(18304361, 'Ted Lasso S03E02 CzTit')
    ] }) };
    if (url.endsWith('/download')) return { status: 302, headers: {
      get: () => 'https://sixseven.onecdn1.net/download?token=test'
    } };
    if (url.endsWith(`/gw/video/30476403/${fileHash}`)) return { ok: true, status: 200, json: async () => ({
      filename: 'Ted Lasso S04E01 CZ Titulky chemon.mp4', conversions: null,
      subtitles: [
        { id: 1, language: 'ces', title: 'ces', url: 'https://sixseven.onecdn1.net/file.vtt?token=cz' },
        { id: 2, language: 'slk', title: 'slk', url: 'https://sixseven.onecdn1.net/file.vtt?token=sk' },
        { id: 3, language: 'eng1', title: 'eng1', url: 'https://sixseven.onecdn1.net/file.vtt?token=en' }
      ]
    }) };
    throw Error('Unexpected request: ' + url);
  };
  const api = createHellspyClient({ fetchImpl });
  const streams = await findHellspyStreams({
    meta: { name: 'Ted Lasso' }, type: 'series', season: 4, episode: 1
  }, { api });
  assert.equal(streams.length, 1);
  assert.match(streams[0].url, /^https:\/\/sixseven\.onecdn1\.net\/download\?/);
  assert.equal(streams[0].subtitles.length, 3);
  assert.deepEqual(streams[0].subtitles.map(track => track.lang), ['ces', 'slk', 'eng']);
  assert.equal(streams[0].behaviorHints.filename, 'Ted Lasso S04E01 CZ Titulky chemon.mp4');
  assert.equal(requests.length, 3);
  assert.ok(requests.every(([, opts]) => opts.method === 'GET'));
  assert.ok(requests.some(([url, opts]) => url.endsWith('/download') && opts.redirect === 'manual'));
  assert.ok(requests.every(([url]) => url.startsWith('https://api.hellspy.to/gw/')));
});

test('HellSpy HTTP 429 cannot return phantom streams or retry endlessly', async () => {
  let requests = 0;
  const api = createHellspyClient({ fetchImpl: async () => {
    requests++;
    return { ok: false, status: 429 };
  } });
  const input = { meta: { name: 'Avatar', year: '2009' }, type: 'movie' };
  await assert.rejects(findHellspyStreams(input, { api }), /429/);
  await assert.rejects(findHellspyStreams(input, { api }), /rate limited/);
  assert.equal(requests, 1);
});


test('HellSpy follows Streamlet-style search/link using only bounded alternate title queries', async () => {
  const { hellspySearchVariants } = require('../api/hellspy');
  assert.deepEqual(hellspySearchVariants(['Český název', 'Original Title'], 'movie', '2026'),
    ['Český název 2026', 'Český název', 'Original Title 2026']);
  assert.deepEqual(hellspySearchVariants(['Ted Lasso'], 'series', '', 4, 1),
    ['Ted Lasso S04E01', 'Ted Lasso S4E1']);

  const queries = [];
  const api = {
    search: async ({ query }) => {
      queries.push(query);
      return query === 'Original Title 2026'
        ? [{ id: 4, title: 'Original Title 2026 1080p', fileHash }] : [];
    },
    resolveOriginal: async () => 'https://cdn.example.org/video.mp4',
    getVideoDetails: async () => ({ subtitles: [] })
  };
  const streams = await findHellspyStreams({
    meta: { name: 'Český název', originalName: 'Original Title', year: '2026' },
    type: 'movie'
  }, { api });
  assert.deepEqual(queries, ['Český název 2026', 'Český název', 'Original Title 2026']);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://cdn.example.org/video.mp4');
});

test('HellSpy alternate queries never bypass a server HTTP 429 response', async () => {
  let attempts = 0;
  await assert.rejects(findHellspyStreams({
    meta: { name: 'Český název', originalName: 'Original Title', year: 2026 }, type: 'movie'
  }, { api: { search: async () => { attempts++; throw Error('HTTP 429'); } } }), /429/);
  assert.equal(attempts, 1);
});
