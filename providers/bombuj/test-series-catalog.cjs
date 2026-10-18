'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  PAGE_SIZE, catalogDefinitions, slugFromUrl, seriesId, episodeId, parseEpisodeMetaPath,
  parseSeriesCatalogPath, parseSeriesResource, parseSeriesCards, parseSeriesBrowseCards, parseRecentEpisodeCards,
  parseEpisodeList, seriesBrowseUrl, catalogManifest, createSeriesService
} = require('./series-catalog.js');

test('series catalogue advertises three rankings plus latest episodes', () => {
  assert.equal(PAGE_SIZE, 5);
  assert.equal(catalogDefinitions.length, 4);
  assert.equal(new Set(catalogDefinitions.map(i => i.id)).size, 4);
  assert.equal(catalogManifest().length, 5);
  assert(catalogManifest().every(item =>
    item.type === 'series' && item.extra.some(extra => extra.name === 'skip')));
});

test('catalogue URLs preserve skip and genre, dubbed-only catalog is absent', () => {
  const latest = parseSeriesCatalogPath('/catalog/series/bombuj-series-latest/skip=10.json');
  assert.equal(latest.id,'bombuj-series-all');
  assert.equal(latest.skip, 10);
  assert.equal(latest.sort, 'id');
  assert.equal(Math.floor(latest.skip / PAGE_SIZE) + 1, 3);
  const genre = parseSeriesCatalogPath('/catalog/series/bombuj-series-all/genre=Ak%C4%8Dn%C3%AD&skip=5.json');
  assert.equal(genre.dubbed, false);
  assert.equal(genre.genre, 'Akční');
  assert.equal(genre.skip, 5);
  assert.equal(parseSeriesCatalogPath('/catalog/series/bombuj-series-dubbed.json'), null);
  assert.equal(parseSeriesCatalogPath('/catalog/movie/bombuj-movies.json'), null);
});

test('series and episode ids map to Stremio resources', () => {
  assert.equal(seriesId('visionquest-2026'), 'bombuj-series-visionquest-2026');
  assert.equal(seriesId('../../etc'), null);
  assert.equal(slugFromUrl('https://serialy.bombuj.si/serial-visionquest-2026'), 'visionquest-2026');
  assert.deepEqual(parseSeriesResource('/stream/series/bombuj-series-visionquest-2026:1:2.json'), {
    resource:'stream', id:'bombuj-series-visionquest-2026', slug:'visionquest-2026', season:1, episode:2
  });
  assert.equal(parseSeriesResource('/meta/movie/bombuj-series-visionquest-2026.json'), null);
});

test('series list parser keeps deduplicated titles and poster URLs from Bombuj HTML', () => {
  const html = [
    '<a href="/serial-visionquest-2026"><img src="https://www.bombuj.si/images/covers/all/visionquest.jpg"></a>',
    '<a href="/serial-visionquest-2026">VisionQuest</a> 2026 - USA',
    '<a href="/serial-carrie-2026"><span>Carrie</span></a> 2026 - USA'
  ].join('\n');
  const cards=parseSeriesCards(html);
  assert.equal(cards.length,2);
  assert.equal(cards[0].slug,'visionquest-2026');
  assert.equal(cards[0].title,'VisionQuest');
  assert.match(cards[0].poster,/www\.bombuj\.si\/images\/covers/);
  assert.equal(cards[1].title,'Carrie');
});

test('episode parser records season, episode and language without duplicates', () => {
  const html = [
    '<a href="/serial/visionquest-2026-1x1"><span>Epizóda 1x1</span><div style="float:right">CZ</div></a>',
    '<a href="/serial/visionquest-2026-1x1">Duplicate</a>',
    '<a href="/serial/visionquest-2026-1x2">Epizóda 1x2 EN + tit</a>',
    '<a href="/serial/carrie-2026-1x1">Different show</a>',
    '<a href="/serial/visionquest-2026-2x1">Different season</a>'
  ].join('\n');
  const found=parseEpisodeList(html,1,'visionquest-2026');
  assert.equal(found.length,2);
  assert.deepEqual(found.map(x=>x.episode),[1,2]);
  assert.match(found[0].language,/CZ/);
  assert.match(found[1].language,/titulky/);
});

test('series resource responds with actual episodes and dynamically resolved sources',async()=>{
  const requests=[];
  const mockFetch=async (url)=>{
    requests.push(url);
    if(url.endsWith('/serial-visionquest-2026'))
      return '<h1>VisionQuest (2026)</h1><meta property="og:image" content="https://www.bombuj.si/images/covers/all/visionquest.jpg">';
    if(url.includes('ajax2.php') && url.includes('seria=1'))
      return '<a href="/serial/visionquest-2026-1x1">Epizóda 1x1 CZ</a>'+
        '<a href="/serial/visionquest-2026-1x2">Epizóda 1x2 EN + tit</a>';
    if(url.includes('ajax2.php') && url.includes('seria=2'))
      return '<a href="/serial/visionquest-2026-2x1">Epizóda 2x1 CZ</a>';
    if(url.includes('ajax2.php'))return '';
    throw new Error('Unexpected request '+url);
  };
  const core={
    discoverBombujPlayers: async (url)=>[{url,provider:'VOE',language:'CZ',resolvedUrl:'https://voe.sx/e/test'}],
    playersToStreams: async ()=>[{name:'Bombuj • VOE',externalUrl:'https://voe.sx/e/test'}]
  };
  const service=createSeriesService({fetchText:mockFetch,core,log:{log(){},warn(){}}});
  const res=await service.meta('visionquest-2026');
  assert.equal(res.meta.type,'series');
  assert.equal(res.meta.name,'VisionQuest');
  assert.deepEqual(res.meta.videos.map(v=>v.id),[
    'bombuj-series-visionquest-2026:1:1',
    'bombuj-series-visionquest-2026:1:2',
    'bombuj-series-visionquest-2026:2:1'
  ]);
  const stream=await service.streams('visionquest-2026',1,1);
  assert.equal(stream.streams.length,1);
  assert.equal(stream.streams[0].externalUrl,'https://voe.sx/e/test');
  assert(requests.some(url=>url.includes('/epizody/ajax2.php')));
});

test('homepage recent episode feed generates deduplicated series cards', () => {
  const html = [
    '<a href="/serial-visionquest-2026">VisionQuest</a>',
    '<a href="/serial/visionquest-2026-1x1">Epizóda 1x1 CZ</a>',
    '<a href="/serial/visionquest-2026-1x2">Epizóda 1x2 CZ</a>',
    '<a href="/serial-carrie-2026">Carrie</a>',
    '<a href="/serial/carrie-2026-1x1">Epizóda 1x1 CZ</a>'
  ].join('');
  const cards=parseRecentEpisodeCards(html);
  assert.deepEqual(cards.map(item=>item.slug),['visionquest-2026','visionquest-2026','carrie-2026']);
  assert.deepEqual(cards.map(item=>item.title),['VisionQuest','VisionQuest','Carrie']);
  assert.deepEqual(cards.map(item=>item.id),[
    'bombuj-episode-visionquest-2026-1x1',
    'bombuj-episode-visionquest-2026-1x2',
    'bombuj-episode-carrie-2026-1x1'
  ]);
  const feed=parseSeriesCatalogPath('/catalog/series/bombuj-series-new-episodes/skip=12.json');
  assert.equal(feed.mode,'episodes');
  assert.equal(feed.skip,12);
});

test('main catalogue excludes header and sidebar links instead of displacing real shows', () => {
  const html = [
    '<header><a href="/serial-game-of-thrones-2011">Game of Thrones</a></header>',
    '<main>',
    '<a href="/serial-visionquest-2026"><img src="/images/covers/visionquest.jpg"></a>',
    '<a href="/serial-visionquest-2026">VisionQuest</a>',
    '<div>2026 - USA<br>Režisér: Jane Doe<br>Herci: Someone</div>',
    '<a href="/serial-carrie-2026">Carrie</a>',
    '<div>2026 - USA<br>Režisér: John Doe<br>Herci: Somebody</div>',
    '</main>',
    '<aside><a href="/serial-the-big-bang-theory">The Big Bang Theory</a></aside>'
  ].join('');
  const results=parseSeriesCards(html,{verifiedCatalog:true});
  assert.deepEqual(results.map(x=>x.title),['VisionQuest','Carrie']);
  assert.equal(results[0].year,'2026');
  assert.match(results[0].poster,/covers\/visionquest/);
});

test('latest dubbed series use Bombuj sorting dropdown dab=1', () => {
  const actual = new URL(seriesBrowseUrl({page:1,sort:'id',genre:'all',dubbed:true}));
  assert.equal(actual.pathname, '/zoznam-serialov/podla-zanru/index.php');
  assert.equal(actual.searchParams.get('dab'), '1');
  assert.equal(actual.searchParams.get('nazov'), '1');
  assert.equal(actual.searchParams.get('page'), '1');
  assert.equal(actual.searchParams.get('sort'), 'id');
  assert.equal(actual.searchParams.get('zaner'), 'all');
});

test('recent episodes use show heading even if it appears after the episode', () => {
  const html=[
    '<a href="/serial/visionquest-2026-1x1">Epizóda 1x1 CZ</a>',
    '<a class="heading" href="/serial-visionquest-2026">VisionQuest</a>',
    '<a href="/serial/carrie-2026-1x2">Epizóda 1x2 CZ</a>',
    '<a href="/serial-carrie-2026"><span>Carrie</span></a>'
  ].join('');
  const cards=parseRecentEpisodeCards(html);
  assert.deepEqual(cards.map(c=>c.title), ['VisionQuest','Carrie']);
});

test('full series catalogue uses the real filtered ZOZNAM SERIÁLOV page, not homepage', () => {
  const path=seriesBrowseUrl({page:1,sort:'id',genre:'all',dubbed:false});
  assert.equal(new URL(path).pathname,'/zoznam-serialov/podla-zanru/index.php');
  const second=new URL(seriesBrowseUrl({page:2,sort:'id',genre:'all',dubbed:false}));
  assert.equal(second.pathname,'/zoznam-serialov/podla-zanru/index.php');
  assert.equal(second.searchParams.get('page'),'2');
  const main=parseSeriesCatalogPath('/catalog/series/bombuj-series-all/skip=5.json');
  assert.equal(main.id,'bombuj-series-all');
  assert.equal(main.skip,5);
  assert.equal(catalogManifest().some(c=>c.id==='bombuj-series-popular'),false);
});

test('new episodes have unique meta ids and their own episode-specific videos', async () => {
  const html=[
    '<a href="/serial-visionquest-2026">VisionQuest</a>',
    '<a href="/serial/visionquest-2026-1x1">Epizóda 1x1 CZ</a>',
    '<a href="/serial/visionquest-2026-1x2">Epizóda 1x2 EN + tit</a>'
  ].join('');
  const fetchText=async url=>{
    if(url.includes('index.php?page=1&type=1'))return html;
    if(url.endsWith('/serial-visionquest-2026'))return '<h1>VisionQuest</h1>';
    throw new Error('Unexpected URL: '+url);
  };
  const service=createSeriesService({fetchText,core:{},log:{log(){},warn(){}}});
  const result=await service.catalogue(
    parseSeriesCatalogPath('/catalog/series/bombuj-series-new-episodes.json'));
  assert.equal(result.metas.length,2);
  assert.deepEqual(result.metas.map(m=>m.name),['VisionQuest – 1×1','VisionQuest – 1×2']);
  assert.deepEqual(result.metas.map(m=>m.id),[
    'bombuj-episode-visionquest-2026-1x1',
    'bombuj-episode-visionquest-2026-1x2'
  ]);
  const id=episodeId('visionquest-2026',1,2);
  assert.deepEqual(parseEpisodeMetaPath('/meta/series/'+id+'.json'),{
    slug:'visionquest-2026',season:1,episode:2
  });
  const meta=await service.episodeMeta('visionquest-2026',1,2);
  assert.equal(meta.meta.id,id);
  assert.equal(meta.meta.videos[0].id,'bombuj-series-visionquest-2026:1:2');
  assert.equal(meta.meta.videos[0].episode,2);
});

test('episode language filter is handled by real Bombuj type parameter', async () => {
  let visited='';
  const service=createSeriesService({
    fetchText:async url=>{visited=url;return '';},
    core:{},log:{log(){},warn(){}}
  });
  await service.catalogue(parseSeriesCatalogPath(
    '/catalog/series/bombuj-series-new-episodes/genre=S%20dabingem.json'));
  assert.match(visited,/type=3/);
});


test('official browse listing excludes even plausible full-card homepage recommendations', () => {
  const fakeRecommendation = (slug,title) =>
    '<aside><a href="/serial-'+slug+'">'+title+'</a>' +
    '<span>2026 - USA Režisér: Example Herci: Actor</span></aside>';
  const realCard = (slug,title,year) =>
    '<article><a href="https://youtube.com/watch?v=abc">TRAILER</a>'+
    '<a href="/serial-'+slug+'"><img src="/images/covers/'+slug+'.jpg"></a>'+
    '<a href="/serial-'+slug+'">'+title+'</a>'+
    '<div>'+year+' - USA</div><p>Režisér: Example<br>Herci: Example</p></article>';
  const html = [
    fakeRecommendation('visionquest-2026','VisionQuest'),
    fakeRecommendation('carrie-2026','Carrie'),
    fakeRecommendation('marshals-2026','Marshals'),
    realCard('krasa-2026','The Beauty',2026),
    realCard('gentlemani-2024','The Gentlemen',2024),
    realCard('american-horror-story','American Horror Story',2011),
    realCard('lizzie-borden-story-2026','The Lizzie Borden Story',2026),
    realCard('mobland-2025','MobLand',2025)
  ].join('\n');
  const result=parseSeriesBrowseCards(html);
  assert.deepEqual(result.map(x=>x.title),[
    'The Beauty','The Gentlemen','American Horror Story',
    'The Lizzie Borden Story','MobLand'
  ]);
  assert.equal(result.length, PAGE_SIZE);
});

test('catalogue parser fallback excludes top recommendations when trailer buttons are absent', () => {
  const item=(slug,title)=>'<a href="/serial-'+slug+'">'+title+
    '</a><div>2026 - USA<br>Režisér: Doe<br>Herci: Actor</div>';
  const html=[
    item('visionquest-2026','VisionQuest'),
    item('carrie-2026','Carrie'),
    item('marshals-2026','Marshals'),
    item('krasa-2026','The Beauty'),
    item('gentlemani-2024','The Gentlemen'),
    item('american-horror-story','American Horror Story'),
    item('lizzie-borden-story-2026','The Lizzie Borden Story'),
    item('mobland-2025','MobLand')
  ].join('\n');
  const result=parseSeriesBrowseCards(html);
  assert.deepEqual(result.map(x=>x.title),[
    'The Beauty','The Gentlemen','American Horror Story',
    'The Lizzie Borden Story','MobLand'
  ]);
});

test('all three series sorting categories match website dropdown values', () => {
  const expected=[
    ['bombuj-series-all','id',false],
    ['bombuj-series-best-rated','hodnotenie',false],
    ['bombuj-series-most-watched','views',false]
  ];
  for (const [id, sort, dubbed] of expected) {
    const catalog=parseSeriesCatalogPath('/catalog/series/'+id+'.json');
    assert.equal(catalog.sort,sort);
    assert.equal(catalog.dubbed,dubbed);
    const url=new URL(seriesBrowseUrl(catalog));
    assert.equal(url.searchParams.get('sort'),sort);
    assert.equal(url.searchParams.get('dab'),dubbed?'1':'');
  }
  assert.equal(parseSeriesCatalogPath('/catalog/series/bombuj-series-popular.json').id,
    'bombuj-series-most-watched');
  assert.equal(catalogManifest().filter(c=>!['bombuj-series-new-episodes','bombuj-series-search'].includes(c.id)).length,3);
  assert(catalogManifest().filter(c=>c.id!=='bombuj-series-search').every(c=>c.extra.some(x=>x.name==='genre')));
});

test('year-based series catalog is not exposed', () => {
  assert.equal(parseSeriesCatalogPath('/catalog/series/bombuj-series-by-year.json'), null);
  assert.equal(catalogManifest().some(c => c.id === 'bombuj-series-by-year'), false);
});

test('episode streams retain separate CZ dabing and EN subtitle provider rows', async () => {
  const service = createSeriesService({
    fetchText: async url => url.includes('/epizody/ajax2.php')
      ? '<a href="/serial/carrie-2026-1x1">Epizóda 1x1 CZ</a>' : '',
    core: {
      discoverBombujPlayers: async () => [
        {provider:'streamtape.com', language:'CZ dabing',resolvedUrl:'https://streamtape.com/e/real'},
        {provider:'vidlink', language:'EN dab/tit',resolvedUrl:'https://vidlink.pro/tv/1/1/1'}
      ],
      playersToStreams: async players => [
        {name:'Bombuj • streamtape.com', description:'CZ dabing • externí player',externalUrl:'https://streamtape.com/e/real'},
        {name:'Bombuj • vidlink', description:'EN dab/tit • externí player',externalUrl:'https://vidlink.pro/tv/1/1/1'},
        {name:'Bombuj • vidlink', description:'EN dab/tit • externí player',externalUrl:'https://vidlink.pro/tv/1/1/1'}
      ]
    },
    log:{log(){},warn(){}}
  });
  const result=await service.streams('carrie-2026',1,1);
  assert.deepEqual(result.streams.map(x=>x.name),['Bombuj • streamtape.com','Bombuj • vidlink']);
  assert.match(result.streams[0].description,/CZ dabing/);
  assert.match(result.streams[1].description,/EN dab\/tit/);
});

test('removing dubbed catalogue does not remove individual audio labels', () => {
  const ids=catalogManifest().map(c=>c.id);
  assert.deepEqual(ids,[
    'bombuj-series-all',
    'bombuj-series-best-rated',
    'bombuj-series-most-watched',
    'bombuj-series-new-episodes',
    'bombuj-series-search'
  ]);
  assert(!ids.includes('bombuj-series-dubbed'));
  assert(catalogManifest().find(c=>c.id==='bombuj-series-new-episodes')
    .extra.some(x=>x.name==='genre' && x.options.includes('S dabingem')));
});

test('only one required Bombuj series search row is advertised', () => {
  const manifest=catalogManifest();
  const searches=manifest.filter(c=>c.extra.some(extra=>extra.name==='search'));
  assert.deepEqual(searches.map(s=>s.id),['bombuj-series-search']);
  assert.equal(searches[0].name,'🔎 Bombuj – Hledat seriály');
  assert.deepEqual(searches[0].extra,[{name:'search',isRequired:true},{name:'skip'}]);
  assert(manifest.filter(c=>c.id!=='bombuj-series-search').every(c=>
    c.extra.every(e=>e.name!=='search')));
  const path=parseSeriesCatalogPath('/catalog/series/bombuj-series-search/search=hope.json');
  assert.equal(path.mode,'search');
  assert.equal(path.search,'hope');
});

test('series searching uses only the dedicated search route and skips empty requests', async () => {
  const requested=[];
  const service=createSeriesService({
    fetchText: async (url,init={})=>{
      requested.push({url,init});
      if(url.endsWith('4154q37rpc4dsvbp.php'))
        return '<a href="/serial-saving-hope-2012"><span>Saving Hope</span></a>';
      return '<a href="/serial-other-2025">Different</a>';
    },
    core:{},
    log:{log(){},warn(){}}
  });
  const search=parseSeriesCatalogPath('/catalog/series/bombuj-series-search/search=hope.json');
  const result=await service.catalogue(search);
  assert.deepEqual(result.metas.map(x=>x.name),['Saving Hope']);
  assert.equal(requested.length,1);
  assert.match(requested[0].url,/4154q37rpc4dsvbp\.php/);
  assert.equal(requested[0].init.method,'POST');
  const empty=await service.catalogue(parseSeriesCatalogPath('/catalog/series/bombuj-series-search.json'));
  assert.deepEqual(empty,{metas:[]});
  const legacy=await service.catalogue(parseSeriesCatalogPath('/catalog/series/bombuj-series-best-rated/search=hope.json'));
  assert.deepEqual(legacy,{metas:[]});
  assert.equal(requested.length,1);
});


test('search HTML title is not polluted by year, country or genre', () => {
  const html='<div class="cele_hladanie"><div class="cele_a">'+
    '<a href="//serialy.bombuj.si/serial-chicago-hope#serial">'+
    '<span class="nazov">Chicago Hope - Nemocnice Chicago Ho...</span>'+
    '<span class="zanre">1994 - USA</span>'+
    '<span class="zanre">Žáner: Drama</span></a></div></div>'+
    '<div class="cele_hladanie"><div class="cele_a">'+
    '<a href="//serialy.bombuj.si/serial-saving-hope#serial">'+
    '<span class="nazov">Saving Hope - Saving Hope</span>'+
    '<span class="zanre">2012 - Kanada</span>'+
    '<span class="zanre">Žáner: Drama / Fantasy</span></a></div></div>';
  const cards=parseSeriesCards(html);
  assert.deepEqual(cards.map(x=>x.title),['Chicago Hope','Saving Hope']);
  assert.deepEqual(cards.map(x=>x.year),['1994','2012']);
  assert.deepEqual(cards.map(x=>x.alternateTitles),[[],['Saving Hope']]);
});

test('older series fallback to show detail when AJAX lists no episodes',async()=>{
  const seen=[];
  const page='<h1>Chicago Hope</h1>'+
    '<a href="//serialy.bombuj.si/serial/chicago-hope-1x1">Epizoda 1 CZ</a>'+
    '<a href="//serialy.bombuj.si/serial/american-horror-story-13x8">Unrelated</a>';
  const service=createSeriesService({
    fetchText:async (url)=>{
      seen.push(url);
      if(url.includes('/epizody/ajax2.php'))
        return '<div class="scrollbar"><div class="seria">Séria 1.</div></div>';
      if(url.endsWith('/serial-chicago-hope')) return page;
      throw Error('Unexpected '+url);
    },
    core:{
      discoverBombujPlayers:async()=>[{provider:'voe.sx',resolvedUrl:'https://voe.sx/e/sample'}],
      playersToStreams:async()=>[{name:'Bombuj VOE',externalUrl:'https://voe.sx/e/sample'}]
    },log:{log(){},warn(){}}
  });
  const stream=await service.streams('chicago-hope',1,1);
  assert.equal(stream.streams.length,1);
  const meta=await service.meta('chicago-hope');
  assert.deepEqual(meta.meta.videos.map(v=>v.id),['bombuj-series-chicago-hope:1:1']);
  assert.equal(seen.filter(url=>url.endsWith('/serial-chicago-hope')).length,1);
  assert.equal(meta.meta.videos.some(v=>v.season===13),false);
});
test('manifest uses Sosáč-style emojis for each Bombuj series category',()=>{
  assert.deepEqual(catalogManifest().map(x=>x.name),[
    '🆕 Bombuj – Nejnovější seriály',
    '⭐ Bombuj – Nejlépe hodnocené seriály',
    '🔥 Bombuj – Nejsledovanější seriály',
    '🆕 Bombuj – Nejnovější epizody',
    '🔎 Bombuj – Hledat seriály'
  ]);
});
