'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSledujtetoClient, findSledujtetoStreams, matchingScore,
  providerUrl, subtitlesFromVideo } = require('../api/sledujteto');

const cfg = { sledujtetoEmail: 'test@example.invalid', sledujtetoPassword: 'not-a-real-password' };
const file = (id, name, video = {}) => ({ id, name, video });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status,
  json: async () => ({ data }) });

test('Sledujteto finds the intended movie but rejects unrelated fuzzy matches and wrong years', async () => {
  const requests = [];
  const client = createSledujtetoClient({ fetchImpl: async (url, options) => {
    requests.push([url, options]);
    if (url.endsWith('/v1/token')) return response({ token: 'private-bearer-token' });
    if (url.includes('/v1/videos?')) return response({ total: 4, results: [
      file(107838, 'Mayday 2026 CZ titulky HD', { is_hd: true, subtitles: [
        { language: 'cze', title: 'CZ', url: 'https://www.sledujteto.cz/subtitles/1.vtt' },
        { language: 'eng', title: 'EN', url: 'https://www.sledujteto.cz/subtitles/2.vtt' }
      ] }),
      file(59714, 'Plane 2023 CZ dabing HD'),
      file(7400, 'Definice lasky 2012 CZ Mayday'),
      file(77, 'Mayday 2025 CZ titulky HD')
    ] });
    if (url.endsWith('/v1/video/107838/link')) return response({ link: 'https://data11.sledujteto.com/video/abcdef?token=secret' });
    throw Error('Unexpected request: ' + url);
  } });
  const streams = await findSledujtetoStreams({ cfg, meta: { name: 'Mayday', year: '2026' }, type: 'movie' }, { api: client });
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, 'https://data11.sledujteto.com/video/abcdef?token=secret');
  assert.equal(streams[0].name, 'Sledujteto • HD');
  assert.equal(streams[0].subtitles.length, 2);
  assert.ok(streams[0].behaviorHints.filename.endsWith('.mp4'));
  assert.equal(requests.length, 3);
  assert.ok(requests.every(([url]) => url.startsWith('https://www.sledujteto.com/api/')));
  assert.equal(requests[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(requests[0][1].body), { email: cfg.sledujtetoEmail, password: cfg.sledujtetoPassword });
  assert.equal(requests[1][1].headers.Authorization, 'Bearer private-bearer-token');
  assert.equal(requests[2][1].headers.Authorization, 'Bearer private-bearer-token');
  // No redirect, HEAD, Range GET or media proxy calls on the addon server.
  assert.ok(requests.slice(1).every(([, options]) => options.method === 'GET'));
});

test('Sledujteto requires a matching episode and refuses episode packs', async () => {
  const client = createSledujtetoClient({ fetchImpl: async (url) => {
    if (url.endsWith('/v1/token')) return response({ token: 'token' });
    if (url.includes('/v1/videos?')) return response({ total: 5, results: [
      file(1, 'Ted Lasso S04E01 Home CZ'),
      file(2, 'Ted Lasso S04E09 CZ'),
      file(3, 'Other Ted Lasso S04E01 CZ'),
      file(4, 'Ted Lasso S04E01-03 collection'),
      file(5, 'Ted Lasso S03E01 CZ')
    ] });
    if (url.endsWith('/v1/video/1/link')) return response({ link: 'https://data11.sledujteto.com/watch?id=1' });
    throw Error('Unexpected request: ' + url);
  } });
  const streams = await findSledujtetoStreams({ cfg, meta: { name: 'Ted Lasso' }, type: 'series', season: 4, episode: 1 }, { api: client });
  assert.equal(streams.length, 1);
  assert.match(streams[0].title, /Ted Lasso S04E01/);
  assert.equal(matchingScore('Ted Lasso S04E02', ['Ted Lasso'], 'series', '', 4, 1), 0);
  assert.equal(matchingScore('Ted Lasso S04E01-03', ['Ted Lasso'], 'series', '', 4, 1), 0);
});

test('Sledujteto rejects unsafe CDN URLs and retains every direct VTT variant', () => {
  assert.equal(providerUrl('https://data11.sledujteto.com/player/abc?token=123'),
    'https://data11.sledujteto.com/player/abc?token=123');
  for (const url of ['http://data11.sledujteto.com/video', 'https://sledujteto.com.evil.test/video',
    'https://localhost/video', 'https://user:pass@data11.sledujteto.com/video']) {
    assert.equal(providerUrl(url), null);
  }
  const subtitleList = subtitlesFromVideo({ subtitles: [
    { language: 'cze', title: 'CZ', url: 'https://sub.example.org/1.vtt' },
    { language: 'cze', title: 'CZ HD', url: 'https://sub.example.org/2.vtt?token=abc' },
    { language: 'eng', title: 'English', url: 'https://sub.example.org/3.vtt' },
    { language: 'slo', title: 'SK', url: 'https://sub.example.org/4.srt' },
    { language: 'eng', title: 'bad', url: 'http://sub.example.org/5.vtt' }
  ] }, 1);
  assert.deepEqual(subtitleList.map(track => track.lang), ['ces', 'ces', 'eng']);
  assert.equal(new Set(subtitleList.map(track => track.id)).size, 3);
});

test('Sledujteto does not share account tokens or cache signed media links', async () => {
  const requests = [];
  const client = createSledujtetoClient({ fetchImpl: async (url, options) => {
    requests.push([url, options]);
    if (url.endsWith('/v1/token')) return response({ token: JSON.parse(options.body).email });
    if (url.includes('/v1/videos?')) return response({ results: [file(10, 'Mayday 2026 CZ')] });
    if (url.endsWith('/v1/video/10/link')) return response({ link: 'https://data11.sledujteto.com/watch?x=1' });
    throw Error('Unexpected request: ' + url);
  } });
  const first = { ...cfg, sledujtetoEmail: 'account1@example.invalid' };
  const second = { ...cfg, sledujtetoEmail: 'account2@example.invalid' };
  const input = { meta: { name: 'Mayday', year: 2026 }, type: 'movie' };
  await findSledujtetoStreams({ ...input, cfg: first }, { api: client });
  await findSledujtetoStreams({ ...input, cfg: second }, { api: client });
  await findSledujtetoStreams({ ...input, cfg: first }, { api: client });
  assert.equal(requests.filter(([url]) => url.endsWith('/v1/token')).length, 2);
  assert.equal(requests.filter(([url]) => url.includes('/v1/videos?')).length, 2);
  assert.equal(requests.filter(([url]) => url.includes('/v1/video/10/link')).length, 3);
  assert.deepEqual(requests.filter(([url]) => url.endsWith('/v1/video/10/link'))
    .map(([, options]) => options.headers.Authorization),
  ['Bearer account1@example.invalid', 'Bearer account2@example.invalid', 'Bearer account1@example.invalid']);
});

test('Sledujteto refreshes an expired login once and does not loop', async () => {
  let loginCalls = 0;
  let searchCalls = 0;
  const client = createSledujtetoClient({ fetchImpl: async (url, options) => {
    if (url.endsWith('/v1/token')) return response({ token: `token-${++loginCalls}` });
    if (url.includes('/v1/videos?')) {
      searchCalls++;
      if (options.headers.Authorization === 'Bearer token-1') return { ok: false, status: 401 };
      return response({ results: [] });
    }
    throw Error('Unexpected request');
  } });
  const args = { ...cfg, email: cfg.sledujtetoEmail, password: cfg.sledujtetoPassword,
    query: 'Mayday', titles: ['Mayday'], type: 'movie', year: '2026' };
  await client.search(args);
  assert.equal(loginCalls, 2);
  assert.equal(searchCalls, 2);
});

test('Sledujteto cools down after HTTP 429 instead of retrying repeatedly', async () => {
  let searchCalls = 0;
  const client = createSledujtetoClient({ fetchImpl: async (url) => {
    if (url.endsWith('/v1/token')) return response({ token: 'token' });
    searchCalls++;
    return { ok: false, status: 429 };
  } });
  const args = { email: cfg.sledujtetoEmail, password: cfg.sledujtetoPassword,
    query: 'Mayday', titles: ['Mayday'], type: 'movie', year: '2026' };
  await assert.rejects(client.search(args), /429/);
  await assert.rejects(client.search(args), /rate limited/);
  assert.equal(searchCalls, 1);
});


test('Sledujteto uses bounded Streamlet-style offset pagination for old episodes', async () => {
  const offsets = [];
  const api = createSledujtetoClient({ fetchImpl: async (url) => {
    if (url.endsWith('/v1/token')) return response({ token: 'token-123' });
    if (url.includes('/v1/videos?')) {
      const offset = Number(new URL(url).searchParams.get('offset'));
      offsets.push(offset);
      const items = Array.from({ length: 32 }, (_, index) =>
        file(1000 + offset + index, 'Ted Lasso S04E09 CZ'));
      if (offset === 64) items.push(file(2026, 'Ted Lasso S01E01 CZ titulky'));
      return response({ total: 97, items });
    }
    if (url.endsWith('/v1/video/2026/link')) {
      return response({ download_link: 'https://data11.sledujteto.com/video/2026?token=short' });
    }
    throw Error('Unexpected request: ' + url);
  } });
  const streams = await findSledujtetoStreams({
    cfg, meta: { name: 'Ted Lasso' }, type: 'series', season: 1, episode: 1
  }, { api });
  assert.deepEqual(offsets, [0, 32, 64]);
  assert.equal(streams.length, 1);
  assert.match(streams[0].url, /sledujteto\.com\/video\/2026/);
});

test('Sledujteto maps Streamlet-style CDN VTT property without dropping subtitle variants', () => {
  const subtitles = subtitlesFromVideo({ subtitles: [
    { language: 'cze', title: 'CZE', cdnUrl: 'https://cdn.example.org/1.vtt' },
    { language: 'eng', title: 'EN1', cdnUrl: 'https://cdn.example.org/2.vtt' },
    { language: 'eng', title: 'EN2', cdnUrl: 'https://cdn.example.org/3.vtt' }
  ] }, 3);
  assert.deepEqual(subtitles.map(item => item.lang), ['ces', 'eng', 'eng']);
  assert.equal(new Set(subtitles.map(item => item.id)).size, 3);
});
