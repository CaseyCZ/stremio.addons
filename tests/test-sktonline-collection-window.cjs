'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const {
  collectDirectSourcesWithin,
  findDirectOnlineByTitle
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

test('merge identical MP4 URLs and preserve subtitle tracks found by both sources', async () => {
  const cze = { id: 'cze', lang: 'cze', url: 'https://online.sktorrent.eu/media/videos/vtt/101/cze.vtt' };
  const forced = { id: 'forced', lang: 'cze', url: 'https://online.sktorrent.eu/media/videos/vtt/101/cze_forced.vtt' };
  const found = await collectDirectSourcesWithin(() => [
    ['title', () => Promise.resolve([{ ...stream('101', '720p'), title: '🎧 CZ\n💬 Titulky', subtitles: [cze] }])],
    ['details', () => Promise.resolve([{
      ...stream('101', '720p'),
      title: '🎧 CZ\n💬 Titulky', subtitles: [forced]
    }])]
  ], 200);
  assert.equal(found.length, 1, 'the same URL must be shown once');
  assert.deepEqual(found[0].subtitles.map(item => item.id), ['cze', 'forced']);
});

test('identical WEB links merge, but different embed URLs stay available', async () => {
  const found = await collectDirectSourcesWithin(() => [
    ['title', () => Promise.resolve([{ externalUrl: 'https://online.sktorrent.eu/embed/abcdef123&1' }])],
    ['detail', () => Promise.resolve([
      { externalUrl: 'https://online.sktorrent.eu/embed/abcdef123&1' },
      { externalUrl: 'https://online.sktorrent.eu/embed/abcdef123' }
    ])]
  ], 200);
  assert.equal(found.length, 2);
});

test('different URLs remain distinct even for the same video ID, quality and language', async () => {
  const mirror = { ...stream('101', '720p'), url: stream('101', '720p').url.replace('online9.', 'online1.') };
  const found = await collectDirectSourcesWithin(() => [
    ['title', () => Promise.resolve([stream('101', '720p'), stream('101', '480p')])],
    ['detail', () => Promise.resolve([mirror, stream('102', '720p')])]
  ], 200);
  assert.equal(found.length, 4);
});
