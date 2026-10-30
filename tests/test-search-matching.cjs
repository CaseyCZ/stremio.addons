'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { titleMatchScore, episodeTokens } = require('../api/search-matching');

test('full film titles match quality tags, release groups and Czech accents', () => {
  assert.ok(titleMatchScore('Barbie.2023.1080p.BluRay.x264-GROUP', ['Barbie', 'Barbie 2023']) >= 0.98);
  assert.ok(titleMatchScore('Příliš osobní známost (2020) CZ 1080p', ['Prilis osobni znamost']) >= 0.98);
  assert.equal(titleMatchScore('Ted 2012 1080p CZ', ['Ted']), 0.98);
});

test('sequel, spin-off and title substrings cannot score as the requested film', () => {
  assert.equal(titleMatchScore('Ted Lasso 2012 1080p', ['Ted']), 0);
  assert.equal(titleMatchScore('Ted 2 2015 1080p', ['Ted']), 0);
  assert.equal(titleMatchScore('The Dark Knight Rises 2012 BluRay', ['The Dark Knight']), 0);
  assert.equal(titleMatchScore('Avatar The Way of Water 2022 2160p', ['Avatar']), 0);
  assert.equal(titleMatchScore('Setup 2011 WEB-DL', ['Up']), 0);
});

test('series release names keep exact show identity', () => {
  assert.equal(titleMatchScore('The Walking Dead S02E06 CZ', ['The Walking Dead']), 0.98);
  assert.equal(titleMatchScore('The Walking Dead Dead City S02E06', ['The Walking Dead']), 0);
  assert.equal(titleMatchScore('Ted Lasso S01E01', ['Ted']), 0);
  assert.equal(titleMatchScore('Ted Lasso S04E04 CZtitulky', ['Ted Lasso']), 0.98);
  assert.equal(titleMatchScore('Ted Lasso S04E01 CZ Titulky chemon', ['Ted Lasso']), 0.75);
  assert.equal(titleMatchScore('Ted Lasso S04E01 CZ Titulky chemon', ['Ted']), 0);
});

test('episode identifiers include safe Czech, Slovak and English forms', () => {
  for (const value of [
    'Show S02E06 CZ', 'Show 2x06 CZ', 'Show 2. série – 6. díl',
    'Show série 2 epizoda 6', 'Show season 2 episode 6', 'Show 2. rada 6. dil'
  ]) {
    assert.deepEqual(episodeTokens(value).map(x => [x.season, x.episode]), [[2, 6]], value);
  }
  assert.deepEqual(episodeTokens('Show 2. série – 6.–7. díl'), []);
});

test('actual Přehraj.to search listing cannot confuse requested Ted Lasso episode', () => {
  const items = [
    'Ted Lasso S04E01 CZ Titulky chemon',
    'Ted Lasso S04E09 CZ Titulky H265 HEVC 4K UHD HDR 10.26',
    'Ted Lasso S03E06 CzTit',
    'Ted Lasso_S04E08_Vstříc vzteku',
    'Ted Lasso - S4E4 Greyhounds’ Day Off EN',
    'Ted Lasso 2. série – 6. díl'
  ];
  const selected = items.filter(item =>
    titleMatchScore(item, ['Ted Lasso']) >= 0.55 &&
    episodeTokens(item).some(token => token.season === 4 && token.episode === 1));
  assert.deepEqual(selected, ['Ted Lasso S04E01 CZ Titulky chemon']);
});
