'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHellspyClient } = require('../api/hellspy-experimental');

const file = (id, title) => ({ objectType: 'GWSearchVideo', id, fileHash: 'aabbccddeeff0011', title, size: 1000000 });

test('HellSpy fuzzy search is filtered by exact show and episode identity', async () => {
  const calls = [];
  const client = createHellspyClient({ fetchImpl: async (url, options) => {
    calls.push([url, options]);
    return { ok: true, status: 200, json: async () => ({ items: [
      file(1, 'Ted Lasso S04E01 CZ Titulky chemon'),
      file(2, 'Ted Lasso S04E09 CZ Titulky'),
      file(3, 'Ted Lasso S03E06 CzTit'),
      file(4, 'Ztrácím tě lásko 1978'),
      file(5, 'Ted Lasso S04E01-03 CZ'),
      { ...file(6, 'Ted Lasso S04E01'), objectType: 'GWSearchFolder' }
    ] }) };
  } });
  const results = await client.search({ query: 'ted laso 2026', titles: ['Ted Lasso'], type: 'series', season: 4, episode: 1 });
  assert.deepEqual(results.map(item => item.id), [1]);
  assert.match(calls[0][0], /^https:\/\/api\.hellspy\.to\/gw\/search\?/);
  assert.equal(calls[0][1].method, 'GET');
});

test('HellSpy accepts the real episode title suffix but rejects wrong shows', async () => {
  const client = createHellspyClient({ fetchImpl: async () => ({
    ok: true, status: 200, json: async () => ({ items: [
      file(1, 'Ted Lasso S04E01 Home EN'),
      file(2, 'Ted Lasso - S4E1 Domov CZ Titulky'),
      file(3, 'The Ted Lasso Parody S04E01 Home EN'),
      file(4, 'Ted Lasso S04E02 Home EN'),
      file(5, 'Ted Lasso S04E01-03 Collection')
    ] })
  }) });
  const results = await client.search({ query: 'Ted Lasso S04E01', titles: ['Ted Lasso'],
    type: 'series', season: 4, episode: 1 });
  assert.deepEqual(results.map(item => item.id), [1, 2]);
});

test('HellSpy original films accept first-part aliases only with matching year', async () => {
  const client = createHellspyClient({ fetchImpl: async () => ({
    ok: true, status: 200, json: async () => ({ items: [
      file(1, 'Avatar_1_(2009)_[CZ_Dabing]'),
      file(2, 'Avatar (2009) 1080p'),
      file(3, 'Avatar 2 (2009) CZ Dabing'),
      file(4, 'Avatar The Way of Water (2022)'),
      file(5, 'Avatar 1 CZ Dabing'),
      file(6, 'Avatar S01E01 2009')
    ] })
  }) });
  const results = await client.search({ query: 'Avatar 2009', titles: ['Avatar'],
    type: 'movie', year: '2009' });
  assert.deepEqual(results.map(item => item.id), [1, 2]);
});

test('HellSpy caches successful metadata search without caching direct media URLs', async () => {
  let calls = 0;
  let current = 1000;
  const client = createHellspyClient({ now: () => current, fetchImpl: async () => {
    calls++;
    return { ok: true, status: 200, json: async () => ({ items: [file(1, 'Avatar 2009 CZ')] }) };
  } });
  const query = { query: 'Avatar 2009', titles: ['Avatar'], type: 'movie', year: '2009' };
  const first = await client.search(query);
  first[0].title = 'Mutated caller copy';
  const second = await client.search(query);
  assert.equal(second[0].title, 'Avatar 2009 CZ');
  assert.equal(calls, 1);
  current += 10 * 60 * 1000;
  await client.search(query);
  assert.equal(calls, 2);
});

test('HellSpy coalesces simultaneous identical search requests', async () => {
  let calls = 0;
  const client = createHellspyClient({ fetchImpl: async () => {
    calls++;
    await new Promise(done => setTimeout(done, 5));
    return { ok: true, status: 200, json: async () => ({ items: [file(1, 'Avatar 2009 CZ')] }) };
  } });
  const query = { query: 'Avatar 2009', titles: ['Avatar'], type: 'movie', year: '2009' };
  const [first, second] = await Promise.all([client.search(query), client.search(query)]);
  assert.equal(calls, 1);
  assert.notStrictEqual(first, second);
  first[0].title = 'Local edit';
  assert.equal(second[0].title, 'Avatar 2009 CZ');
});

test('HellSpy HTTP 429 stops repeated searches for 10 minutes', async () => {
  let calls = 0;
  let current = 1000;
  const client = createHellspyClient({ now: () => current, fetchImpl: async () => {
    calls++;
    return { ok: false, status: 429 };
  } });
  const query = { query: 'Ted Lasso', titles: ['Ted Lasso'], type: 'series', season: 4, episode: 1 };
  await assert.rejects(client.search(query), /429/);
  await assert.rejects(client.search(query), /rate limited/);
  assert.equal(calls, 1);
  current += 10 * 60 * 1000;
  await assert.rejects(client.search(query), /429/);
  assert.equal(calls, 2);
});

test('concurrent HTTP 429 errors do not trigger extra HellSpy requests', async () => {
  let calls = 0;
  const client = createHellspyClient({ fetchImpl: async () => {
    calls++;
    await new Promise(done => setTimeout(done, 5));
    return { ok: false, status: 429 };
  } });
  const query = { query: 'Ted Lasso', titles: ['Ted Lasso'],
    type: 'series', season: 4, episode: 1 };
  const results = await Promise.allSettled([client.search(query), client.search(query)]);
  assert.equal(calls, 1);
  assert.ok(results.every(result => result.status === 'rejected' && /429/.test(result.reason.message)));
  await assert.rejects(client.search(query), /rate limited/);
  assert.equal(calls, 1);
});

test('HellSpy video resolution reads redirect Location without following or proxying media', async () => {
  const calls = [];
  const client = createHellspyClient({ fetchImpl: async (url, options) => {
    calls.push([url, options]);
    return { status: 302, headers: { get: () => 'https://cdn.example.org/movie.mkv?token=short-lived' } };
  } });
  const url = await client.resolveOriginal({ id: 12345, fileHash: 'aabbccddeeff0011' });
  assert.equal(url, 'https://cdn.example.org/movie.mkv?token=short-lived');
  assert.equal(calls[0][1].redirect, 'manual');
  assert.equal(calls.length, 1);
  assert.equal(await client.resolveOriginal({ id: -1, fileHash: 'x' }), null);
});
