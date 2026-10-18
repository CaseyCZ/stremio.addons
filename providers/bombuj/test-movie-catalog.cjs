'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PAGE_SIZE, MOVIE_CATALOGS, SORT_OPTIONS, AUDIO_OPTIONS,
  parseCatalogPath, browseUrl, manifestCatalogs, normalizeGenreLabel
} = require('./movie-catalog-config.js');

test('film catalogue rows are four distinct browse modes', () => {
  assert.equal(PAGE_SIZE, 16);
  assert.equal(MOVIE_CATALOGS.length, 4);
  assert.equal(new Set(MOVIE_CATALOGS.map(item => item.id)).size, 4);
  assert.deepEqual(MOVIE_CATALOGS.map(item => item.sort),
    ['id', 'hodnotenie', 'todayviews', 'views']);
});

test('legacy film catalogue remains compatible with skip based pagination', () => {
  assert.deepEqual(parseCatalogPath('/catalog/movie/bombuj-movies.json'), {
    id: 'bombuj-movies', search: '', genre: '', audio: '1', sort: 'id', skip: 0
  });
  const pageTwo = parseCatalogPath('/catalog/movie/bombuj-movies/skip=16.json');
  assert.equal(pageTwo.skip, 16);
  assert.equal(Math.floor(pageTwo.skip / PAGE_SIZE) + 1, 2);
  const pageThree = parseCatalogPath('/catalog/movie/bombuj-movies/skip=32.json');
  assert.equal(Math.floor(pageThree.skip / PAGE_SIZE) + 1, 3);
});

test('other catalogue IDs apply their default server-side sort', () => {
  assert.equal(parseCatalogPath('/catalog/movie/bombuj-movies-by-year.json'), null);
  assert.equal(parseCatalogPath('/catalog/movie/bombuj-movies-best-rated.json').sort, 'hodnotenie');
  assert.equal(parseCatalogPath('/catalog/movie/bombuj-movies-most-watched.json').sort, 'views');
  assert.equal(parseCatalogPath('/catalog/movie/bombuj-movies-top-today.json').sort, 'todayviews');
  assert.equal(parseCatalogPath('/catalog/movie/unknown.json'), null);
  assert.equal(parseCatalogPath('/catalog/series/bombuj-movies.json'), null);
});

test('genre, dabing, custom sort and nonaligned skip are preserved', () => {
  const result = parseCatalogPath(
    '/catalog/movie/bombuj-movies/genre=Ak%C4%8Dn%C3%AD&audio=Jen%20dabovan%C3%A9&sort=Podle%20roku&skip=100.json'
  );
  assert.equal(result.genre, 'Akční');
  assert.equal(result.audio, '2');
  assert.equal(result.sort, 'year');
  assert.equal(result.skip, 100);
  assert.equal(Math.floor(result.skip / PAGE_SIZE) + 1, 7);
  assert.equal(result.skip % PAGE_SIZE, 4);
});

test('all server query parameters are passed to Bombuj', () => {
  const url = new URL(browseUrl({ page: 7, sort: 'hodnotenie', audio: '3', genre: 'Akčné' }));
  assert.equal(url.hostname, 'www.bombuj.si');
  assert.equal(url.pathname, '/zanre/obr/all.php');
  assert.equal(url.searchParams.get('page'), '7');
  assert.equal(url.searchParams.get('sort'), 'hodnotenie');
  assert.equal(url.searchParams.get('title'), '3');
  assert.equal(url.searchParams.get('zaner'), 'Akčné');
  assert.equal(normalizeGenreLabel('Akční'), normalizeGenreLabel('Akčné'));
});

test('four browsing categories retain skip, genre, audio but never enter Stremio search', () => {
  const catalogs = manifestCatalogs(['Akční', 'Komedie', 'Horor']);
  assert.equal(catalogs.length, 5);
  for (const catalog of catalogs.slice(0, 4)) {
    assert.equal(catalog.type, 'movie');
    assert.deepEqual(catalog.extra.map(item => item.name), ['genre','audio','skip']);
    assert.deepEqual(catalog.extra.find(item => item.name === 'audio').options, AUDIO_OPTIONS.map(item => item.label));
  }
});

test('film categories each keep unique server sort and Czech labels', () => {
  const expected=['🆕 Nejnovější filmy','⭐ Nejlépe hodnocené filmy','🔥 TOP dnes','🏆 TOP celkově'];
  const catalogs=manifestCatalogs(['Akční']).slice(0, 4);
  assert.deepEqual(catalogs.map(c=>c.name.replace('Bombuj – ','')),expected);
  assert(catalogs.every(c=>c.extra.some(x=>x.name==='genre')));
  assert(catalogs.every(c=>c.extra.some(x=>x.name==='audio')));
  assert(catalogs.every(c=>!c.extra.some(x=>x.name==='sort')));
  assert.equal(parseCatalogPath('/catalog/movie/bombuj-movies-by-year/skip=32.json'),null);
});

test('only one Bombuj movie search row with required search is advertised', () => {
  const manifest = manifestCatalogs(['Akční']);
  const searchRows = manifest.filter(item => item.extra.some(extra => extra.name === 'search'));
  assert.equal(searchRows.length, 1);
  assert.equal(searchRows[0].id, 'bombuj-movies-search');
  assert.equal(searchRows[0].name, '🔎 Bombuj – Hledat filmy');
  assert.deepEqual(searchRows[0].extra, [{name:'search',isRequired:true},{name:'skip'}]);
  assert.equal(parseCatalogPath('/catalog/movie/bombuj-movies-search/search=hope.json').search,'hope');
  assert.equal(parseCatalogPath('/catalog/movie/bombuj-movies-search.json').search,'');
  assert.equal(manifest.slice(0,4).every(x=>x.extra.every(y=>y.name!=='search')),true);
});
