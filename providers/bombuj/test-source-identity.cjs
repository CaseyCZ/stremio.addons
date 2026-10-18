'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { sourceIdentity, rememberSource, findSource } = require('./source-identity.js');

const film = { detailUrl: 'https://www.bombuj.si/online-film-podivna-sklizen-2024', title: 'Podivná sklizeň', year: '2024' };
const meta = { name: 'Strange Harvest', releaseInfo: '2025' };
const html = '<h1>Podivná sklizeň</h1><h2>Podivná sklizeň - Strange Harvest</h2><h3>2024 - Horor</h3>';

test('original title in a translated Bombuj detail matches Cinemeta within one year', () => {
  assert.equal(sourceIdentity('movie','tt33400719',meta,film,html,null),1);
});

test('exact embedded IMDb ID takes priority over year and translation', () => {
  assert.equal(sourceIdentity('movie','tt33400719',meta,film,'<h1>Unrelated</h1>','tt33400719'),2);
});

test('conflicting embedded IMDb ID always rejects a plausible name', () => {
  assert.equal(sourceIdentity('movie','tt33400719',meta,film,html,'tt99999999'),0);
});

test('two-year disagreement rejects weak title-only matching', () => {
  assert.equal(sourceIdentity('movie','tt33400719',{ ...meta, releaseInfo:'2027' },film,html,null),0);
});

test('unrelated title never matches only on year', () => {
  assert.equal(sourceIdentity('movie','tt33400719',meta,film,'<h2>Someone Else</h2>',null),0);
});

test('series title matching uses the same identity rules', () => {
  const series = { detailUrl:'https://serialy.bombuj.si/serial-cesky-serial-2025',title:'Český seriál',year:'2025' };
  assert.equal(sourceIdentity('series','tt12345678',{name:'English Series',releaseInfo:'2026'},series,
    '<h1>Český seriál - English Series</h1>',null),1);
});

test('source cache keeps movie and series mapping separated and rejects external URL', () => {
  assert.equal(rememberSource('movie','tt33400719',film),true);
  assert.equal(findSource('movie','tt33400719')?.detailUrl,film.detailUrl);
  assert.equal(findSource('series','tt33400719'),null);
  assert.equal(rememberSource('movie','tt33400719',{detailUrl:'https://evil.example/online-film-hacked'}),false);
  assert.equal(findSource('movie','tt33400719')?.detailUrl,film.detailUrl);
});

test('source cache refuses an invalid IMDb ID or wrong page type', () => {
  assert.equal(rememberSource('series','movie-123',film),false);
  assert.equal(rememberSource('series','tt33400719',film),false);
});

test('headings with parenthesized year still match by original name', () => {
  assert.equal(sourceIdentity('movie','tt33400719',meta,film,
    '<h2>Podivná sklizeň - Strange Harvest (2024)</h2><h3>2024 - Horor</h3>',null),1);
});
