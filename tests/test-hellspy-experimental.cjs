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
