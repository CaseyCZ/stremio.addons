'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findPrehrajtoStreams, acceptsCandidate, episodeTokens, mapSubtitle, makeStream,
  validDetailUrl, validCdnUrl
} = require('../api/prehrajto');

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

test('Dark Knight general movie release suffixes include modern encodes but not sequels', () => {
  const accepted = [
    'The.Dark.Knight.2008.1080p.BluRay',
    'The.Dark.Knight.2008.2160p.BluRay.REMUX.HEVC.DTS-HD.MA.5.1-CZ.EN-TNT',
    'The.Dark.Knight.2008.2160p.MAX.WEB-DL.DDP.5.1.DV.HDR.H.265-PiRaTeS (1)',
    'The.Dark.Knight.2008.2160p.UHD.BluRay.X265-IAMABLE',
    'The.Dark.Knight[2008]DvDrip-aXXo'
  ];
  for (const title of accepted) {
    assert.equal(acceptsCandidate(title, ['The Dark Knight'], 'movie', '2008'), true, title);
  }
  for (const title of [
    'The.Dark.Knight.Rises.2012.1080p.cz',
    'The Dark Knight Rises',
    'The.Dark.Knight.2008.Rises.1080p',
    'The Dark Knight-Returns',
    'The Dark Knight 2008-Returns',
    'Batman.The.Dark.Knight.2008.1080p'
  ]) {
    assert.equal(acceptsCandidate(title, ['The Dark Knight'], 'movie', '2008'), false, title);
  }
});

test('movie release matching is generic and preserves title/year boundaries', () => {
  const cases = [
    ['John.Wick.2014.1080p.BluRay.x264-SPARKS', ['John Wick'], '2014', true],
    ['John.Wick.Chapter.2.2017.1080p.BluRay', ['John Wick'], '2014', false],
    ['Ted.2012.1080p.BluRay.x264-GECKOS', ['Ted'], '2012', true],
    ['Ted.Lasso.2012.1080p.BluRay', ['Ted'], '2012', false],
    ['Mayday (2026) 1080p CZ a SK TITULKY', ['Mayday'], '2026', true],
    ['Mayday 2026 CZ and SK titulky', ['Mayday'], '2026', true],
    ['Ted 2012 2', ['Ted'], '2012', false],
    ['Avatar.2009.Extended.2160p.UHD.BluRay.HEVC-RELEASE', ['Avatar'], '2009', true],
    ['Avatar.The.Way.Of.Water.2009.2160p', ['Avatar'], '2009', false]
  ];
  for (const [title, wanted, year, accepted] of cases) {
    assert.equal(acceptsCandidate(title, wanted, 'movie', year), accepted, title);
  }
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

test('real Ted Lasso uploads only match the requested season and episode', () => {
  const uploads = [
    'Ted Lasso S04E01 CZ Titulky chemon',
    'Ted Lasso S04E01 CZ Titulky 1080p FULL HD lemon',
    'Ted Lasso S04E09 CZ Titulky H265 HEVC 4K UHD HDR',
    'Ted Lasso S03E06 CzTit',
    'Ted Lasso_S04E08_Vstříc vzteku',
    'Ted Lasso - S4E4 Greyhounds’ Day Off EN',
    'Ztrácím tě, lásko (1978)'
  ];
  const matching = uploads.filter(name => acceptsCandidate(name, ['Ted Lasso'], 'series', '', 4, 1));
  assert.deepEqual(matching, uploads.slice(0, 2));
  assert.equal(acceptsCandidate('Ted Lasso 4. série – 1. díl CZ', ['Ted Lasso'], 'series', '', 4, 1), true);
  assert.equal(acceptsCandidate('Ted Lasso 4. série – 1.–2. díl', ['Ted Lasso'], 'series', '', 4, 1), false);
});

test('series queries include padded/unpadded S/E notation and a broad title fallback', () => {
  const { makeQueries } = require('../api/prehrajto');
  const queries = makeQueries(['Ted Lasso'], 'series', '', 4, 4);
  assert.ok(queries.includes('Ted Lasso S04E04'));
  assert.ok(queries.includes('Ted Lasso S4E4'));
  assert.ok(queries.includes('Ted Lasso'));
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
  assert.equal(searched, 2); // parallel title+year and title-only searches
  assert.equal(resolved, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].subtitles[0].lang, 'ces');
});

test('sixteen streams maximum, four concurrent resolvers, duplicate links ignored', async () => {
  const movies = Array.from({ length: 25 }, (_, i) => ({
    title: 'The Dark Knight 2008 2160p BluRay',
    url: 'https://prehraj.to/film-' + i + '/' + (i + 1).toString(16).padStart(16, '0')
  }));
  let inFlight = 0;
  let peak = 0;
  let attempts = 0;
  const queries = [];
  const streams = await findPrehrajtoStreams({
    meta: { name: 'The Dark Knight', year: 2008 }, type: 'movie'
  }, {
    search: async query => { queries.push(query); return movies; },
    resolve: async url => {
      attempts++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(done => setTimeout(done, 3));
      inFlight--;
      const file = url.split('/').pop();
      return { video_url: 'https://pf-storage6.premiumcdn.net/123/' + file +
        '.mp4?expires=' + (Math.floor(Date.now() / 1000) + 3600) };
    }
  });
  assert.equal(queries.length, 2);
  assert.equal(streams.length, 16);
  assert.ok(attempts >= 16 && attempts <= 19);
  assert.ok(peak > 1 && peak <= 4);
  assert.equal(new Set(streams.map(s => s.url)).size, 16);
  assert.ok(streams.every(s => !Object.hasOwn(s, 'description')));
});

test('all thirteen real Ted Lasso S04E01 naming variants can become streams', async () => {
  const names = [
    'Ted Lasso S04E01 CZ Titulky chemon',
    'Ted Lasso S04E01 CZ Titulky  LumiX',
    'Ted Lasso S04E01 CZ Titulky lemon',
    'Ted Lasso S04E01 CZ Titulky',
    'Ted Lasso S04E01 CZ Titulky demon',
    'Ted Lasso S04E01 CZ Titulky 1080p FULL HD chemon',
    'Ted Lasso S04E01 CZ Titulky 1080p FULL HD lemon',
    'Ted Lasso S04E01 CZ Titulky 1080p FULL HD demon',
    'Ted Lasso S04E01 CZ Titulky',
    'Ted Lasso S04E01 CzTit',
    'Ted Lasso_S04E01_Domov',
    'Ted Lasso - S4E1 Home EN',
    'Ted Lasso S04E01 CZtitulky'
  ];
  const movies = names.map((title, index) => ({
    title,
    url: 'https://prehraj.to/ted-lasso/' + (index + 1).toString(16).padStart(16, '0')
  }));
  const checked = [];
  const streams = await findPrehrajtoStreams({
    meta: { name: 'Ted Lasso' }, type: 'series', season: 4, episode: 1
  }, {
    search: async () => movies,
    resolve: async url => {
      checked.push(url);
      return { video_url: 'https://pf-storage6.premiumcdn.net/123/' +
        url.split('/').pop() + '.mp4?expires=' + (Math.floor(Date.now() / 1000) + 3600) };
    }
  });
  assert.equal(checked.length, 13);
  assert.equal(streams.length, 13);
  assert.equal(new Set(streams.map(stream => stream.url)).size, 13);
});

test('searches later title variants after earlier match and tolerates resolver errors', async () => {
  const movie = i => ({ title: 'Example Film 2008 1080p',
    url: 'https://prehraj.to/film/' + i.toString(16).padStart(16, '0') });
  const requested = [];
  let attempts = 0;
  const streams = await findPrehrajtoStreams({
    meta: { name: 'Example Film', year: 2008 }, type: 'movie'
  }, {
    search: async query => {
      requested.push(query);
      return query.includes('2008') ? [movie(1), movie(2)] : [movie(1), movie(3)];
    },
    resolve: async url => {
      attempts++;
      if (url.endsWith('0000000000000002')) throw Error('temporary failure');
      return { video_url: 'https://pf-storage6.premiumcdn.net/123/' +
        url.split('/').pop() + '.mp4?expires=' + (Math.floor(Date.now() / 1000) + 3600) };
    }
  });
  assert.equal(requested.length, 2);
  assert.equal(attempts, 3); // duplicate page 1 is resolved only once
  assert.equal(streams.length, 2);
});

test('returns ready streams by deadline even if another resolver never completes', async () => {
  const movie = i => ({ title: 'Deadline Film 2008 1080p',
    url: 'https://prehraj.to/film/' + i.toString(16).padStart(16, '0') });
  const start = Date.now();
  const streams = await findPrehrajtoStreams({
    meta: { name: 'Deadline Film', year: 2008 }, type: 'movie'
  }, {
    budgetMs: 80,
    search: async () => [movie(1), movie(2)],
    resolve: url => url.endsWith('0000000000000001')
      ? Promise.resolve({ video_url: cdn('mp4') })
      : new Promise(() => {})
  });
  assert.equal(streams.length, 1);
  assert.ok(Date.now() - start < 800);
});

test('still excludes wrong films before parallel resolving', async () => {
  const files = [
    { title: 'The Dark Knight Rises 2012 1080p',
      url: 'https://prehraj.to/other/0000000000000001' },
    { title: 'The.Dark.Knight.2008.2160p.BluRay.REMUX.HEVC.DTS-HD.MA.5.1-CZ.EN-TNT',
      url: 'https://prehraj.to/film/0000000000000002' }
  ];
  let attempts = 0;
  const streams = await findPrehrajtoStreams({
    meta: { name: 'The Dark Knight', year: 2008 }, type: 'movie'
  }, {
    search: async () => files,
    resolve: async () => { attempts++; return { video_url: cdn('mp4') }; }
  });
  assert.equal(attempts, 1);
  assert.equal(streams.length, 1);
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
