'use strict';

const http = require('http');
const {
  parseSeriesResource, parseEpisodeMetaPath, parseSeriesCatalogPath,
  catalogManifest: seriesCatalogManifest, createSeriesService
} = require('./series-catalog.js');
const { PAGE_SIZE, parseCatalogPath, browseUrl, manifestCatalogs, normalizeGenreLabel } = require('./movie-catalog-config.js');
const { subtitleTracks: customSubtitleUrls, formatBombujStream: customStreamDisplay } = require('./stream-display.js');
const {
  movieImdbId, seriesImdbId, fetchCinemetaById, mergeCinemeta,
  enrichCinemetaSeries, enrichCinemetaEpisode,
  seriesSearchName, selectCinemetaSeriesCandidate
} = require('./bombuj-cinemeta.js');
const { rememberSource } = require('./source-identity.js');

const PUBLIC_PORT = Number(process.env.PORT || 7004);
const INNER_PORT = Number(process.env.BOMBUJ_FILTER_INNER_PORT || (PUBLIC_PORT + 1));
const BOMBUJ_BASE = 'https://www.bombuj.si';
const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const BROWSE_PAGE_SIZE = PAGE_SIZE;
const nativeFetch = global.fetch.bind(global);
const catalogCache = new Map();
const metaCache = new Map();

function cacheGet(map, key) {
  const item = map.get(key);
  if (!item || item.expiresAt < Date.now()) {
    map.delete(key);
    return null;
  }
  return item.value;
}

function cacheSet(map, key, value, ttlMs) {
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

function stripTags(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
}

function normalize(value) {
  return stripTags(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function absoluteUrl(value, base = BOMBUJ_BASE) {
  try {
    return new URL(String(value || '').startsWith('//') ? `https:${value}` : value, base).toString();
  } catch {
    return String(value || '');
  }
}

async function fetchExternalText(url, init = {}) {
  const response = await nativeFetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
    ...init,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'cs-CZ,cs;q=0.9,sk;q=0.8,en;q=0.7',
      ...(init.headers || {})
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

async function fetchExternalJson(url) {
  const response = await nativeFetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': USER_AGENT }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

function parseStreamPath(pathname) {
  const match = String(pathname || '').match(/^\/stream\/(movie|series)\/(.+)\.json$/i);
  return match ? { type: match[1].toLowerCase(), id: decodeURIComponent(match[2]) } : null;
}

function providerText(stream) {
  return `${stream?.name || ''} ${stream?.title || ''} ${stream?.description || ''} ${stream?.externalUrl || ''}`.toLowerCase();
}

function externalHost(stream) {
  try {
    return new URL(String(stream?.externalUrl || stream?.url || '')).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function providerRank(stream) {
  const host = externalHost(stream);
  const text = providerText(stream);
  if (stream?.url && /^https?:\/\//i.test(String(stream.url))) return 0;
  if (/vsembed\.ru$/.test(host) || /\bvidsrc\b/.test(text)) return 10;
  if (/(^|\.)voe(?:2)?\./.test(host) || /\bvoe2?\b/.test(text)) return 20;
  if (/vidapi/.test(host) || /\bvidapi\b/.test(text)) return 30;
  if (/vidnest/.test(host) || /\bvidnest\b/.test(text)) return 40;
  if (/streamtape/.test(host) || /\bstreamtape\b/.test(text)) return 50;
  if (/vidlink/.test(host) || /\bvidlink\b/.test(text)) return 60;
  if (/mixdrop|mxd?rop|miixdrop|miiiixdrop/.test(host) || /\bmixdrop\b/.test(text)) return 80;
  if (/byse|bysekoze/.test(host) || /\bbyse\b/.test(text)) return 90;
  if (/videasy/.test(host) || /\bprimewire\b|\bvideasy\b/.test(text)) return 100;
  return 70;
}

function streamProviderName(stream) {
  const named = String(stream?.name || '').replace(/^Bombuj\s*•\s*/i, '').trim();
  if (named) return named;
  const host = externalHost(stream);
  return host || (stream?.url ? 'direct' : 'unknown');
}

function sortDynamicStreamPayload(payload, type, id) {
  const discovered = Array.isArray(payload?.streams) ? [...payload.streams] : [];
  discovered.sort((a, b) => providerRank(a) - providerRank(b));
  const providers = discovered.map(streamProviderName);
  console.log(`[dynamic] ${type}/${id}: discovered=${discovered.length} providers=${JSON.stringify(providers)}`);
  return { ...payload, streams: discovered };
}

function parseMovieCards(html) {
  const matches = [...String(html || '').matchAll(
    /<a\b[^>]*href=["']([^"']*online-film-[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
  )];
  const cards = [];
  const seen = new Set();

  for (const match of matches) {
    const detailUrl = absoluteUrl(match[1]);
    let slug = '';
    try {
      slug = (new URL(detailUrl).pathname.split('/').filter(Boolean).pop() || '').replace(/^online-film-/i, '');
    } catch {
      slug = (detailUrl.split('/').pop() || '').replace(/^online-film-/i, '').replace(/[?#].*$/, '');
    }
    if (!slug || seen.has(slug)) continue;

    const cardHtml = match[2] || '';
    const images = [...cardHtml.matchAll(/<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi)];
    const cover = images.find((image) => /\/images\/covers\//i.test(image[1])) || images.at(-1);
    if (cover && /\/images\/slide\//i.test(cover[1])) continue;

    const titleHtml =
      cardHtml.match(/<div\b[^>]*font-size\s*:\s*(?:18|23)px[^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
      cover?.[0].match(/\balt=["']([^"']+)["']/i)?.[1] ||
      '';
    const title = stripTags(titleHtml) || slug.replace(/-/g, ' ');
    const year = slug.match(/(?:19|20)\d{2}/)?.[0] || stripTags(cardHtml).match(/\b(?:19|20)\d{2}\b/)?.[0] || null;

    seen.add(slug);
    cards.push({
      slug,
      detailUrl,
      poster: cover ? absoluteUrl(cover[1]) : null,
      title,
      year
    });
  }

  return cards;
}

function parseBombujSearch(html) {
  const out = [];
  const seen = new Set();
  const re = /<a href=["']([^"']*online-film-[^"']+)["'][^>]*>(?:\s*<img[^>]+src=["']([^"']*)["'][^>]*>[\s\S]*?)?<span class=["']nazov["']>([\s\S]*?)<\/span>(?:\s*<span class=["']zanre["']>([\s\S]*?)<\/span>)?/gi;
  for (const match of String(html || '').matchAll(re)) {
    const detailUrl = absoluteUrl(match[1]);
    const slug = (new URL(detailUrl).pathname.split('/').filter(Boolean).pop() || '').replace(/^online-film-/i, '');
    if (!slug || seen.has(slug)) continue;
    const rawTitle = stripTags(match[3]);
    const metaText = stripTags(match[4] || '');
    const year = rawTitle.match(/\((?:19|20)\d{2}\)\s*$/)?.[0]?.replace(/[()]/g, '') || metaText.match(/\b(?:19|20)\d{2}\b/)?.[0] || null;
    const title = rawTitle.replace(/\s*\((?:19|20)\d{2}\)\s*$/, '').trim() || slug.replace(/-/g, ' ');
    seen.add(slug);
    out.push({ slug, detailUrl, poster: match[2] ? absoluteUrl(match[2]) : null, title, year });
  }
  return out;
}

async function bombujSearchCards(query) {
  const key = `search:${normalize(query)}`;
  const cached = cacheGet(catalogCache, key);
  if (cached) return cached;
  const html = await fetchExternalText(`${BOMBUJ_BASE}/4154q37rpc4dsvbp.php`, {
    method: 'POST',
    headers: {
      Referer: `${BOMBUJ_BASE}/`,
      Origin: BOMBUJ_BASE,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html, */*;q=0.1'
    },
    body: `queryString=${encodeURIComponent(query)}`
  });
  return cacheSet(catalogCache, key, parseBombujSearch(html), 5 * 60 * 1000);
}

async function resolveGenreValue(label) {
  if (!label || ['all', 'vsechny filmy', 'vsetky filmy'].includes(normalize(label))) return 'all';
  const key = `genre:${normalizeGenreLabel(label)}`;
  const cached = cacheGet(catalogCache, key);
  if (cached) return cached;

  try {
    const html = await fetchExternalText(`${BOMBUJ_BASE}/zanre/obr/all.php?page=1&sort=id&title=1&zaner=all`, {
      headers: { Referer: `${BOMBUJ_BASE}/` }
    });
    const target = normalizeGenreLabel(label);
    for (const match of html.matchAll(/<option\b[^>]*value=["']([^"']+)["'][^>]*>([\s\S]*?)<\/option>/gi)) {
      if (normalizeGenreLabel(stripTags(match[2])) === target) {
        return cacheSet(catalogCache, key, decodeHtml(match[1]).trim() || 'all', 12 * 60 * 60 * 1000);
      }
    }
  } catch {}

  return cacheSet(catalogCache, key, label, 60 * 60 * 1000);
}

async function bombujBrowseCards(page, genreLabel, sort, audio) {
  const genre = await resolveGenreValue(genreLabel);
  const key = `browse:${page}:${genre}:${sort}:${audio}`;
  const cached = cacheGet(catalogCache, key);
  if (cached) return cached;
  const url = browseUrl({ page, genre, sort, audio });
  const html = await fetchExternalText(url, { headers: { Referer: `${BOMBUJ_BASE}/` } });
  const cards = parseMovieCards(html);
  console.log(`[catalog] Bombuj browse page=${page} genre=${genre} sort=${sort} audio=${audio} cards=${cards.length}`);
  return cacheSet(catalogCache, key, cards, 5 * 60 * 1000);
}

function scoreMeta(meta, titles, year) {
  const sourceTitles = titles.map(normalize).filter(Boolean);
  const candidateTitles = [meta?.name, ...(Array.isArray(meta?.aliases) ? meta.aliases : [])].map(normalize).filter(Boolean);
  const metaYear = String(meta?.releaseInfo || meta?.year || meta?.released || '').match(/(?:19|20)\d{2}/)?.[0] || null;
  // Do not attribute a different film just because of a common short word.
  if (year && metaYear && year !== metaYear) return 0;
  let score = 0;
  for (const source of sourceTitles) {
    for (const candidate of candidateTitles) {
      if (source.length >= 3 && source === candidate) score = Math.max(score, 100);
      else if (source.length >= 6 && candidate.length >= 6 &&
        (source.includes(candidate) || candidate.includes(source)) &&
        Math.min(source.length, candidate.length) / Math.max(source.length, candidate.length) >= 0.7) {
        score = Math.max(score, 45);
      }
    }
  }
  return score ? score + (year && year === metaYear ? 60 : 0) : 0;
}

async function detailMovieIdentity(card) {
  const key = 'detail-identity:' + card.slug;
  const cached = cacheGet(metaCache, key);
  if (cached) return cached;
  try {
    const html = await fetchExternalText(card.detailUrl, {
      headers: { Referer: BOMBUJ_BASE + '/' }
    });
    const heading = stripTags(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
    const variants = [
      card.title, heading,
      stripTags(html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1] || ''),
      stripTags(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s*\|\s*bombuj.*$/i, '')
    ].flatMap(value => String(value || '').split(/\s+-\s+/))
      .map(value => value.trim()).filter(Boolean);
    return cacheSet(metaCache, key,
      { variants: [...new Set(variants)], imdbId: movieImdbId(html), heading },
      12 * 60 * 60 * 1000);
  } catch {
    // A failed Bombuj detail must not prevent the existing title fallback.
    return { variants: [card.title], imdbId: null, heading: '' };
  }
}

async function resolveCinemetaCard(card) {
  const cacheKey = 'meta:' + normalize(card.title) + ':' + (card.year || '');
  const cached = cacheGet(metaCache, cacheKey);
  if (cached !== null) return cached || null;

  const identity = await detailMovieIdentity(card);
  const variants = identity.variants;
  if (/\.{2,}$|…$/.test(card.title || '')) {
    const prefix = normalize(String(card.title).replace(/(?:\.{2,}|…)$/, ''));
    const fullTitle = [identity.heading, ...variants.slice(1)].find(value => {
      const clean = normalize(value);
      return prefix.length >= 6 && clean.startsWith(prefix) &&
        clean.length > prefix.length + 2 && clean.length < 150;
    });
    if (fullTitle) card.title = fullTitle.replace(/\s*\((?:19|20)\d{2}\)\s*$/, '').trim();
  }

  // The exact ID is sourced from the film's own player AJAX configuration.
  // It is stronger evidence than localized names or a one-year difference.
  let meta = null;
  if (identity.imdbId) {
    meta = await fetchCinemetaById('movie', identity.imdbId, fetchExternalJson)
      .catch(() => null);
    if (meta) console.log('[cinemeta-movie]', card.slug, 'id=' + identity.imdbId);
  }

  // Only when Bombuj has no usable IMDb ID fall back to title+year search.
  if (!meta) {
    let best = null;
    for (const query of variants.slice(0, 4)) {
      try {
        const data = await fetchExternalJson(
          CINEMETA_BASE + '/catalog/movie/top/search=' + encodeURIComponent(query) + '.json');
        for (const candidate of Array.isArray(data?.metas) ? data.metas : []) {
          const id = String(candidate?.id || candidate?.imdb_id || '');
          if (!/^tt\d+$/i.test(id)) continue;
          const score = scoreMeta(candidate, variants, card.year);
          if (!best || score > best.score) best = { id, score };
        }
        if (best?.score >= 100) break;
      } catch {}
    }
    if (best?.score >= 45) {
      meta = await fetchCinemetaById('movie', best.id, fetchExternalJson)
        .catch(() => null);
    }
  }

  if (!meta) return cacheSet(metaCache, cacheKey, false, 60 * 60 * 1000);
  rememberSource('movie', meta.id, card);
  const mapped = mergeCinemeta({
    id: meta.id, type: 'movie', name: card.title || meta.name,
    ...(card.poster ? { poster: card.poster } : {}),
    posterShape: 'poster',
    ...(card.year ? { releaseInfo: card.year } : {})
  }, meta);
  return cacheSet(metaCache, cacheKey, mapped, 12 * 60 * 60 * 1000);
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      try { results[index] = await mapper(items[index], index); }
      catch { results[index] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function buildCatalog(extra) {
  const cacheKey = `catalog:${extra.id}:${extra.search}:${extra.genre}:${extra.sort}:${extra.audio}:${extra.skip}`;
  const cached = cacheGet(catalogCache, cacheKey);
  if (cached) return cached;

  // Only the dedicated search row is searchable; never mix search results
  // into the home-screen rankings (including older cached manifests).
  const isSearch = extra.id === 'bombuj-movies-search';
  if (Boolean(extra.search) !== isSearch) return { metas: [] };

  let cards;
  if (isSearch) {
    cards = (await bombujSearchCards(extra.search)).slice(extra.skip, extra.skip + BROWSE_PAGE_SIZE);
  } else {
    // Translate Stremio's zero-based skip into Bombuj's 1-based page. If the
    // requested skip is not aligned with 16, collect the end of this page
    // and the start of the next one rather than dropping catalogue items.
    const page = Math.floor(extra.skip / BROWSE_PAGE_SIZE) + 1;
    const offset = extra.skip % BROWSE_PAGE_SIZE;
    const current = await bombujBrowseCards(page, extra.genre, extra.sort, extra.audio);
    cards = current.slice(offset);
    if (offset > 0 && current.length >= BROWSE_PAGE_SIZE) {
      const following = await bombujBrowseCards(page + 1, extra.genre, extra.sort, extra.audio);
      cards = cards.concat(following).slice(0, BROWSE_PAGE_SIZE);
    }
    console.log(`[catalog] pagination id=${extra.id} skip=${extra.skip} page=${page} offset=${offset} returned=${cards.length}`);
  }

  const mapped = await mapWithConcurrency(cards, 6, resolveCinemetaCard);
  const metas = cards.map((card, i) => {
    const id = customMovieId(card.slug);
    customCardCache.set(id, card);
    return mapped[i] || fallbackCatalogMeta(card);
  }).filter(Boolean);
  console.log(`[catalog] request id=${extra.id} search=${JSON.stringify(extra.search)} genre=${JSON.stringify(extra.genre)} sort=${extra.sort} audio=${extra.audio} skip=${extra.skip} cards=${cards.length} imdb=${mapped.filter(Boolean).length} fallback=${metas.length - mapped.filter(Boolean).length} shown=${metas.length}`);
  return cacheSet(catalogCache, cacheKey, { metas }, 5 * 60 * 1000);
}


const seriesService = createSeriesService({
  fetchText: fetchExternalText,
  core: {
    discoverBombujPlayers: (...args) => require('./index.js').discoverBombujPlayers(...args),
    playersToStreams: (...args) => require('./index.js').playersToStreams(...args)
  },
  log: console
});


const seriesCinemetaPending = new Map();

async function resolveSeriesCinemeta(slug, suggestedEpisodeUrl, identity = {}) {
  const key = 'series-cinemeta:' + slug;
  const cached = cacheGet(metaCache, key);
  if (cached !== null) return cached || null;
  if (seriesCinemetaPending.has(key)) return seriesCinemetaPending.get(key);

  const promise = (async () => {
    let meta = null;
    try {
      // Prefer the exact IMDb ID embedded in the episode player URLs.
      const episodeUrl = suggestedEpisodeUrl || await seriesService.firstEpisodeUrl(slug);
      if (episodeUrl) {
        const html = await fetchExternalText(episodeUrl, {
          headers: { Referer: 'https://serialy.bombuj.si/serial-' + slug }
        });
        const id = seriesImdbId(html);
        if (id) meta = await fetchCinemetaById('series', id, fetchExternalJson);
        console.log('[cinemeta-series]', slug, 'player-id=' + (id || 'missing'),
          'result=' + (meta ? 'confirmed' : 'unavailable'));
      }
    } catch (error) {
      // A missing AJAX/episode page must not prevent a strict name+year lookup.
      console.warn('[cinemeta-series]', slug, 'player-lookup:',
        String(error?.message || error));
    }

    if (!meta && identity.name) {
      const variants = [identity.name, ...(identity.aliases || [])]
        .map(seriesSearchName).filter(Boolean).slice(0, 3);
      for (const name of [...new Set(variants)]) {
        try {
          const catalog = await fetchExternalJson(CINEMETA_BASE +
            '/catalog/series/top/search=' + encodeURIComponent(name) + '.json');
          const candidate = selectCinemetaSeriesCandidate(
            catalog?.metas, name, identity.releaseInfo);
          if (candidate) {
            meta = await fetchCinemetaById('series',
              candidate.id || candidate.imdb_id, fetchExternalJson);
            console.log('[cinemeta-series]', slug,
              'verified-title-year=' + (meta?.id || 'unavailable'));
          }
        } catch (error) {
          console.warn('[cinemeta-series]', slug, 'catalog-lookup:',
            String(error?.message || error));
        }
        if (meta) break;
      }
    }
    if (meta?.id) rememberSource('series', meta.id, {
      slug, title: identity.name || meta.name, year: identity.releaseInfo,
      detailUrl: 'https://serialy.bombuj.si/serial-' + slug
    });
    return cacheSet(metaCache, key, meta || false,
      meta ? 12 * 60 * 60 * 1000 : 5 * 60 * 1000);
  })();
  seriesCinemetaPending.set(key, promise);
  try { return await promise; }
  finally { seriesCinemetaPending.delete(key); }
}

async function enrichedSeriesCatalog(payload, options) {
  if (options.mode === 'episodes') {
    // Resolve each show's exact IMDb ID through the episode's own player
    // page, then reuse the shared 12-hour Cinemeta cache for repeated shows.
    // Do not fetch every season or change the episode's Bombuj ID.
    const metas = await mapWithConcurrency(payload.metas || [], 4, async item => {
      const episode = parseEpisodeMetaPath('/meta/series/' + String(item?.id || '') + '.json');
      if (!episode) return item;
      const episodeUrl = 'https://serialy.bombuj.si/serial/' + episode.slug +
        '-' + episode.season + 'x' + episode.episode;
      const cinemeta = await resolveSeriesCinemeta(episode.slug, episodeUrl, {
        name: item.name.replace(/s+[–-]s+d+×d+(?:s+[–-]s+.*)?$/, ''),
        releaseInfo: item.releaseInfo
      });
      return cinemeta
        ? enrichCinemetaEpisode(item, cinemeta, episode.season, episode.episode)
        : item;
    });
    return { ...payload, metas: metas.map((item, i) => item || payload.metas[i]) };
  }
  const metas = await mapWithConcurrency(payload.metas || [], 4, async item => {
    if (!item?.id?.startsWith('bombuj-series-')) return item;
    const slug = item.id.slice('bombuj-series-'.length);
    const cinemeta = await resolveSeriesCinemeta(slug, undefined, {
      name: item.name, aliases: item.aliases, releaseInfo: item.releaseInfo
    });
    if (cinemeta?.poster) return mergeCinemeta(item, cinemeta);
    // Even series not indexed by Cinemeta have a local cover on Bombuj.
    if (item.poster) return cinemeta ? mergeCinemeta(item, cinemeta) : item;
    const detail = await seriesService.detail(slug).catch(() => null);
    const local = detail?.poster ? { ...item, poster: detail.poster } : item;
    return cinemeta ? mergeCinemeta(local, cinemeta) : local;
  });
  return { ...payload, metas };
}

function episodeUrlFromMeta(slug, payload) {
  const first = payload?.meta?.videos?.[0];
  if (!first || !Number.isInteger(first.season) ||
      !Number.isInteger(first.episode)) return '';
  return 'https://serialy.bombuj.si/serial/' + slug + '-' +
    first.season + 'x' + first.episode;
}

const customCardCache = new Map();
const customStreamsCache = new Map();

function customMovieId(rawSlug) {
  const slug = String(rawSlug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  return slug ? 'bombuj-movie-' + slug : '';
}

function parseCustomMoviePath(pathname) {
  const match = String(pathname || '').match(/^\/(meta|stream|subtitles)\/movie\/(bombuj-movie-[a-z0-9-]+)\.json$/i);
  if (!match) return null;
  const id = match[2].toLowerCase();
  return { resource: match[1].toLowerCase(), id, slug: id.slice('bombuj-movie-'.length) };
}

function fallbackCatalogMeta(card) {
  const id = customMovieId(card.slug);
  if (!id) return null;
  return {
    id, type: 'movie', name: card.title || card.slug.replace(/-/g, ' '),
    ...(card.poster ? { poster: card.poster } : {}),
    posterShape: 'poster',
    ...(card.year ? { releaseInfo: card.year } : {})
  };
}

async function customMovieMeta(id, slug) {
  let card = customCardCache.get(id);
  if (!card) {
    const detailUrl = BOMBUJ_BASE + '/online-film-' + slug;
    const html = await fetchExternalText(detailUrl, { headers: { Referer: BOMBUJ_BASE + '/' } }).catch(() => '');
    if (!html) return { meta: null };
    const h1 = stripTags(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '');
    const title = h1 || stripTags(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s*[|–-]\s*bombuj.*$/i, '') || slug.replace(/-/g, ' ');
    const poster = html.match(/<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)/i)?.[1];
    const year = html.match(/<h[123]\b[^>]*>[\s\S]*?\b((?:19|20)\d{2})\b/i)?.[1] || null;
    card = { slug, detailUrl, title, poster: poster ? absoluteUrl(poster) : null, year };
    customCardCache.set(id, card);
  }
  const original = fallbackCatalogMeta(card);
  const mapped = await resolveCinemetaCard(card);
  return { meta: mapped ? mergeCinemeta(original, { ...mapped,
    id: mapped.imdb_id || mapped.id }) : original };
}

async function customMovieStreams(id, slug) {
  const cached = cacheGet(customStreamsCache, id);
  if (cached) return cached;
  // The existing addon has already been loaded by the downstream proxy.
  // Reuse its dynamic player discovery instead of maintaining a second parser.
  const parser = require('./index.js');
  const detailUrl = BOMBUJ_BASE + '/online-film-' + slug;
  const players = await parser.discoverBombujPlayers(detailUrl, BOMBUJ_BASE);
  const rawStreams = await parser.playersToStreams(players, detailUrl);
  const streams = rawStreams.map(customStreamDisplay);
  console.log('[catalog-stream] ' + id + ': players=' + players.length + ' streams=' + streams.length);
  return cacheSet(customStreamsCache, id, streams, 5 * 60 * 1000);
}

function extendedManifest(payload) {
  const resources = Array.isArray(payload?.resources) ? payload.resources.map(resource => {
    if (resource?.name === 'stream' || resource?.name === 'subtitles') {
      return { ...resource, idPrefixes: [...new Set([...(resource.idPrefixes || []), 'bombuj-movie-', 'bombuj-series-'])] };
    }
    return resource;
  }) : [];
  const existingMeta = resources.find(item => item?.name === 'meta');
  if (existingMeta) {
    existingMeta.types = [...new Set([...(existingMeta.types || []), 'movie', 'series'])];
    existingMeta.idPrefixes = [...new Set([...(existingMeta.idPrefixes || []), 'bombuj-movie-', 'bombuj-series-', 'bombuj-episode-'])];
  } else {
    resources.push({
      name: 'meta', types: ['movie', 'series'],
      idPrefixes: ['bombuj-movie-', 'bombuj-series-', 'bombuj-episode-']
    });
  }
  const existingGenres = Array.isArray(payload?.catalogs)
    ? payload.catalogs.find(item => item?.id === 'bombuj-movies')?.extra?.find(extra => extra?.name === 'genre')?.options
    : null;
  const genreOptions = Array.isArray(existingGenres) && existingGenres.length
    ? [...new Set([...existingGenres, 'Populárne filmy', 'Erotické', 'Odporúčané YA', 'Dystopické'])]
    : ['Akční', 'Komedie', 'Horor', 'Sci-Fi', 'Drama'];
  return {
    ...payload, types: [...new Set([...(payload?.types || []), 'movie', 'series'])],
    resources, catalogs: [...manifestCatalogs(genreOptions), ...seriesCatalogManifest()]
  };
}

async function fetchInner(pathname) {
  const response = await nativeFetch(`http://127.0.0.1:${INNER_PORT}${pathname}`, {
    signal: AbortSignal.timeout(90000)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { response, text, json };
}

function sendJson(res, status, payload, headOnly = false) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  if (headOnly) return res.end();
  res.end(JSON.stringify(payload));
}

async function handle(req, res) {
  try {
    const incoming = new URL(req.url || '/', `http://127.0.0.1:${PUBLIC_PORT}`);
    const catalog = parseCatalogPath(incoming.pathname);
    if (catalog) {
      const payload = await buildCatalog(catalog);
      return sendJson(res, 200, payload, req.method === 'HEAD');
    }

    const seriesCatalog = parseSeriesCatalogPath(incoming.pathname);
    if (seriesCatalog) {
      const payload = await seriesService.catalogue(seriesCatalog);
      return sendJson(res, 200, await enrichedSeriesCatalog(payload, seriesCatalog), req.method === 'HEAD');
    }

    const episode = parseEpisodeMetaPath(incoming.pathname);
    if (episode) {
      const payload = await seriesService.episodeMeta(episode.slug, episode.season, episode.episode);
      const cinemeta = await resolveSeriesCinemeta(episode.slug,
        'https://serialy.bombuj.si/serial/' + episode.slug + '-' + episode.season + 'x' + episode.episode,
        { name: payload.meta?.name?.replace(/s+[–-]s+d+×d+$/, ''),
          releaseInfo: payload.meta?.releaseInfo });
      return sendJson(res, 200,
        { ...payload, meta: cinemeta
          ? enrichCinemetaEpisode(payload.meta, cinemeta, episode.season, episode.episode)
          : payload.meta },
        req.method === 'HEAD');
    }

    const series = parseSeriesResource(incoming.pathname);
    if (series) {
      if (series.resource === 'meta') {
        const payload = await seriesService.meta(series.slug);
        const cinemeta = await resolveSeriesCinemeta(series.slug,
          episodeUrlFromMeta(series.slug, payload) || undefined,
          { name: payload.meta?.name, releaseInfo: payload.meta?.releaseInfo });
        return sendJson(res, 200,
          { ...payload, meta: cinemeta
            ? enrichCinemetaSeries(payload.meta, cinemeta)
            : payload.meta },
          req.method === 'HEAD');
      }
      if (series.resource === 'subtitles') {
        return sendJson(res, 200,
          await seriesService.subtitles(series.slug, series.season, series.episode),
          req.method === 'HEAD');
      }
      // Use the EXACT SAME presentation as the custom film catalogue.
      // Format only the Stremio labels; URL/externalUrl remain provider-direct.
      const payload = await seriesService.streams(series.slug, series.season, series.episode);
      return sendJson(res, 200, {
        ...payload, streams: (payload.streams || []).map(customStreamDisplay)
      }, req.method === 'HEAD');
    }

    const custom = parseCustomMoviePath(incoming.pathname);
    if (custom) {
      if (custom.resource === 'meta') {
        return sendJson(res, 200, await customMovieMeta(custom.id, custom.slug), req.method === 'HEAD');
      }
      const streams = await customMovieStreams(custom.id, custom.slug);
      const payload = custom.resource === 'subtitles'
        ? { subtitles: customSubtitleUrls(streams) }
        : { streams };
      return sendJson(res, 200, payload, req.method === 'HEAD');
    }

    const inner = await fetchInner(`${incoming.pathname}${incoming.search}`);
    let body = inner.text;
    if (incoming.pathname === '/manifest.json' && inner.json) {
      body = JSON.stringify(extendedManifest(inner.json));
    } else {
      const stream = parseStreamPath(incoming.pathname);
      if (stream && inner.json) {
        body = JSON.stringify(sortDynamicStreamPayload(inner.json, stream.type, stream.id));
      }
    }

    res.writeHead(inner.response.status, {
      'Content-Type': inner.response.headers.get('content-type') || 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') return res.end();
    res.end(body);
  } catch (error) {
    console.error('[dynamic]', error?.stack || error);
    sendJson(res, 502, { error: 'Bombuj dynamic endpoint unavailable' }, req.method === 'HEAD');
  }
}

process.env.PORT = String(INNER_PORT);
require('./front.js');

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS'
    });
    return res.end();
  }
  handle(req, res);
});

server.listen(PUBLIC_PORT, '127.0.0.1', () => {
  console.log(`[dynamic] Bombuj final endpoint on 127.0.0.1:${PUBLIC_PORT} -> ${INNER_PORT}`);
});
