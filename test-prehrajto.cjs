'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findPrehrajtoStreams, acceptsCandidate, episodeTokens, mapSubtitle, makeStream,
  validDetailUrl, validCdnUrl
} = require('./api/prehrajto');

const MAYDAY = 'https://prehraj.to/mayday-2026-1080p-cz-a-sk-titulky/d90920cb3f176ead';
const DEAD_CITY = 'https://prehraj.to/walking-dead-dead-city-s02e06-cz-dab-bridge-partners-are-hard-to-come-by-these-days-dd/5d2aa213c31d797e';

function cdn(ext = 'mp4', expires = 60 * 60) {
  return 'https://pf-storage6.premiumcdn.net/184285125/preview.' + ext +
    '?token=abc&expires=' + (Math.floor(Date.now() / 1000) + expires) + '&signature=xyz';
}

test('accepts canonical details but not arbitrary websites or fake hostnames', () => {
  assert.equal(validDetailUrl(MAYDAY), MAYDAY);
  assert.equal(validDetailUrl('https://prehrajto.cz/mayday/d90920cb3f176ead'),
    'https://prehraj.to/mayday/d90920cb3f176ead');
  assert.equal(validDetailUrl('https://prehraj.to.evil.example/a/d90920cb3f176ead'), null);
  assert.equal(validDetailUrl('http://prehraj.to/a/d90920cb3f176ead'), null);
});

test('CDN MP4 and VTT only, never expired signed links', () => {
  assert.ok(validCdnUrl(cdn('mp4'), 'mp4'));
  assert.ok(validCdnUrl(cdn('vtt'), 'vtt'));
  assert.equal(validCdnUrl(cdn('mp4'), 'vtt'), null);
  assert.equal(validCdnUrl(cdn('mp4', -5), 'mp4'), null);
  assert.equal(validCdnUrl('https://premiumcdn.net.bad.example/file.mp4', 'mp4'), null);
});

test('film title and year match, but spin-off and other-year uploads do not', () => {
  assert.equal(acceptsCandidate('Mayday (2026) 1080p CZ a SK TITULKY', ['Mayday'], 'movie', '2026'), true);
  assert.equal(acceptsCandidate('Mayday 2024 CZ DAB', ['Mayday'], 'movie', '2026'), false);
  assert.equal(acceptsCandidate('Mayday: The Flight (2026)', ['Mayday'], 'movie', '2026'), false);
  assert.equal(acceptsCandidate('Mayday S01E01', ['Mayday'], 'movie', '2026'), false);
});

test('series match must include full show identity and exact episode', () => {
  assert.equal(acceptsCandidate('The Walking Dead Dead City S02E06 CZ DAB',
    ['The Walking Dead'], 'series', '', 2, 6), false);
  assert.equal(acceptsCandidate('The Walking Dead: Dead City S02E06 CZ DAB',
    ['The Walking Dead: Dead City'], 'series', '', 2, 6), true);
  assert.equal(acceptsCandidate('The Walking Dead: Dead City S02E05 CZ DAB',
    ['The Walking Dead: Dead City'], 'series', '', 2, 6), false);
  assert.equal(acceptsCandidate('The Walking Dead: Dead City S02E06-07 CZ',
    ['The Walking Dead: Dead City'], 'series', '', 2, 6), false);
  assert.equal(acceptsCandidate('Ted Lasso S01E01', ['Ted'], 'series', '', 1, 1), false);
  assert.equal(acceptsCandidate('Ted S01E01', ['Ted'], 'series', '', 1, 1), true);
  assert.deepEqual(episodeTokens('Show 2x06').map(x => [x.season, x.episode]), [[2, 6]]);
});

test('Mayday five caption tracks keep unique ids and correct ISO language codes', () => {
  const tracks = [
    { lang: 'cze', label: 'CZE' },
    { lang: 'slo', label: 'SLO' },
    { lang: 'eng', label: 'ENG' },
    { lang: 'ng1', label: 'ENG1' },
    { lang: 'ng2', label: 'ENG2' }
  ].map((track, index) => mapSubtitle({ ...track, url: cdn('vtt') }, 'd90920cb3f176ead', index));
  assert.deepEqual(tracks.map(x => x.lang), ['ces', 'slk', 'eng', 'eng', 'eng']);
  assert.equal(new Set(tracks.map(x => x.id)).size, 5);
  assert.match(tracks[3].label, /English 1/);
  assert.match(tracks[4].label, /English 2/);
});

test('Mayday creates direct stream with track URLs and unknown quality, not fake 1080p', () => {
  const stream = makeStream({title:'Mayday (2026) 1080p CZ a SK TITULKY'}, MAYDAY, {
    video_url: cdn('mp4'),
    subtitles: [{lang:'cze',label:'CZE',url:cdn('vtt')}, {lang:'slo',label:'SLO',url:cdn('vtt')}]
  });
  assert.equal(stream.name, 'Přehraj.to');
  assert.match(stream.title, /kvalita nezjištěna/);
  assert.equal(stream.subtitles.length, 2);
  assert.deepEqual(stream.subtitles.map(x => x.lang), ['ces','slk']);
  assert.equal(stream.url.startsWith('https://pf-storage6.premiumcdn.net/'), true);
});

test('matching and resolution work without live third-party API calls', async () => {
  let searched = 0;
  let resolved = 0;
  const results = await findPrehrajtoStreams({
    meta: { name:'Mayday', releaseInfo:'2026' }, type:'movie'
  }, {
    search: async () => { searched++; return [
      {title:'Mayday: The Flight (2026)',url:'https://prehraj.to/fake/0123456789abcdef'},
      {title:'Mayday (2026) 1080p CZ a SK TITULKY',url:MAYDAY}
    ]; },
    resolve: async url => { resolved++; assert.equal(url,MAYDAY); return {
      success:true,video_url:cdn('mp4'), subtitles: [{lang:'cze',label:'CZE',url:cdn('vtt')}]
    }; }
  });
  assert.equal(searched, 1);
  assert.equal(resolved, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].subtitles[0].lang, 'ces');
});

test('API errors never produce fabricated playable streams', async () => {
  const result = await findPrehrajtoStreams({meta:{name:'Mayday',year:2026},type:'movie'}, {
    search: async () => { throw Error('offline'); }
  });
  assert.deepEqual(result, []);
});

test('episode without S/E identity is not accepted', async () => {
  const result = await findPrehrajtoStreams({meta:{name:'The Walking Dead: Dead City'}, type:'series', season:2, episode:6}, {
    search: async () => [{title:'The Walking Dead: Dead City', url:DEAD_CITY}],
    resolve: async () => { throw Error('must not resolve no-episode candidate'); }
  });
  assert.deepEqual(result, []);
});
