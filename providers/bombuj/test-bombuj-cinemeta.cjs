'use strict';

const assert = require('node:assert/strict');
const {test} = require('node:test');
const {
  movieImdbId, seriesImdbId, fetchCinemetaById, mergeCinemeta,
  cinemetaEpisodeTitle, enrichCinemetaSeries, enrichCinemetaEpisode,
  seriesSearchName, selectCinemetaSeriesCandidate, sharedCinemetaSeriesCatalogMeta
} = require('./bombuj-cinemeta.js');
const {createSeriesService} = require('./series-catalog.js');

test('extract exact movie IMDb ID from Bombuj AJAX player configuration',()=>{
  const html="<script>$.ajax({url:'prehravace_ajax.php',data: { url: 'na-hrane-smrti-2-deadpoint-2026', imdb_id: 'tt31192372', tmdb_id:'1101412'}});</script>";
  assert.equal(movieImdbId(html),'tt31192372');
  assert.equal(movieImdbId("No known imdb id"),null);
  assert.equal(movieImdbId("imdb_id:'tt31192372'; imdb_id:'tt27369017'"),null);
});

test('series IMDb ID comes from actual episode player wrapper iid and never from a sidebar',()=>{
  const html=[
    '<a href="/serial-irrelevant"><script>const iid="tt99999999"</script></a>',
    '<div class="accordion-menu"><div class="dropdownlink">EN dab/tit</div>',
    '<ul><li link="//serialy.bombuj.si/serial/prehravace_final/vidsrc.php?iid=tt11540908&amp;se=1&amp;ep=1"><a>vidsrc</a></li>',
    '<li link="//serialy.bombuj.si/serial/prehravace_final/vidlink.php?iid=tt11540908&amp;se=1&amp;ep=1"><a>vidlink</a></li></ul></div>'
  ].join('');
  assert.equal(seriesImdbId(html),'tt11540908');
  assert.equal(seriesImdbId('<span>iid=tt11540908</span>'),null);
  assert.equal(seriesImdbId('<div class="dropdownlink">EN</div><ul>'+
    '<li link="//serialy.bombuj.si/vidsrc.php?iid=tt11540908"><a>1</a></li>'+
    '<li link="//serialy.bombuj.si/vidsrc.php?iid=tt99999999"><a>2</a></li></ul>'),null);
});

test('Cinemeta exact ID check rejects mismatched metadata and invalid types',async()=>{
  const seen=[];
  const fetchJson=async url=>{seen.push(url);return {meta:{id:'tt31192372',type:'movie',name:'Fall 2: Deadpoint'}};};
  assert.equal((await fetchCinemetaById('movie','tt31192372',fetchJson)).name,'Fall 2: Deadpoint');
  assert.equal(seen[0],'https://v3-cinemeta.strem.io/meta/movie/tt31192372.json');
  assert.equal(await fetchCinemetaById('series','tt31192372',fetchJson),null);
  assert.equal(await fetchCinemetaById('movie','javascript:evil',fetchJson),null);
  assert.equal(await fetchCinemetaById('movie','tt12345678',fetchJson),null);
});

test('metadata enrichment preserves Czech titles, custom series IDs and Bombuj videos',()=>{
  const episodes=[
    {id:'bombuj-series-monstrum-pribeh-lizzie-borden:1:1',season:1,episode:1},
    {id:'bombuj-series-monstrum-pribeh-lizzie-borden:1:2',season:1,episode:2}
  ];
  const local={
    id:'bombuj-series-monstrum-pribeh-lizzie-borden',type:'series',
    name:'The Lizzie Borden Story',videos:episodes,poster:'https://bombuj.si/old.jpg'
  };
  const remote={
    id:'tt13207736',type:'series',name:'Monster',poster:'https://cinemeta.example/poster.jpg',
    description:'Anthology',imdbRating:'7.5',genres:['Crime'],runtime:'55 min',
    videos:[{id:'tt13207736:1:1',season:1,episode:1}]
  };
  const merged=mergeCinemeta(local,remote);
  assert.equal(merged.id,local.id);
  assert.equal(merged.name,local.name);
  assert.equal(merged.imdb_id,'tt13207736');
  assert.deepEqual(merged.videos,episodes);
  assert.equal(merged.poster,remote.poster);
  assert.equal(merged.description,remote.description);
  assert.equal(merged.imdbRating,'7.5');
  assert.equal(local.description,undefined);
});

test('first episode lookup uses Bombuj AJAX and preserves original player URL',async()=>{
  const seen=[];
  const service=createSeriesService({
    fetchText:async (url)=>{
      seen.push(url);
      if(url.includes('seria=1'))return '<a href="/serial/carrie-2026-1x3">Epizóda 1×3 CZ</a>'+
        '<a href="/serial/carrie-2026-1x1">Epizóda 1×1 EN</a>';
      throw Error('Unexpected '+url);
    },
    core:{},log:{log(){},warn(){}}
  });
  assert.equal(await service.firstEpisodeUrl('carrie-2026'),
    'https://serialy.bombuj.si/serial/carrie-2026-1x1');
  assert.equal(seen.length,1);
});

test('different anthology season year preserves Bombuj synopsis, poster and local videos',()=>{
  const source={
    id:'bombuj-series-monstrum-pribeh-lizzie-borden',
    type:'series',name:'The Lizzie Borden Story',
    releaseInfo:'2026',poster:'https://bombuj.si/lizzie.jpg',
    description:'Lizzie Borden season',
    videos:[{id:'bombuj-series-monstrum-pribeh-lizzie-borden:1:1'}]
  };
  const cinema={
    id:'tt13207736',type:'series',name:'Monster',releaseInfo:'2022–',
    description:'Story of a different Monster season',poster:'https://cinemeta.example/monster.jpg',
    videos:[{id:'tt13207736:1:1'}]
  };
  const result=mergeCinemeta(source,cinema);
  assert.equal(result.imdb_id,'tt13207736');
  assert.equal(result.id,source.id);
  assert.equal(result.name,source.name);
  assert.equal(result.releaseInfo,'2026');
  assert.equal(result.poster,source.poster);
  assert.equal(result.description,source.description);
  assert.deepEqual(result.videos,source.videos);
});

test('movie localized year difference still trusts exact IMDb ID',()=>{
  const source={id:'tt33400719',type:'movie',name:'Podivná sklizeň',releaseInfo:'2024'};
  const cinema={id:'tt33400719',type:'movie',name:'Strange Harvest',
    description:'Cinema details',releaseInfo:'2025',poster:'https://cinemeta.example/poster.jpg'};
  const result=mergeCinemeta(source,cinema);
  assert.equal(result.name,'Podivná sklizeň');
  assert.equal(result.imdb_id,source.id);
  assert.equal(result.description,'Cinema details');
  assert.equal(result.releaseInfo,'2025');
});

test('latest episode gets the Cinemeta poster and real title, but keeps Bombuj ID',()=>{
  const local={
    id:'bombuj-episode-carrie-2026-1x1',type:'series',
    name:'Carrie – 1×1',releaseInfo:'2026',poster:'https://bombuj.si/card.jpg',
    videos:[{id:'bombuj-series-carrie-2026:1:1',season:1,episode:1,title:'Epizoda 1×1'}]
  };
  const cinemeta={
    id:'tt11540908',type:'series',name:'Carrie',releaseInfo:'2026',
    poster:'https://cinemeta.example/carrie-poster.jpg',
    videos:[
      {id:'tt11540908:1:1',season:1,episode:1,title:'Pilot'},
      {id:'tt11540908:1:2',season:1,episode:2,title:'The Second Episode'}
    ]
  };
  const result=enrichCinemetaEpisode(local,cinemeta,1,1);
  assert.equal(result.name,'Carrie – 1×1 – Pilot');
  assert.equal(result.poster,cinemeta.poster);
  assert.equal(result.imdb_id,cinemeta.id);
  assert.equal(result.id,local.id);
  assert.equal(result.videos[0].id,local.videos[0].id);
  assert.equal(result.videos[0].title,'Pilot');
  assert.equal(local.videos[0].title,'Epizoda 1×1');
});

test('series episode list enriches titles only for exact season and episode',()=>{
  const local={
    id:'bombuj-series-carrie-2026',type:'series',name:'Carrie',releaseInfo:'2026',
    videos:[
      {id:'bombuj-series-carrie-2026:1:1',season:1,episode:1,title:'Epizoda 1×1'},
      {id:'bombuj-series-carrie-2026:1:2',season:1,episode:2,title:'Epizoda 1×2'},
      {id:'bombuj-series-carrie-2026:2:1',season:2,episode:1,title:'Epizoda 2×1'}
    ]
  };
  const remote={
    id:'tt11540908',type:'series',releaseInfo:'2026',
    videos:[
      {id:'tt11540908:1:1',season:1,episode:1,title:'Pilot'},
      {id:'tt11540908:1:2',season:1,episode:2,title:'Episode 2'},
      {id:'tt11540908:1:3',season:1,episode:3,title:'Episode 3'}
    ]
  };
  const result=enrichCinemetaSeries(local,remote);
  assert.deepEqual(result.videos.map(v=>v.title),['Pilot','Epizoda 1×2','Epizoda 2×1']);
  assert.deepEqual(result.videos.map(v=>v.id),local.videos.map(v=>v.id));
  assert.equal(cinemetaEpisodeTitle(remote,1,2),null);
  assert.equal(cinemetaEpisodeTitle(remote,2,1),null);
});


test('real Cinemeta video format supplies series episode names by season and number', () => {
  const bombuj = {
    id:'bombuj-series-crystal-lake-2026',type:'series',name:'Crystal Lake',releaseInfo:'2026',
    videos:[
      { id:'bombuj-series-crystal-lake-2026:1:1',season:1,episode:1,title:'Epizoda 1×1' },
      { id:'bombuj-series-crystal-lake-2026:1:2',season:1,episode:2,title:'Epizoda 1×2' },
      { id:'bombuj-series-crystal-lake-2026:2:1',season:2,episode:1,title:'Epizoda 2×1' }
    ]
  };
  const cinemeta = {
    id:'tt23148340',type:'series',releaseInfo:'2026–',poster:'https://cdn.test/crystal.jpg',
    videos:[
      {id:'tt23148340:1:1',season:1,number:1,name:'Camp Crystal'},
      {id:'tt23148340:1:2',season:1,number:2,name:'Part 2'},
      {id:'tt23148340:1:3',season:1,number:3,name:'Part III'}
    ]
  };
  const enriched = enrichCinemetaSeries(bombuj, cinemeta);
  assert.deepEqual(enriched.videos.map(v=>v.title), ['Camp Crystal','Part 2','Epizoda 2×1']);
  assert.deepEqual(enriched.videos.map(v=>v.id), bombuj.videos.map(v=>v.id));
  assert.equal(enriched.poster,cinemeta.poster);
  assert.equal(enriched.imdb_id,'tt23148340');
  const individual = enrichCinemetaEpisode({
    id:'bombuj-episode-crystal-lake-2026-1x1',type:'series',
    name:'Crystal Lake – 1×1',releaseInfo:'2026',
    videos:[bombuj.videos[0]]
  },cinemeta,1,1);
  assert.equal(individual.name,'Crystal Lake – 1×1 – Camp Crystal');
  assert.equal(individual.videos[0].title,'Camp Crystal');
  assert.equal(individual.videos[0].id,bombuj.videos[0].id);
});

test('Cinemeta name/number and title/episode variants reject placeholder titles and wrong episodes', () => {
  const meta={videos:[
    {season:1,number:1,name:'Episode 1',title:'Real Pilot'},
    {season:1,number:2,name:'Epizoda 1×2'},
    {season:1,episode:3,title:'Part III'},
    {season:2,number:1,name:'A New Chapter'}
  ]};
  assert.equal(cinemetaEpisodeTitle(meta,1,1),'Real Pilot');
  assert.equal(cinemetaEpisodeTitle(meta,1,2),null);
  assert.equal(cinemetaEpisodeTitle(meta,1,3),'Part III');
  assert.equal(cinemetaEpisodeTitle(meta,2,1),'A New Chapter');
  assert.equal(cinemetaEpisodeTitle(meta,2,2),null);
});

test('missing Cinemeta episode title keeps original, without dropping poster',()=>{
  const source={id:'bombuj-episode-carrie-2026-1x2',type:'series',name:'Carrie – 1×2',
    releaseInfo:'2026',poster:'https://bombuj.si/poster.jpg'};
  const remote={id:'tt11540908',type:'series',releaseInfo:'2026',
    poster:'https://cinemeta.example/poster.jpg',videos:[]};
  const result=enrichCinemetaEpisode(source,remote,1,2);
  assert.equal(result.name,source.name);
  assert.equal(result.poster,remote.poster);
});

test('anthology year mismatch cannot assign unrelated episode titles or poster',()=>{
  const source={id:'bombuj-episode-monster-lizzie-2026-1x1',type:'series',
    name:'The Lizzie Borden Story – 1×1',releaseInfo:'2026',
    poster:'https://bombuj.si/lizzie.jpg',
    videos:[{id:'bombuj-series-monster-lizzie-2026:1:1',season:1,episode:1,
      title:'Epizoda 1×1'}]};
  const remote={id:'tt13207736',type:'series',releaseInfo:'2022',
    poster:'https://cinemeta.example/monster.jpg',
    videos:[{id:'tt13207736:1:1',season:1,episode:1,title:'Unrelated pilot'}]};
  const result=enrichCinemetaEpisode(source,remote,1,1);
  assert.equal(result.name,source.name);
  assert.equal(result.poster,source.poster);
  assert.deepEqual(result.videos,source.videos);
  assert.equal(result.imdb_id,remote.id);
});


test('Bombuj series catalogue uses verified IMDb ID for independent Sosac/SKTOnline addons', () => {
  const source = {
    id:'bombuj-series-ted-lasso',type:'series',name:'Ted Lasso',
    releaseInfo:'2020',poster:'https://serialy.bombuj.si/ted.jpg'
  };
  const remote = {
    id:'tt10986410',type:'series',name:'Ted Lasso',releaseInfo:'2020–',
    poster:'https://cinemeta.example/ted.jpg'
  };
  const result=sharedCinemetaSeriesCatalogMeta(source,remote);
  assert.equal(result.id,'tt10986410');
  assert.equal(result.imdb_id,'tt10986410');
  assert.equal(result.name,'Ted Lasso');
  assert.equal(result.poster,remote.poster);
  assert.equal(source.id,'bombuj-series-ted-lasso');
  assert.equal(sharedCinemetaSeriesCatalogMeta(source,null).id,source.id);
  assert.equal(sharedCinemetaSeriesCatalogMeta(source,{...remote,id:'wrong'}).id,source.id);
});

test('Bombuj anthology seasons with incompatible years preserve their source ID',()=>{
  const source = {id:'bombuj-series-monster-lizzie-2026',type:'series',
    name:'The Lizzie Borden Story',releaseInfo:'2026',poster:'https://bombuj.si/season.jpg'};
  const remote = {id:'tt13207736',type:'series',name:'Monster',releaseInfo:'2022–',
    poster:'https://cinemeta.example/old-series.jpg'};
  const result = sharedCinemetaSeriesCatalogMeta(source,remote);
  assert.equal(result.id,source.id);
  assert.equal(result.poster,source.poster);
  assert.equal(result.imdb_id,remote.id);
});

test('all series catalogues can match Cinemeta using exact title and year',()=>{
  const metas=[
    {id:'tt11111222',type:'series',name:'Vision Quest',releaseInfo:'2026',poster:'https://cinemeta/poster'},
    {id:'tt22222333',type:'series',name:'Vision Quest',releaseInfo:'2010'},
    {id:'tt33333444',type:'series',name:'Vision Quest: The Movie',releaseInfo:'2026'}
  ];
  const selected=selectCinemetaSeriesCandidate(metas,'VisionQuest','2026');
  assert.equal(selected?.id,'tt11111222');
  assert.equal(selectCinemetaSeriesCandidate(metas,'VisionQuest','2010')?.id,'tt22222333');
  assert.equal(selectCinemetaSeriesCandidate(metas,'Vision','2026'),null);
  assert.equal(selectCinemetaSeriesCandidate(metas,'VisionQuest','2020'),null);
  assert.equal(seriesSearchName('Marshals (2. Séria)'),'Marshals');
});

test('ambiguous catalog results are not confused with each other',()=>{
  const results=[
    {id:'tt11111222',name:'Carrie',type:'series'},
    {id:'tt22222333',name:'Carrie',type:'series'}
  ];
  assert.equal(selectCinemetaSeriesCandidate(results,'Carrie','2026'),null);
  assert.equal(selectCinemetaSeriesCandidate([{id:'tt11111222',name:'Carrie',type:'series'}],
    'Carrie','2026')?.id,'tt11111222');
});
