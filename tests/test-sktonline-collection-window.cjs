'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const {
  collectDirectSourcesWithin,
  findDirectOnlineByTitle,
  selectBestSktDisplayStreams
} = require('../api/sktonline');

const stream = (id, quality) => ({
  name: `SKTOnline • ${quality}`,
  url: `https://online9.sktorrent.eu/media/videos/h264/${id}_${quality}.mp4`
});

test('20-second-style deadline returns all results already found, even if providers are still busy', async () => {
  const budgetMs = 45;
  const started = Date.now();
  const streams = await collectDirectSourcesWithin(({ report }) => [
    ['slow detail', async () => {
      await delay(5);
      report([stream('100', '720p')]);
      await delay(250); // Another detail page exceeds the shared deadline.
      return [stream('999', '1080p')];
    }],
    ['online title', async () => {
      await delay(12);
      report([stream('100', '480p'), stream('100', '720p')]);
      await delay(250);
      return [];
    }]
  ], budgetMs);

  assert(Date.now() - started < 180, 'must not wait for the late requests');
  assert.deepEqual(streams.map(item => item.url), [
    stream('100', '720p').url,
    stream('100', '480p').url
  ], 'preserve both qualities and remove exact duplicates');
});

test('collection ends early when all providers finish', async () => {
  const started = Date.now();
  const found = await collectDirectSourcesWithin(() => [
    ['online title', () => Promise.resolve([stream('101', '1080p')])],
    ['detail', () => Promise.resolve([stream('102', '720p')])]
  ], 200);
  assert(Date.now() - started < 100);
  assert.equal(found.length, 2);
});

test('collectAll searches additional movie title variants and reports each source', async () => {
  const calls = [];
  const seen = [];
  const found = await findDirectOnlineByTitle(
    ['First title', 'Second title'], ['Movie'], 'movie', null, null,
    async query => {
      calls.push(query);
      return [{ id: query, title: query }];
    },
    async item => [stream(item.id === 'First title' ? '101' : '102', '720p')],
    { collectAll: true, deadline: Date.now() + 200, onProgress: streams => seen.push(...streams) }
  );
  assert.deepEqual(calls, ['First title', 'Second title']);
  assert.equal(found.length, 2);
  assert.equal(seen.length, 2);
});

test('merge duplicate MP4 links and preserve subtitle tracks found by both sources', async () => {
  const cze = { id: 'cze', lang: 'cze', url: 'https://online.sktorrent.eu/media/videos/vtt/101/cze.vtt' };
  const forced = { id: 'forced', lang: 'cze', url: 'https://online.sktorrent.eu/media/videos/vtt/101/cze_forced.vtt' };
  const found = await collectDirectSourcesWithin(() => [
    ['title', () => Promise.resolve([{ ...stream('101', '720p'), title: '🎧 CZ\n💬 Titulky', subtitles: [cze] }])],
    ['details', () => Promise.resolve([{
      ...stream('101', '720p'),
      url: stream('101', '720p').url.replace('online9.', 'online1.'),
      title: '🎧 CZ\n💬 Titulky', subtitles: [forced]
    }])]
  ], 200);
  assert.equal(found.length, 1, 'different SKTorrent CDN hosts must not duplicate an MP4');
  assert.deepEqual(found[0].subtitles.map(item => item.id), ['cze', 'forced']);
});

test('merge identical WEB embeds with and without the player suffix', async () => {
  const found = await collectDirectSourcesWithin(() => [
    ['title', () => Promise.resolve([{ externalUrl: 'https://online.sktorrent.eu/embed/abcdef123&1' }])],
    ['detail', () => Promise.resolve([{ externalUrl: 'https://online.sktorrent.eu/embed/abcdef123' }])]
  ], 200);
  assert.equal(found.length, 1);
});

test('keep all qualities of the best video plus distinct audio/subtitle variants', () => {
  const item = (id, quality, language, subs) => ({
    ...stream(id, quality),
    title: `🎧 ${language}\n💬 ${subs}\n🎬 ${quality}`
  });
  const all = [
    item('101', '720p', 'CZ', 'Bez titulků'),
    item('101', '480p', 'CZ', 'Bez titulků'),
    item('102', '1080p', 'CZ', 'Bez titulků'),
    item('102', '720p', 'CZ', 'Bez titulků'),
    item('103', '720p', 'SK', 'Bez titulků'),
    item('104', '720p', 'CZ', 'České (2 stopy)')
  ];
  const selected = selectBestSktDisplayStreams(all);
  assert.equal(selected.length, 4);
  assert.deepEqual(selected.map(item => item.url), [
    all[2].url, all[3].url, all[4].url, all[5].url
  ]);
});
