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

test('Mayday uses the shared stream display style with actual subtitle tracks', () => {
  const stream = makeStream({title:'Mayday (2026) 1080p CZ a SK TITULKY'}, MAYDAY, {
    video_url: cdn('mp4'),
    subtitles: [{lang:'cze',label:'CZE',url:cdn('vtt')}, {lang:'slo',label:'SLO',url:cdn('vtt')}]
  });
  assert.equal(stream.name, 'Přehraj.to • 1080p');
  assert.match(stream.title, /^🎧 Neuvedeno\n💬 🇨🇿 CZ • 🇸🇰 SK\n🎬 1080p\n🎞 /);
  assert.equal(Object.hasOwn(stream, 'description'), false);
  assert.equal(stream.subtitles.length, 2);
  assert.deepEqual(stream.subtitles.map(x => x.lang), ['ces','slk']);
  assert.equal(stream.url.startsWith('https://pf-storage6.premiumcdn.net/'), true);
});

test('Forrest Gump audio flags and release-quality labels never invent a resolution', () => {
  const result = title => makeStream({ title }, MAYDAY, { video_url: cdn('mp4'), subtitles: [] });
  const direct = result('Forrest Gump 1994 CZ dab');
  assert.equal(direct.name, 'Přehraj.to • Direct');
  assert.match(direct.title, /^🎧 🇨🇿 CZ\n💬 Bez titulků\n🎬 Direct\n🎞 Forrest Gump 1994 CZ dab$/);
  assert.equal(Object.hasOwn(direct, 'description'), false);

  const ultra = result('Forrest Gump (1994) CZ Dabing 2160p');
  assert.equal(ultra.name, 'Přehraj.to • 2160p');
  assert.match(ultra.title, /^🎧 🇨🇿 CZ\n💬 Bez titulků\n🎬 2160p/);

  const fullHd = result('Forrest Gump 1994 CZ dabing 1080p FHD');
  assert.equal(fullHd.name, 'Přehraj.to • 1080p');
  assert.match(fullHd.title, /^🎧 🇨🇿 CZ\n💬 Bez titulků\n🎬 1080p/);
});

test('subtitle language alone does not imply dubbed audio', () => {
  const stream = makeStream({title:'Mayday 2026 CZ a SK titulky'}, MAYDAY, {
    video_url: cdn('mp4'),
    subtitles: [{lang:'eng',label:'ENG',url:cdn('vtt')}]
  });
  assert.match(stream.title, /^🎧 Neuvedeno\n💬 🇬🇧 EN\n🎬 Direct/);
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
