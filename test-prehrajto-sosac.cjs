'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SosacOverlay } = require('./api/sosac-overlay');

// These fixtures deliberately don't access the real Sosac account or API.
// They exercise the exact overlay already used by SKTOnline and Bombuj.
function overlayWithFixtures() {
  const overlay = new SosacOverlay({ username: 'test-user', password: 'test-secret' });
  overlay.sosac.get = async (resource, config) => {
    assert.equal(config.params.username, 'test-user');
    assert.match(config.params.password, /^[a-f0-9]{32}$/);
    switch (resource) {
      case 'movies/123': return { data: { imdb: 'tt33400719', n: 'Strange Harvest', y: 2024 } };
      case 'serials/234': return { data: { info: { imdb_id: 'tt1954804', n: 'Saving Hope' } } };
      case 'episodes/345': return { data: {
        s: 2, ep: 6,
        series: { imdb: 'tt18546730', n: 'The Walking Dead: Dead City' }
      } };
      case 'episodes/346': return { data: {
        s: 0, ep: 6,
        series: { imdb: 'tt18546730' }
      } };
      default: throw Error('Unexpected Sosac fixture: ' + resource);
    }
  };
  return overlay;
}

test('Sosac movie ID resolves to a trusted IMDb movie', async () => {
  const resolved = await overlayWithFixtures().resolve('movie', 'sosac_m_123');
  assert.equal(resolved.id, 'tt33400719');
  assert.equal(resolved.imdbId, 'tt33400719');
  assert.equal(resolved.season, null);
  assert.equal(resolved.episode, null);
});

test('Sosac series ID is resolved, but contains no arbitrary episode', async () => {
  const resolved = await overlayWithFixtures().resolve('series', 'sosac_s_234');
  assert.equal(resolved.id, 'tt1954804');
  assert.equal(resolved.season, null);
  assert.equal(resolved.episode, null);
});

test('Sosac episode keeps original IMDb show identity and exact season/episode', async () => {
  const resolved = await overlayWithFixtures().resolve('series', 'sosac_ep_345');
  assert.equal(resolved.id, 'tt18546730:2:6');
  assert.equal(resolved.imdbId, 'tt18546730');
  assert.equal(resolved.season, 2);
  assert.equal(resolved.episode, 6);
});

test('Missing login and mismatched ID type never obtain a Sosac identity', async () => {
  const unconfigured = new SosacOverlay({});
  assert.equal(await unconfigured.resolve('movie', 'sosac_m_123'), null);
  assert.equal(await overlayWithFixtures().resolve('series', 'sosac_m_123'), null);
  assert.equal(await overlayWithFixtures().resolve('movie', 'sosac_ep_345'), null);
});
