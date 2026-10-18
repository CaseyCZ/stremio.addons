'use strict';

const SITE = 'https://serialy.bombuj.si';
const PAGE_SIZE = 5; // Bombuj's /zoznam-serialov/podla-zanru/ shows five items per page.
const MAX_SEASON = 24;
const catalogDefinitions = Object.freeze([
  // Three ranked series catalogues plus the newest-episodes catalogue.
  { id: 'bombuj-series-all', name: '🆕 Bombuj – Nejnovější seriály', sort: 'id', genre: 'all', dubbed: false },
  { id: 'bombuj-series-best-rated', name: '⭐ Bombuj – Nejlépe hodnocené seriály', sort: 'hodnotenie', genre: 'all', dubbed: false },
  { id: 'bombuj-series-most-watched', name: '🔥 Bombuj – Nejsledovanější seriály', sort: 'views', genre: 'all', dubbed: false },
  // Individual episodes have their own metadata and episode IDs.
  { id: 'bombuj-series-new-episodes', name: '🆕 Bombuj – Nejnovější epizody', sort: 'id', genre: 'all', dubbed: false, mode: 'episodes' }
]);
const SEARCH_SERIES_CATALOG = Object.freeze({
  id: 'bombuj-series-search', name: '🔎 Bombuj – Hledat seriály',
  sort: 'id', genre: 'all', dubbed: false, mode: 'search'
});
const legacyCatalogAliases = Object.freeze({
  'bombuj-series-latest': 'bombuj-series-all',
  'bombuj-series-popular': 'bombuj-series-most-watched'
});

const genres = [
  'Akční', 'Komedie', 'Animovaný', 'Romantický', 'Horor', 'Thriller',
  'Sci-Fi', 'Drama', 'Krimi', 'Dokumentární', 'Dobrodružný', 'Rodinný',
  'Reality-TV', 'Fantasy', 'Životopisný', 'Mysteriózní', 'Sportovní',
  'Válečný', 'Historický', 'Psychologický', 'Western'
];

function cleanHtml(raw) {
  return String(raw || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'")
    .replace(/\s+/g, ' ').trim();
}

function absolute(raw, base = SITE) {
  try {
    const url = new URL(String(raw || '').replace(/&amp;/gi, '&'), base);
    return ['serialy.bombuj.si', 'www.bombuj.si'].includes(url.hostname) &&
      url.protocol === 'https:' ? url.toString() : '';
  } catch { return ''; }
}

function slugFromUrl(raw) {
  try {
    const path = new URL(raw, SITE).pathname;
    const match = path.match(/^\/serial-([a-z0-9-]+)\/?$/i);
    return match?.[1].toLowerCase() || null;
  } catch { return null; }
}

function seriesId(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug || '')) ?
    'bombuj-series-' + slug : null;
}

function parseSeriesResource(pathname) {
  const match = String(pathname || '').match(/^\/(meta|stream|subtitles)\/series\/(bombuj-series-([a-z0-9-]+))(?::(\d+):(\d+))?\.json$/i);
  if (!match) return null;
  return {
    resource: match[1].toLowerCase(), id: match[2].toLowerCase(),
    slug: match[3].toLowerCase(),
    season: match[4] === undefined ? null : Number(match[4]),
    episode: match[5] === undefined ? null : Number(match[5])
  };
}

function episodeId(slug, season, episode) {
  return seriesId(slug) && Number.isInteger(season) && season > 0 &&
    Number.isInteger(episode) && episode > 0
    ? 'bombuj-episode-' + slug + '-' + season + 'x' + episode
    : null;
}

function parseEpisodeMetaPath(pathname) {
  const match=String(pathname || '').match(/^\/meta\/series\/bombuj-episode-([a-z0-9-]+)-(\d+)x(\d+)\.json$/i);
  if (!match) return null;
  return {slug:match[1].toLowerCase(),season:Number(match[2]),episode:Number(match[3])};
}

function parseSeriesCatalogPath(pathname) {
  const match = String(pathname || '').match(/^\/catalog\/series\/([^/]+?)(?:\/([^/]+))?\.json$/i);
  if (!match) return null;
  const canonicalId = legacyCatalogAliases[match[1]] || match[1];
  const catalog = catalogDefinitions.find(item => item.id === canonicalId) ||
    (canonicalId === SEARCH_SERIES_CATALOG.id ? SEARCH_SERIES_CATALOG : null);
  if (!catalog) return null;
  const extra = new URLSearchParams(match[2] || '');
  const rawSkip = Number.parseInt(extra.get('skip') || '0', 10);
  return {
    ...catalog, genre: String(extra.get('genre') || catalog.genre),
    search: String(extra.get('search') || '').trim(),
    skip: Number.isFinite(rawSkip) ? Math.max(0, Math.min(100000, rawSkip)) : 0
  };
}

function parseSeriesCards(html, { verifiedCatalog = false } = {}) {
  const input = String(html || '');
  const links = [];
  const anchorPattern = /<a\b[^>]*href=["']([^"']*\/serial-[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of input.matchAll(anchorPattern)) {
    const url = absolute(match[1]);
    const slug = slugFromUrl(url);
    if (!slug) continue;
    // Search suggestions append "#serial" to an otherwise canonical show
    // page. Drop the client-side fragment before checking the URL against
    // source-identity's strict allow-list and remembering its IMDb mapping.
    const canonical = new URL(url);
    canonical.hash = '';
    links.push({ url: canonical.toString(), slug, index: match.index, end: match.index + match[0].length, inner: match[2] });
  }

  const cards = [];
  const seen = new Set();
  for (let i = 0; i < links.length;) {
    const first = links[i];
    let next = i + 1;
    while (next < links.length && links[next].slug === first.slug) next++;

    // A catalog result is a full movie-style card with metadata (year,
    // country, director / actors). Standalone links in the top slider,
    // navigation, sidebars and comments are not catalogue results.
    const until = next < links.length ? links[next].index : input.length;
    const block = input.slice(first.index, Math.min(until, first.index + 6500));
    const blockText = cleanHtml(block);
    const hasYear = /\b(?:19|20)\d{2}\s*[-–]\s*\S/.test(blockText);
    const hasCredits = /(?:Režis[eé]r|Herci|Hrajú)\s*:/i.test(blockText);
    const accepted = !verifiedCatalog || (hasYear && hasCredits);

    if (accepted && !seen.has(first.slug)) {
      const same = links.slice(i, next);
      const titles = same.map(link => cleanHtml(link.inner))
        .filter(value => value && value.length < 125 &&
          !/^\d+%$|^trailer$|^prehr[aá]t$/i.test(value));
      // Search suggestions have one anchor with several <span> elements.
      // Reading the whole anchor would append country, year and genre to
      // the series name, which breaks exact Cinemeta matching.
      const suggestion = same.map(link =>
        link.inner.match(/<span\b[^>]*class=["'][^"']*\bnazov\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1]
      ).find(Boolean);
      const rawTitle = suggestion ? cleanHtml(suggestion) :
        (titles.at(-1) || first.slug.replace(/-/g, ' '));
      const names = suggestion ? rawTitle.split(/\s+[-–—]\s+/) : [rawTitle];
      const title = names[0] || rawTitle;
      const alternateTitles = names.slice(1).filter(value =>
        value.length > 3 && !/(?:\.\.\.|…)$/.test(value));
      const year = blockText.match(/\b((?:19|20)\d{2})\s*[-–]\s*\S/)?.[1] ||
        first.slug.match(/(?:19|20)\d{2}/)?.[0] || null;
      const img = block.match(/<img\b[^>]*(?:data-src|src)=["']([^"']+)["']/i)?.[1] ||
        input.slice(Math.max(0,first.index-450),first.index)
          .match(/<img\b[^>]*(?:data-src|src)=["']([^"']+)["']/i)?.[1] || null;
      const poster = img ? absolute(img) || undefined : undefined;
      cards.push({ slug: first.slug, detailUrl: first.url, title, alternateTitles, year, poster });
      seen.add(first.slug);
    }
    i = next;
  }
  return cards;
}

function parseSeriesBrowseCards(html) {
  const input = String(html || '');
  // Full ZOZNAM SERIÁLOV pages contain five complete cards, but the site
  // prepends carousel / featured series with plausible titles, years and
  // credits. Those can pass a simple metadata check and displace the catalog.
  //
  // The true cards are the final five complete entries immediately before
  // the catalogue pager ("z 356", "z 55", etc.). Other sidebars are after
  // the pager. Scope to the catalog body and select its final five cards.
  const pager = input.search(/(?:\bz\s+\d{1,5}\b|<[^>]+class=["'][^"']*(?:pagin|strankov)[^"']*["'])/i);
  const scoped = pager >= 0 ? input.slice(0, pager) : input;
  const cards = parseSeriesCards(scoped, { verifiedCatalog: true });
  return cards.slice(-PAGE_SIZE);
}

function parseRecentEpisodeCards(html) {
  const input = String(html || '');
  const seen = new Set();
  const cards = [];
  const showTitles = new Map();
  const showPosters = new Map();

  // Collect the show's actual displayed name across the whole page before
  // processing episode links. An episode link can appear before/after its
  // heading, and anchor attributes are not always in the same order.
  for (const match of input.matchAll(/<a\b[^>]*href=["']([^"']*\/serial-[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const slug = slugFromUrl(match[1]);
    if (!slug) continue;
    const title = cleanHtml(match[2]).replace(/\s*\((?:19|20)\d{2}\)\s*$/, '').trim();
    if (title.length >= 3 && title.length < 120 &&
        !/^(?:trailer|prehr[aá]t|najnov[sš]ie seri[aá]ly)$/i.test(title)) {
      const existing = showTitles.get(slug);
      if (!existing || title.length > existing.length) showTitles.set(slug, title);
    }
    const image = match[2].match(/<img\b[^>]*(?:data-src|src)=["']([^"']+)["']/i)?.[1];
    const poster = image ? absolute(image) : null;
    if (poster) showPosters.set(slug, poster);
  }

  for (const match of input.matchAll(/<a\b[^>]*href=["']([^"']*\/serial\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let path = '';
    try { path = new URL(match[1], SITE).pathname; } catch { continue; }
    const parsed = path.match(/^\/serial\/(.+)-(\d+)x(\d+)\/?$/i);
    if (!parsed) continue;
    const slug = parsed[1].toLowerCase();
    const season=Number(parsed[2]);
    const episode=Number(parsed[3]);
    const id=episodeId(slug,season,episode);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label=cleanHtml(match[2]);
    const language=/EN\s*\+\s*tit/i.test(label) ? 'EN + titulky'
      : /\b(?:CZ|SK)\b/i.test(label) ? 'CZ/SK' : 'Neznámý';
    const near = input.slice(Math.max(0, match.index - 850), match.index + 300);
    const image = near.match(/<img\b[^>]*(?:data-src|src)=["']([^"']+)["']/i)?.[1];
    const poster = showPosters.get(slug) || (image ? absolute(image) : '') || null;
    cards.push({
      id, slug, season, episode, episodeUrl:SITE+'/serial/'+slug+'-'+season+'x'+episode,
      language, detailUrl: SITE + '/serial-' + slug,
      title: showTitles.get(slug) || slug.replace(/-/g, ' '),
      year: slug.match(/(?:19|20)\d{2}/)?.[0] || null,
      ...(poster ? { poster } : {})
    });
    if (cards.length >= 12) break;
  }
  return cards;
}

function extractMetaTag(html, property) {
  for (const m of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = new Map([...m[0].matchAll(/([\w:-]+)=["']([^"']*)["']/g)].map(x => [x[1].toLowerCase(), x[2]]));
    if ((attrs.get('property') || attrs.get('name')) === property) return attrs.get('content') || '';
  }
  return '';
}

function parseEpisodeList(html, season, showSlug) {
  const out = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/<a\b[^>]*href=["']([^"']*\/serial\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absolute(match[1]);
    if (!url) continue;
    const tail = new URL(url).pathname.replace(/^\/serial\//, '').replace(/\/$/, '');
    const episode = tail.match(/^(.+)-(\d+)x(\d+)$/i) || tail.match(/^(.+)-s(\d+)e(\d+)$/i);
    if (!episode || Number(episode[2]) !== season || Number(episode[3]) < 1) continue;
    if (showSlug && episode[1] !== showSlug) continue;
    const number = Number(episode[3]);
    const key = url;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = cleanHtml(match[2]);
    const language = /\bCZ\b|dabing/i.test(label) ? '🇨🇿 CZ' :
      /\bSK\b/i.test(label) ? '🇸🇰 SK' :
      /tit/i.test(label) ? '🇨🇿/🇸🇰 titulky' : 'Bombuj';
    out.push({ episodeUrl:url, season, episode:number, language });
  }
  return out.sort((a,b) => a.episode - b.episode);
}

function seriesBrowseUrl({page=1,sort='id',genre='all',dubbed=false}) {
  // The site's sorting dropdown links to index.php with:
  // sort=id|rok|hodnotenie|views and (for dubbed-only) dab=1.
  // Keep query semantics identical for all pages and genre combinations.
  const sorts = new Set(['id', 'rok', 'hodnotenie', 'views']);
  const q = new URLSearchParams({
    page: String(Math.max(1, Math.floor(Number(page) || 1))),
    sort: sorts.has(sort) ? sort : 'id',
    zaner: String(genre || 'all'),
    nazov: '1'
  });
  if (dubbed) q.set('dab', '1');
  else q.set('dab', '');
  return SITE + '/zoznam-serialov/podla-zanru/index.php?' + q.toString();
}

function catalogManifest() {
  return [
    ...catalogDefinitions.map(c => ({
      type:'series', id:c.id, name:c.name,
      extra:c.mode === 'episodes'
        ? [{name:'genre',options:['Všechny epizody','S titulky','S dabingem','Bez titulků']},{name:'skip'}]
        : [{name:'genre',options:genres},{name:'skip'}]
    })),
    {
      type: 'series', id: SEARCH_SERIES_CATALOG.id, name: SEARCH_SERIES_CATALOG.name,
      extra: [{name:'search',isRequired:true},{name:'skip'}]
    }
  ];
}

function createSeriesService({ fetchText, core, log=console }) {
  const cache = new Map();
  const episodeCardCache = new Map();
  const get = (key) => {
    const item = cache.get(key);
    if (item && item.expires > Date.now()) return item.value;
    cache.delete(key);
    return null;
  };
  const put = (key,value,minutes=15) => {
    cache.set(key,{value,expires:Date.now()+minutes*60000});
    return value;
  };
  const fetchSite = async (url, referer=SITE+'/') => fetchText(url, {headers:{Referer:referer}});
  const pagePending = new Map();
  async function showPage(slug) {
    const key='show-page:'+slug;
    const cached=get(key);
    if(cached)return cached;
    if(pagePending.has(slug))return pagePending.get(slug);
    const task=fetchSite(SITE+'/serial-'+slug).then(html=>
      put(key,html,15));
    pagePending.set(slug,task);
    try{return await task;}
    finally{pagePending.delete(slug);}
  }

  async function seriesDetail(slug) {
    const key = 'detail:'+slug;
    const cached = get(key);
    if(cached) return cached;
    const url = SITE + '/serial-' + slug;
    const html = await showPage(slug);
    const name = cleanHtml(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]) ||
      cleanHtml(extractMetaTag(html,'og:title')) ||
      slug.replace(/-/g,' ');
    const posterValue = extractMetaTag(html,'og:image');
    const poster = posterValue ? absolute(posterValue) : null;
    const description = cleanHtml(extractMetaTag(html,'og:description')) || undefined;
    const year = name.match(/\b(?:19|20)\d{2}\b/)?.[0] ||
      html.match(/<(?:h2|div)\b[^>]*>[^<>]*\b((?:19|20)\d{2})\b/i)?.[1] || null;
    const seasonCandidates = new Set([1]);
    for(const m of html.matchAll(/(?:seria=|data-seria=["']?|(?:Séria|Série|Season)\s*[:#]?\s*)(\d{1,2})/gi)) {
      const n=Number(m[1]); if(n>=1 && n<=MAX_SEASON)seasonCandidates.add(n);
    }
    const result = {slug,url,name:name.replace(/\s*\((?:19|20)\d{2}\)\s*$/,'').trim(),poster,description,year,seasonCandidates:[...seasonCandidates].sort((a,b)=>a-b)};
    return put(key,result,30);
  }

  async function seasonEpisodes(slug, season) {
    const key = 'episodes:'+slug+':'+season;
    const hit=get(key); if(hit)return hit;
    const url = SITE+'/epizody/ajax2.php?url='+encodeURIComponent(slug)+'&seria='+season;
    const detail=SITE+'/serial-'+slug;
    let html='';
    try {
      html = await fetchText(url,{headers:{Referer:detail,'X-Requested-With':'XMLHttpRequest'}});
    } catch(e) {
      log.warn('[series] season fetch failed',slug,season,String(e?.message||e));
    }
    let episodes=parseEpisodeList(html,season,slug);
    if(!episodes.length){
      // Older Bombuj shows can link episodes directly from their series
      // detail while ajax2.php returns only an empty season heading.
      // Parse only links belonging to this show's slug; never sidebar items.
      const page=await showPage(slug).catch(e=>{
        log.warn('[series] detail fallback failed',slug,String(e?.message||e));
        return '';
      });
      episodes=parseEpisodeList(page,season,slug);
      if(episodes.length) log.log('[series] detail episode fallback',slug,season,episodes.length);
    }
    // Do not pretend an empty/failed AJAX response means that the series
    // does not exist. Cache misses briefly to retry later.
    return put(key,episodes,episodes.length?30:2);
  }

  async function catalogue(extra) {
    const key='catalog:'+JSON.stringify(extra);
    const hit=get(key);if(hit)return hit;
    if(extra.mode==='episodes' && !extra.search){
      const page=Math.floor(extra.skip/12)+1;
      const offset=extra.skip%12;
      // Actual Bombuj episode language tabs: all=1, subtitles=2,
      // dubbed=3, without subtitles=4.
      const episodeTypes={'S titulky':'2','S dabingem':'3','Bez titulků':'4'};
      const episodeType=episodeTypes[extra.genre] || '1';
      const load=async n=>parseRecentEpisodeCards(await fetchSite(SITE+'/index.php?page='+n+'&type='+episodeType));
      const current=await load(page);
      let cards=current.slice(offset);
      if(offset && current.length>=12)cards=cards.concat(await load(page+1)).slice(0,12);
      const metas=cards.map(card=>{
        episodeCardCache.set(card.id,card);
        return {
          id:card.id,type:'series',
          name:card.title+' – '+card.season+'×'+card.episode,
          ...(card.poster?{poster:card.poster}:{}),posterShape:'poster',
          ...(card.year?{releaseInfo:card.year}:{})
        };
      }).filter(card=>card.id);
      log.log('[series-catalog]',extra.id,'page='+page,'type='+episodeType,'items='+metas.length);
      return put(key,{metas},5);
    }
    if(extra.mode==='search'){
      if(!extra.search) return put(key,{metas:[]},2);
      // Existing search endpoint returns the same serial-* detail URL as browse.
      const response=await fetchText(SITE+'/4154q37rpc4dsvbp.php',{
        method:'POST',headers:{Referer:SITE+'/',Origin:SITE,
          'X-Requested-With':'XMLHttpRequest','Content-Type':'application/x-www-form-urlencoded'},
        body:'queryString='+encodeURIComponent(extra.search)
      });
      const cards = parseSeriesCards(response).slice(extra.skip,extra.skip+PAGE_SIZE);
      const metas=cards.map(card => ({
        id:seriesId(card.slug),type:'series',name:card.title,
        ...(card.alternateTitles?.length?{aliases:card.alternateTitles}:{}),
        ...(card.poster?{poster:card.poster}:{}),posterShape:'poster',
        ...(card.year?{releaseInfo:card.year}:{})
      }));
      return put(key,{metas},5);
    }
    // Prevent search results in regular catalogue rows when a Stremio
    // installation still has the old manifest cached.
    if(extra.search) return put(key,{metas:[]},2);
    const page=Math.floor(extra.skip/PAGE_SIZE)+1;
    const offset=extra.skip%PAGE_SIZE;
    const html=await fetchSite(seriesBrowseUrl({page,sort:extra.sort,genre:extra.genre,dubbed:extra.dubbed}));
    const current=parseSeriesBrowseCards(html);
    let cards=current.slice(offset);
    if(offset && current.length>=PAGE_SIZE){
      const nextHtml=await fetchSite(seriesBrowseUrl({page:page+1,sort:extra.sort,genre:extra.genre,dubbed:extra.dubbed}));
      cards=cards.concat(parseSeriesBrowseCards(nextHtml)).slice(0,PAGE_SIZE);
    }
    const metas=cards.map(card=>({
      id:seriesId(card.slug),type:'series',name:card.title,
      ...(card.poster?{poster:card.poster}:{}),posterShape:'poster',
      ...(card.year?{releaseInfo:card.year}:{})
    })).filter(x=>x.id);
    log.log('[series-catalog]',extra.id,'page='+page,'skip='+extra.skip,'cards='+metas.length);
    return put(key,{metas},5);
  }

  async function meta(slug) {
    const detail=await seriesDetail(slug);
    const seasons=new Set(detail.seasonCandidates);
    // The page is often populated by AJAX: probe a bounded range of
    // seasons, then extend if the highest season is present.
    let consecutiveEmpty = 0;
    for(let start=1; start<=MAX_SEASON;start+=4){
      const current=Array.from({length:Math.min(4,MAX_SEASON-start+1)},(_,i)=>start+i);
      const responses=await Promise.all(current.map(season=>seasonEpisodes(slug,season)));
      responses.forEach((items,i)=>{
        if(items.length) {
          seasons.add(current[i]);
          consecutiveEmpty=0;
        } else {
          consecutiveEmpty++;
        }
      });
      const hasFutureKnown = detail.seasonCandidates.some(n=>n>current.at(-1));
      if(consecutiveEmpty>=3 && !hasFutureKnown)break;
    }
    const all=await Promise.all([...seasons].sort((a,b)=>a-b).map(season=>seasonEpisodes(slug,season)));
    const seen=new Set();
    const videos=all.flat().filter(item=>{
      const key=item.season+':'+item.episode;
      if(seen.has(key))return false;seen.add(key);return true;
    }).sort((a,b)=>a.season-b.season||a.episode-b.episode)
      .map(e=>({id:seriesId(slug)+':'+e.season+':'+e.episode,
        title:'Epizoda '+e.season+'×'+e.episode,
        season:e.season,episode:e.episode}));
    log.log('[series-meta]',slug,'seasons='+seasons.size,'episodes='+videos.length);
    return {meta:{
      id:seriesId(slug),type:'series',name:detail.name,
      ...(detail.poster?{poster:detail.poster}:{}),
      ...(detail.description?{description:detail.description}:{}),
      ...(detail.year?{releaseInfo:detail.year}:{}),
      posterShape:'poster',videos
    }};
  }

  async function episodeMeta(slug, season, episode) {
    const id=episodeId(slug,season,episode);
    if(!id) return {meta:null};
    const card=episodeCardCache.get(id);
    const detail=card ? {
      name:card.title,poster:card.poster,year:card.year
    } : await seriesDetail(slug);
    return {meta:{
      id,type:'series',name:detail.name+' – '+season+'×'+episode,
      ...(detail.poster?{poster:detail.poster}:{}),
      ...(detail.year?{releaseInfo:detail.year}:{}),
      posterShape:'poster',
      videos:[{
        id:seriesId(slug)+':'+season+':'+episode,
        title:'Epizoda '+season+'×'+episode,
        season,episode
      }]
    }};
  }

  async function streams(slug,season,episode) {
    if(!Number.isInteger(season)||!Number.isInteger(episode)||season<1||episode<1)return {streams:[]};
    const variants=(await seasonEpisodes(slug,season)).filter(item=>item.episode===episode);
    const lists=await Promise.all(variants.map(async item=>{
      const players=await core.discoverBombujPlayers(item.episodeUrl,SITE,item.language);
      return core.playersToStreams(players,item.episodeUrl);
    }));
    const unique=new Set();
    const streams=lists.flat().filter(s=>{
      // A provider can expose the same embed in both dabing and subtitle
      // groups. Only collapse duplicates within the same language group.
      const url=s.url||s.externalUrl;
      const key=url+'\0'+String(s.description||'');
      if(!url||unique.has(key))return false;
      unique.add(key);return true;
    });
    log.log('[series-stream]',slug,season,episode,'variants='+variants.length,'streams='+streams.length);
    return {streams};
  }

  async function subtitles(slug,season,episode) {
    const found=await streams(slug,season,episode);
    const seen=new Set();
    const subtitles=[];
    for(const stream of found.streams){
      for(const sub of stream.subtitles||[]){
        if(!sub.url||seen.has(sub.url))continue;seen.add(sub.url);
        subtitles.push({id:'bombuj-series-sub-'+subtitles.length,url:sub.url,lang:sub.lang||'ces'});
      }
    }
    return {subtitles};
  }

  async function firstEpisodeUrl(slug) {
    // One small AJAX call rather than loading every season/episode to identify
    // the series. Keep fallback behavior for shows without a first season.
    const first = await seasonEpisodes(slug, 1);
    if (first.length) return first[0].episodeUrl;
    const second = await seasonEpisodes(slug, 2);
    return second[0]?.episodeUrl || null;
  }

  return {catalogue,meta,episodeMeta,streams,subtitles,firstEpisodeUrl,detail:seriesDetail};
}

module.exports={
  SITE,PAGE_SIZE,catalogDefinitions,SEARCH_SERIES_CATALOG,genres,
  slugFromUrl,seriesId,episodeId,parseEpisodeMetaPath,parseSeriesResource,parseSeriesCatalogPath,
  parseSeriesCards,parseSeriesBrowseCards,parseRecentEpisodeCards,parseEpisodeList,seriesBrowseUrl,catalogManifest,createSeriesService
};
