'use strict';

const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const { decodeAttribute, parseBombujPlayerGroups } = require('./player-groups.js');
const { movieImdbId, seriesImdbId } = require('./bombuj-cinemeta.js');
const { parseSeriesCards, parseSeriesBrowseCards, parseEpisodeList, seriesBrowseUrl } = require('./series-catalog.js');
const { rememberSource, findSource, sourceIdentity, normalizeTitle } = require('./source-identity.js');
const { parseMovieCards } = require('./bombuj-listing.js');
const { testDirectVoeAllowed } = require('./embed-test-policy.js');
const { inspectHls } = require('./stream-quality.js');
const { subtitleTracks } = require('./stream-display.js');
const { resolveVidara, vidaraEmbed } = require('./resolvers/vidara.js');
const { resolvePrimewireViaPloyan } = require('./resolvers/ployan.js');
const { resolveVidapi } = require('./resolvers/vidapi.js');
const { resolveVidnest, vidnestId } = require('./resolvers/vidnest.js');
const { resolveStreamtape } = require('./resolvers/streamtape.js');

const BOMBUJ_BASE = 'https://www.bombuj.si';
const BOMBUJ_SERIES_BASE = 'https://serialy.bombuj.si';
const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const PORT = Number(process.env.PORT || 7000);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PAGE_SIZE = 20;
const sourceResolvePending = new Map();

const GENRES = [
  'Akční', 'Komedie', 'Animované', 'Romantické', 'Horor', 'Thriller', 'Sci-Fi',
  'Drama', 'Krimi', 'Dokumentárne', 'Dobrodružné', 'Rodinné', 'Fantasy',
  'Životopisné', 'Mysteriózne', 'Športové', 'Vojnové', 'Historické',
  'Psychologické', 'Rozprávky', 'Katastrofické', 'Hudobné', 'Western',
  'Skutočná udalosť', 'Vianočné filmy'
];

const MIXDROP_HOSTS = [
  'mixdrop.ag', 'mixdrop.co', 'mixdrop.to', 'mixdrop.sx',
  'mixdrop.ps', 'mixdrop.my', 'miixdrop.net', 'miiiixdrop.net'
];

const cache = new Map();
let resolverRequestCounter = 0;

function resolverErrorReason(error) {
  const message = String(error?.message || '');
  const http = message.match(/\bHTTP\s+(\d{3})\b/i);
  if (http) return `http-${http[1]}`;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  const code = String(error?.cause?.code || error?.code || '');
  return /^(?:EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|CERT_[A-Z_]+)$/.test(code)
    ? code.toLowerCase() : 'request-failed';
}

function resolverHost(url) {
  try { return new URL(url).hostname.toLowerCase().slice(0, 120); }
  catch { return 'unknown'; }
}

function resolverLogUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    // Never expose embedded HTTP Basic Auth credentials in a diagnostic log.
    url.username = '';
    url.password = '';
    return url.href.slice(0, 16384);
  } catch { return undefined; }
}

function logResolver(requestId, player, event) {
  const record = {
    at: new Date().toISOString(), requestId,
    provider: String(player?.provider || 'unknown').replace(/[\r\n]+/g, ' ').slice(0, 64),
    language: String(player?.language || '').replace(/[\r\n]+/g, ' ').slice(0, 48),
    host: resolverHost(player?.resolvedUrl),
    stage: String(event?.stage || 'result').slice(0, 30),
    result: String(event?.result || 'unknown').slice(0, 30),
    ...(event?.reason ? { reason: String(event.reason).slice(0, 70) } : {}),
    ...(event?.backend ? { backend: String(event.backend).slice(0, 24) } : {}),
    ...(event?.candidateHost ? { candidateHost: resolverHost(`https://${event.candidateHost}/`) } : {}),
    ...(event?.quality ? { quality: String(event.quality).slice(0, 15) } : {}),
    ...(Number.isFinite(event?.elapsedMs) ? { elapsedMs: event.elapsedMs } : {})
  };
  if (process.env.BOMBUJ_RESOLVER_LOG_URLS === '1') {
    // Only the owner's private PM2 log; signatures may expire or be IP-bound.
    const urls = {
      playerUrl: player?.resolvedUrl,
      requestUrl: event?.requestUrl,
      mediaUrl: event?.mediaUrl,
      handedToStremio: event?.handedToStremio,
      referer: event?.referer
    };
    for (const [key, raw] of Object.entries(urls)) {
      const safe = resolverLogUrl(raw);
      if (safe) record[key] = safe;
    }
  }
  console.log('[BOMBUJ RESOLVER] ' + JSON.stringify(record));
}

function cacheGet(key) {
  const item = cache.get(key);
  if (!item || item.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
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
    return value;
  }
}

async function fetchPage(url, init = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    ...init,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'cs-CZ,cs;q=0.9,sk;q=0.8,en;q=0.7',
      ...(init.headers || {})
    }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return {
    text: await response.text(),
    finalUrl: response.url || url,
    contentType: response.headers.get('content-type') || ''
  };
}

async function fetchText(url, init = {}) {
  return (await fetchPage(url, init)).text;
}

async function fetchJson(url) {
  const response = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

function parseBombujSearch(html, baseUrl = BOMBUJ_BASE, mediaType = 'movie') {
  const out = [];
  const re = /<a href="([^"]+(?:online-(?:film|serial)-|serial-)[^"]+)"[^>]*>(?:\s*<img[^>]+src="([^"]*)"[^>]*>[\s\S]*?)?<span class="nazov">([\s\S]*?)<\/span>(?:\s*<span class="zanre">([\s\S]*?)<\/span>)?/gi;
  for (const match of String(html || '').matchAll(re)) {
    const detailUrl = absoluteUrl(match[1], baseUrl);
    const rawTitle = stripTags(match[3]);
    const metaText = stripTags(match[4] || '');
    const year = rawTitle.match(/\((19|20)\d{2}\)\s*$/)?.[0]?.replace(/[()]/g, '') || metaText.match(/\b(19|20)\d{2}\b/)?.[0] || null;
    const titleParts = rawTitle.replace(/\s*\((19|20)\d{2}\)\s*$/, '').trim().split(/\s+-\s+/).filter(Boolean);
    const title = mediaType === 'series' ? (titleParts[0] || rawTitle) : (titleParts.join(' - ') || rawTitle);
    const alternateTitles = mediaType === 'series' ? titleParts.slice(1) : titleParts;
    let slug = '';
    try {
      const parsed = new URL(detailUrl);
      slug = (parsed.pathname.split('/').filter(Boolean).pop() || '')
        .replace(/^online-(?:film|serial)-/i, '')
        .replace(/^serial-/i, '')
        .replace(/[?#].*$/, '');
    } catch {
      slug = (detailUrl.split('/').pop() || '')
        .replace(/^online-(?:film|serial)-/i, '')
        .replace(/^serial-/i, '')
        .replace(/[?#].*$/, '');
    }
    out.push({ slug, detailUrl, poster: match[2] ? absoluteUrl(match[2], baseUrl) : null, title, alternateTitles, year });
  }
  return out;
}

async function searchBombuj(query, baseUrl, mediaType) {
  const key = `bombuj:search:${mediaType}:${normalize(query)}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const html = await fetchText(`${baseUrl}/4154q37rpc4dsvbp.php`, {
    method: 'POST',
    headers: {
      Referer: `${baseUrl}/`,
      Origin: baseUrl,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html, */*;q=0.1'
    },
    body: `queryString=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(6500)
  });
  return cacheSet(key, parseBombujSearch(html, baseUrl, mediaType), 10 * 60 * 1000);
}

async function searchBombujMovies(query) {
  return searchBombuj(query, BOMBUJ_BASE, 'movie');
}

async function searchBombujSeries(query) {
  // The series site uses a different search-card structure from the movie
  // site. Parse it with the same robust parser used by Bombuj's catalogues.
  // Otherwise the first IMDb lookup after a cold start returns no sources
  // until someone opens the native Bombuj catalogue and warms the ID cache.
  const key = `bombuj:search:series:${normalize(query)}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const html = await fetchText(`${BOMBUJ_SERIES_BASE}/4154q37rpc4dsvbp.php`, {
    method: 'POST',
    headers: {
      Referer: BOMBUJ_SERIES_BASE + '/',
      Origin: BOMBUJ_SERIES_BASE,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html, */*;q=0.1'
    },
    body: 'queryString=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(6500)
  });
  const matches = parseSeriesCards(html);
  return cacheSet(key, matches, matches.length ? 10 * 60 * 1000 : 60 * 1000);
}

async function listBombujMovies({ page = 1, genre = null }) {
  const genreValue = genre || 'all';
  const key = `bombuj:list:${page}:${genreValue}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const url = `${BOMBUJ_BASE}/zanre/obr/all.php?page=${Math.max(1, page)}&sort=id&title=1&zaner=${encodeURIComponent(genreValue)}`;
  const html = await fetchText(url, {
    headers: { Referer: `${BOMBUJ_BASE}/` },
    signal: AbortSignal.timeout(6500)
  });
  return cacheSet(key, parseMovieCards(html), 5 * 60 * 1000);
}

function scoreCinemetaCandidate(card, meta) {
  const sourceTitle = normalize(card.title);
  const targetTitles = [meta.name, ...(Array.isArray(meta.aliases) ? meta.aliases : [])]
    .map(normalize)
    .filter(Boolean);
  let score = 0;
  if (sourceTitle && targetTitles.some((title) => title === sourceTitle)) score = 100;
  else if (sourceTitle && targetTitles.some((title) => title.includes(sourceTitle) || sourceTitle.includes(title))) score = 45;
  if (!score) return 0;
  const cardYear = card.year;
  const metaYear = String(meta.releaseInfo || meta.year || '').match(/(?:19|20)\d{2}/)?.[0] || null;
  if (cardYear && metaYear && cardYear === metaYear) score += 60;
  return score;
}

async function resolveCinemetaMovie(card) {
  const key = `cinemeta:movie:${normalize(card.title)}:${card.year || ''}`;
  const cached = cacheGet(key);
  if (cached !== null) return cached;
  try {
    const data = await fetchJson(`${CINEMETA_BASE}/catalog/movie/top/search=${encodeURIComponent(card.title)}.json`);
    const metas = Array.isArray(data.metas) ? data.metas.filter((m) => /^tt\d+$/i.test(m.id || m.imdb_id || '')) : [];
    const ranked = metas
      .map((meta) => ({ meta, score: scoreCinemetaCandidate(card, meta) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best || best.score < 45) return cacheSet(key, false, 60 * 60 * 1000);
    const meta = best.meta;
    return cacheSet(key, {
      id: meta.id || meta.imdb_id,
      type: 'movie',
      name: meta.name || card.title,
      poster: meta.poster || card.poster || undefined,
      posterShape: 'poster',
      background: meta.background || undefined,
      releaseInfo: meta.releaseInfo || card.year || undefined
    }, 12 * 60 * 60 * 1000);
  } catch (error) {
    console.warn('[Cinemeta] mapping failed:', card.title, error.message);
    return false;
  }
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

async function bombujCatalog(args) {
  const skip = Math.max(0, Number.parseInt(args.extra?.skip || '0', 10) || 0);
  const search = String(args.extra?.search || '').trim();
  const genre = String(args.extra?.genre || '').trim() || null;
  const cards = search
    ? await searchBombujMovies(search)
    : await listBombujMovies({ page: Math.floor(skip / PAGE_SIZE) + 1, genre });
  const sliced = search ? cards.slice(skip, skip + PAGE_SIZE) : cards.slice(0, PAGE_SIZE);
  const mapped = await mapWithConcurrency(sliced, 4, resolveCinemetaMovie);
  return { metas: mapped.filter(Boolean) };
}

async function getCinemetaMeta(type, videoId) {
  const imdbId = String(videoId).split(':')[0];
  const key = `cinemeta:meta:${type}:${imdbId}`;
  const cached = cacheGet(key);
  if (cached) return cached;
  const data = await fetchJson(`${CINEMETA_BASE}/meta/${type}/${imdbId}.json`);
  return cacheSet(key, data.meta || null, 12 * 60 * 60 * 1000);
}

function chooseBombujMatch(results, meta) {
  const year = String(meta.releaseInfo || meta.year || '').match(/(?:19|20)\d{2}/)?.[0] || null;
  const targetTitles = [meta.name, ...(Array.isArray(meta.aliases) ? meta.aliases : [])]
    .map(normalize)
    .filter(Boolean);
  const ranked = results
    .map((item) => {
      const candidateTitles = [item.title, ...(Array.isArray(item.alternateTitles) ? item.alternateTitles : [])]
        .map(normalize)
        .filter(Boolean);
      let titleScore = 0;
      if (candidateTitles.some((candidate) => targetTitles.some((target) => candidate === target))) titleScore = 100;
      else if (candidateTitles.some((candidate) => targetTitles.some((target) => candidate.includes(target) || target.includes(candidate)))) titleScore = 45;
      if (!titleScore) return { item, score: 0, titleMatched: false };
      let score = titleScore;
      if (year && item.year === year) score += 60;
      return { item, score, titleMatched: true };
    })
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  return best?.titleMatched && best.score >= 45 ? best.item : null;
}

function extractIframeSrc(html) {
  const direct = String(html || '').match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1];
  if (direct) return direct;
  const injected = String(html || '').match(/\.html\(\s*'([\s\S]+?)'\s*\)/i)?.[1];
  if (!injected) return null;
  const unescaped = decodeHtml(injected).replace(/\\\//g, '/').replace(/\\'/g, "'").replace(/\\"/g, '"');
  return unescaped.match(/<iframe[^>]+src=["']([^"']+)["']/i)?.[1] || null;
}

function isVipGateHtml(html) {
  const value = normalize(html);
  return value.includes('vip uz') || value.includes('dostupny len pre vip');
}

async function fetchBombujWrapper(url, sourcePageUrl, siteBaseUrl) {
  const primary = await fetchText(url, { headers: { Referer: sourcePageUrl } }).catch(() => '');
  if (!primary || extractIframeSrc(primary) || !isVipGateHtml(primary)) return primary;
  return await fetchText(url, { headers: { Referer: `${siteBaseUrl}/` } }).catch(() => primary);
}

async function resolveBombujWrapper(rawUrl, sourcePageUrl, siteBaseUrl = BOMBUJ_BASE, maxDepth = 3) {
  let current = absoluteUrl(decodeAttribute(rawUrl), siteBaseUrl);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    let host = '';
    try { host = new URL(current).hostname.toLowerCase(); } catch { return current; }
    if (!/(^|\.)bombuj\.si$/i.test(host)) return current;
    const html = await fetchBombujWrapper(current, sourcePageUrl, siteBaseUrl);
    if (!html) return current;
    const iframe = extractIframeSrc(html);
    if (!iframe) return isVipGateHtml(html) ? null : current;
    current = absoluteUrl(decodeAttribute(iframe), current);
  }
  return current;
}

async function discoverBombujPlayers(detailUrl, siteBaseUrl = BOMBUJ_BASE, fallbackLanguage = 'Bombuj') {
  const html = await fetchText(detailUrl, { headers: { Referer: siteBaseUrl + '/' } });
  const dataMatch = html.match(/url:\s*'prehravace_ajax\.php'[\s\S]*?data:\s*({[\s\S]*?}),\s*success:/i);
  const servers = [];

  // Movies usually load the accordion by AJAX; series episodes often
  // contain the complete CZ/EN accordion directly in their HTML.
  if (dataMatch) {
    const params = new URLSearchParams();
    for (const match of dataMatch[1].matchAll(/([a-z_]+):\s*'([^']*)'/g)) {
      params.append(match[1], decodeAttribute(match[2]));
    }
    const ajaxHtml = await fetchText(siteBaseUrl + '/prehravace_ajax.php?' + params.toString(), {
      headers: { Referer: detailUrl, 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/html, */*;q=0.1' }
    }).catch(() => '');
    servers.push(...parseBombujPlayerGroups(ajaxHtml, fallbackLanguage));
  }
  servers.push(...parseBombujPlayerGroups(html, fallbackLanguage));

  // Do not collapse different language variants before resolving the link.
  // One and the same player can be advertised under both CZ and EN groups.
  const rawSeen = new Set();
  const uniqueServers = servers.filter((server) => {
    const key = server.url + '\0' + server.language;
    if (rawSeen.has(key)) return false;
    rawSeen.add(key);
    return true;
  });

  const resolved = await mapWithConcurrency(uniqueServers, 4, async (server) => ({
    ...server,
    resolvedUrl: await resolveBombujWrapper(server.url, detailUrl, siteBaseUrl)
  }));

  const seen = new Set();
  const found = resolved.filter((item) => {
    if (!item?.resolvedUrl || !/^https?:\/\//i.test(item.resolvedUrl)) return false;
    const key = item.resolvedUrl + '\0' + item.language;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  console.log('[players] ' + detailUrl + ': raw=' + uniqueServers.length +
    ' resolved=' + found.length +
    ' providers=' + found.map(x => x.provider + ' (' + x.language + ')').join(', '));
  return found;
}

function parseBombujEpisodeSlug(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/serialy\.bombuj\.si\/serial\//i, '')
    .replace(/^\/serial\//i, '')
    .replace(/#.*$/, '')
    .replace(/\/$/, '');

  const slashEpisode = normalized.match(/^(.+)\/s(\d+)e(\d+)$/i);
  if (slashEpisode) return { showSlug: slashEpisode[1], season: Number(slashEpisode[2]), episode: Number(slashEpisode[3]) };

  const suffixedEpisode = normalized.match(/^(.+)-s(\d+)e(\d+)$/i);
  if (suffixedEpisode) return { showSlug: suffixedEpisode[1], season: Number(suffixedEpisode[2]), episode: Number(suffixedEpisode[3]) };

  const xEpisode = normalized.match(/^(.+)-(\d+)x(\d+)$/i);
  if (xEpisode) return { showSlug: xEpisode[1], season: Number(xEpisode[2]), episode: Number(xEpisode[3]) };

  return null;
}

function parseBombujSerialEpisodeList(html, seasonNumber) {
  const results = [];
  for (const match of String(html || '').matchAll(/<a\s+href=['"]([^'"]*)['"][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = match[1]?.trim();
    if (!href || !/\/serial\//i.test(href)) continue;
    const parsed = parseBombujEpisodeSlug(href);
    if (!parsed || parsed.season !== seasonNumber || !Number.isFinite(parsed.episode)) continue;
    const language = stripTags(match[2]?.match(/<div[^>]*float:right[^>]*>([\s\S]*?)<\/div>/i)?.[1] || '').trim() || 'Bombuj';
    results.push({
      episodeUrl: absoluteUrl(href, BOMBUJ_SERIES_BASE),
      season: parsed.season,
      episode: parsed.episode,
      language
    });
  }
  return results;
}

async function findBombujSeriesEpisode(seriesItem, season, episode) {
  const serialPageUrl = seriesItem.detailUrl || `${BOMBUJ_SERIES_BASE}/serial-${seriesItem.slug}`;
  const html = await fetchText(serialPageUrl, { headers: { Referer: `${BOMBUJ_SERIES_BASE}/` } }).catch(() => '');
  if (!html) return null;

  const ajaxUrl = `${BOMBUJ_SERIES_BASE}/epizody/ajax2.php?url=${encodeURIComponent(seriesItem.slug)}&seria=${season}`;
  const listHtml = await fetchText(ajaxUrl, {
    headers: { Referer: serialPageUrl, 'X-Requested-With': 'XMLHttpRequest' }
  }).catch(() => '');

  const candidates = parseBombujSerialEpisodeList(listHtml, season);
  return candidates.find((item) => item.episode === episode &&
    parseBombujEpisodeSlug(item.episodeUrl)?.showSlug === seriesItem.slug) ||
    parseEpisodeList(html, season, seriesItem.slug).find(item => item.episode === episode) || null;
}

function rot13(value) {
  return String(value || '').replace(/[a-z]/gi, (character) => {
    const code = character.charCodeAt(0);
    const base = code <= 90 ? 65 : 97;
    return String.fromCharCode(base + ((code - base + 13) % 26));
  });
}

function collectStringValues(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStringValues(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((item) => collectStringValues(item, out));
  return out;
}

function decodeVoeCandidate(encoded) {
  try {
    const markerFree = ['@$', '^^', '~@', '%?', '*~', '!!', '#&']
      .reduce((value, marker) => value.replaceAll(marker, ''), rot13(encoded));
    const firstLayer = Buffer.from(markerFree, 'base64');
    if (!firstLayer.length || firstLayer.some((byte) => byte < 3)) return null;
    const reversedBase64 = Buffer.from(
      Uint8Array.from(firstLayer, (byte) => byte - 3).reverse()
    ).toString('utf8');
    const payload = JSON.parse(Buffer.from(reversedBase64, 'base64').toString('utf8'));
    const direct = payload?.source || payload?.file || payload?.url;
    return typeof direct === 'string' && /^https?:\/\//i.test(direct) ? direct : null;
  } catch {
    return null;
  }
}

function extractVoeObfuscatedStream(html) {
  const scripts = String(html || '').matchAll(
    /<script\b(?=[^>]*\btype\s*=\s*["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const match of scripts) {
    const text = decodeHtml(match[1]).trim();
    let payload;
    try { payload = JSON.parse(text); }
    catch { payload = text; }
    for (const value of collectStringValues(payload)) {
      if (/^https?:\/\/[^\s"']+\.(?:m3u8|mp4)(?:[?#][^\s"']*)?$/i.test(value)) return value;
      const decoded = decodeVoeCandidate(value);
      if (decoded) return decoded;
    }
  }
  return null;
}

function extractScriptRedirect(html, baseUrl) {
  const value = String(html || '');
  const match = value.match(/(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i) ||
    value.match(/location\.replace\(\s*["']([^"']+)["']\s*\)/i);
  return match?.[1] ? absoluteUrl(match[1], baseUrl) : null;
}

async function resolveVoe(embedUrl, sourcePageUrl) {
  const deadline = Date.now() + 10000;
  let current = embedUrl;
  let referer = sourcePageUrl || embedUrl;
  for (let depth = 0; depth < 4; depth += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;
    const page = await fetchPage(current, {
      signal: AbortSignal.timeout(remaining),
      headers: {
        Referer: referer,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    }).catch(() => null);
    if (!page) return null;
    const finalUrl = page.finalUrl || current;
    const streamUrl = extractVoeObfuscatedStream(page.text);
    if (streamUrl) {
      const type = directUrlType(streamUrl);
      if (type === 'hls') {
        const media = await inspectHls(streamUrl, { fetchImpl: fetch, headers: { 'User-Agent': USER_AGENT, Referer: finalUrl }, timeoutMs: deadline - Date.now() }).catch(() => null);
        if (!media) return null;
        return { ...media, referer: finalUrl, type };
      }
      return type ? { url: streamUrl, referer: finalUrl, type } : null;
    }
    const redirect = extractScriptRedirect(page.text, finalUrl);
    if (!redirect || redirect === current) return null;
    referer = finalUrl;
    current = redirect;
  }
  return null;
}

function extractMixdropStream(html, baseUrl) {
  const match = String(html || '').match(/(?:MDCore\.)?wurl\s*=\s*["']([^"']+)["']/i) ||
    String(html || '').match(/["']wurl["']\s*:\s*["']([^"']+)["']/i);
  if (!match?.[1]) return null;
  const raw = decodeHtml(match[1]).replace(/\\\//g, '/').replace(/\\u0026/gi, '&');
  const url = absoluteUrl(raw, baseUrl);
  return /^https?:\/\//i.test(url) ? url : null;
}

function mixdropCandidates(embedUrl) {
  try {
    const parsed = new URL(embedUrl);
    const path = `${parsed.pathname}${parsed.search}`;
    const hosts = [parsed.hostname, ...MIXDROP_HOSTS.filter((host) => host !== parsed.hostname)];
    return hosts.slice(0, 6).map((host) => `${parsed.protocol}//${host}${path}`);
  } catch {
    return [embedUrl];
  }
}

async function resolveMixdrop(embedUrl, sourcePageUrl, onDiagnostic = () => {}) {
  for (const candidate of mixdropCandidates(embedUrl)) {
    const candidateHost = resolverHost(candidate);
    let page;
    try { page = await fetchPage(candidate, {
      headers: {
        Referer: sourcePageUrl || candidate,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    }); } catch (error) {
      onDiagnostic({ stage: 'embed', result: 'failed', candidateHost,
        requestUrl: candidate, reason: resolverErrorReason(error) });
      continue;
    }
    if (!page) continue;
    const finalUrl = page.finalUrl || candidate;
    const streamUrl = extractMixdropStream(page.text, finalUrl);
    if (streamUrl) {
      onDiagnostic({ stage: 'parse', result: 'found', candidateHost: resolverHost(finalUrl),
        requestUrl: candidate, mediaUrl: streamUrl });
      return { url: streamUrl, referer: finalUrl, type: 'mp4' };
    }
    onDiagnostic({ stage: 'parse', result: 'failed', candidateHost: resolverHost(finalUrl),
      requestUrl: candidate, reason: 'wurl-not-found' });
  }
  return null;
}

function inferProvider(player) {
  const signature = `${player.provider || ''} ${player.resolvedUrl || ''}`.toLowerCase();
  let host = '';
  try { host = new URL(player.resolvedUrl).hostname.toLowerCase(); } catch {}
  if (vidaraEmbed(player.resolvedUrl)) return 'vidara';
  if (/\bprimewire\b/i.test(signature) || /(^|\.)primewire\./i.test(host)) return 'primewire';
  if (/\bvidapi\b|\bvaplayer\b/i.test(signature) || /(^|\.)(?:vaplayer\.ru|nextgencloudfabric\.com)$/i.test(host)) return 'vidapi';
  if (/\bvidnest\b/i.test(signature) || /(^|\.)(?:vidnest\.fun|new\.vidnest\.fun)$/i.test(host)) return 'vidnest';
  if (/\bvideasy\b/i.test(signature) || /(^|\.)player\.videasy\.(?:net|to)$/i.test(host)) return 'videasy';
  if (/\bvidlink\b/i.test(signature) || /(^|\.)vidlink\.pro$/i.test(host)) return 'vidlink';
  if (/\bstreamtape\b/i.test(signature) || /(^|\.)streamtape\.(?:com|to)$/i.test(host)) return 'streamtape';
  if (/\bvoe\b|voe\./i.test(signature) || /(^|\.)voe(?:2)?\./i.test(host)) return 'voe';
  if (/mixdrop|miixdrop|miiiixdrop/i.test(signature) || /mixdrop|miixdrop|miiiixdrop/i.test(host)) return 'mixdrop';
  return 'other';
}

function directUrlType(url) {
  if (/\.m3u8(?:$|[?#])/i.test(url)) return 'hls';
  if (/\.mp4(?:$|[?#])/i.test(url)) return 'mp4';
  return null;
}

async function resolveDirectPlayer(player, sourcePageUrl, context = {}, onDiagnostic = () => {}) {
  const directType = directUrlType(player.resolvedUrl);
  if (directType) return { url: player.resolvedUrl, referer: sourcePageUrl, type: directType };

  const provider = inferProvider(player);
  // Experimental until client-side playback confirms signed HLS URLs from
  // Oracle are usable on another public IP. Normal web-player fallback stays.
  if (provider === 'vidara' && process.env.BOMBUJ_DIRECT_VIDARA === '1') {
    return resolveVidara(player.resolvedUrl);
  }
  if (provider === 'primewire' && process.env.BOMBUJ_DIRECT_PLOYAN === '1') {
    return resolvePrimewireViaPloyan(context);
  }
  if (provider === 'vidapi' && process.env.BOMBUJ_DIRECT_VIDAPI === '1') {
    let imdbId = context?.imdbId;
    if (!imdbId) {
      try { imdbId = new URL(player.url).searchParams.get('iid'); }
      catch {}
    }
    if (!imdbId) imdbId = String(player.resolvedUrl || '').match(/tt\d{5,12}/i)?.[0];
    return resolveVidapi({ ...context, imdbId }, { onDiagnostic });
  }
  if ((provider === 'vidnest' && process.env.BOMBUJ_DIRECT_VIDNEST === '1') ||
      (provider === 'vidlink' && process.env.BOMBUJ_DIRECT_VIDLINK === '1') ||
      (provider === 'videasy' && process.env.BOMBUJ_DIRECT_VIDEASY === '1')) {
    let tmdbId = vidnestId(context?.tmdbId);
    if (!tmdbId) {
      try { tmdbId = vidnestId(new URL(player.url).searchParams.get('iid')); }
      catch {}
    }
    if (!tmdbId) {
      const matched = String(player.resolvedUrl || '').match(/\/(?:movie|tv)\/(\d{1,12})(?:\/|$|\?)/i);
      tmdbId = vidnestId(matched?.[1]);
    }
    const backend = provider === 'vidlink' || provider === 'videasy' ? [provider] : undefined;
    return resolveVidnest({ ...context, tmdbId }, { ...(backend ? { backends: backend } : {}), onDiagnostic });
  }
  if (provider === 'streamtape' && process.env.BOMBUJ_DIRECT_STREAMTAPE === '1') {
    return resolveStreamtape(player.resolvedUrl, { onDiagnostic });
  }
  if (provider === 'voe') return resolveVoe(player.resolvedUrl, sourcePageUrl);
  if (provider === 'mixdrop') return resolveMixdrop(player.resolvedUrl, sourcePageUrl, onDiagnostic);
  return null;
}

function safeLabel(value) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function makeDirectStream(player, direct, index, tracks) {
  const provider = safeLabel(player.provider) || `Zdroj ${index + 1}`;
  const language = safeLabel(player.language) || 'Bombuj';
  const extension = direct.type === 'hls' ? 'm3u8' : 'mp4';
  return {
    name: `Bombuj • ${provider}`,
    description: `${language} • přímý ${direct.type === 'hls' ? 'HLS' : 'MP4'}${direct.quality ? ' • ' + direct.quality : ''}`,
    url: direct.url,
    behaviorHints: {
      notWebReady: true,
      bingeGroup: `bombuj-${normalize(provider) || index}${testDirectVoeAllowed(player.resolvedUrl) ? '-' + normalize(language).replace(/\s+/g, '-') : ''}`,
      filename: `bombuj-${index + 1}.${extension}`,
      proxyHeaders: {
        request: {
          'User-Agent': USER_AGENT,
          ...(direct.referer ? { Referer: direct.referer } : {}),
          ...(direct.origin ? { Origin: direct.origin } : {})
        }
      }
    },
    ...(tracks.length ? { subtitles: tracks } : {})
  };
}

function makeExternalStream(player, index, tracks) {
  return {
    name: `Bombuj • ${safeLabel(player.provider) || `Zdroj ${index + 1}`}`,
    description: `${safeLabel(player.language) || 'Bombuj'} • externí player`,
    externalUrl: player.resolvedUrl,
    ...(tracks.length ? { subtitles: tracks } : {})
  };
}

async function playersToStreams(players, sourcePageUrl, context = {}) {
  const webFallbacks = [];
  const requestId = `${Date.now().toString(36)}-${(++resolverRequestCounter).toString(36)}`;
  const resolved = await mapWithConcurrency(players, 3, async (player, index) => {
    const started = Date.now();
    const onDiagnostic = (event) => logResolver(requestId, player, event);
    let direct = null;
    try { direct = await resolveDirectPlayer(player, sourcePageUrl, context, onDiagnostic); }
    catch (error) { onDiagnostic({ stage: 'resolve', result: 'error', reason: resolverErrorReason(error) }); }
    const tracks = subtitleTracks([{
      externalUrl: player.resolvedUrl,
      subtitles: direct?.subtitles || []
    }]);
    if (direct?.url) {
      onDiagnostic({ stage: 'result', result: 'direct', quality: direct.quality || direct.type,
        handedToStremio: direct.url, referer: direct.referer,
        elapsedMs: Date.now() - started });
      // Signed CDN URLs may be bound to the resolver's IP or expire before
      // client playback. Keep the original player selectable as a fallback.
      if (process.env.BOMBUJ_SHOW_ALL_SOURCES === '1' || direct.ephemeral || testDirectVoeAllowed(player.resolvedUrl)) {
        webFallbacks[index] = makeExternalStream(player, index, tracks);
      }
      return makeDirectStream(player, direct, index, tracks);
    }
    onDiagnostic({ stage: 'result', result: 'web-fallback', reason: 'no-direct-media',
      handedToStremio: player.resolvedUrl,
      elapsedMs: Date.now() - started });
    return makeExternalStream(player, index, tracks);
  });

  const direct = resolved.filter((stream) => stream?.url);
  const external = [...resolved.filter((stream) => stream?.externalUrl), ...webFallbacks.filter(Boolean)];
  return [...direct, ...external];
}


// Resolve IMDb requests by the source page's verified identity rather than
// trusting a localized search label. For new titles, inspect the first recent
// Bombuj listing pages if the website search cannot find the translated name.
async function inspectSources(type, items, imdbId, meta, season, episode, maxItems = 12) {
  const seen = new Set();
  const candidates = (items || []).filter(item => {
    if (!item?.detailUrl || seen.has(item.detailUrl)) return false;
    seen.add(item.detailUrl);
    return true;
  }).slice(0, maxItems);

  const checked = await mapWithConcurrency(candidates, 8, async item => {
    const referer = type === 'movie' ? BOMBUJ_BASE : BOMBUJ_SERIES_BASE;
    const html = await fetchText(item.detailUrl, {
      headers: { Referer: referer + '/' },
      signal: AbortSignal.timeout(8000)
    }).catch(() => '');
    if (!html) return null;

    let embeddedId = type === 'movie' ? movieImdbId(html) : null;
    let confidence = sourceIdentity(type, imdbId, meta, item, html, embeddedId);
    if (type === 'series' && confidence !== 1 &&
        Number.isInteger(season) && Number.isInteger(episode)) {
      const target = await findBombujSeriesEpisode(item, season, episode).catch(() => null);
      if (target) {
        const episodeHtml = await fetchText(target.episodeUrl, {
          headers: { Referer: item.detailUrl },
          signal: AbortSignal.timeout(8000)
        }).catch(() => '');
        embeddedId = seriesImdbId(episodeHtml);
        confidence = sourceIdentity(type, imdbId, meta, item, html, embeddedId);
      }
    }
    return confidence ? { item, confidence } : null;
  });
  const verified = checked.filter(Boolean).sort((a, b) => b.confidence - a.confidence)[0];
  if (!verified) return null;
  rememberSource(type, imdbId, verified.item);
  console.log('[source-match] ' + type + '/' + imdbId + ': ' +
    verified.item.detailUrl + ' confidence=' + verified.confidence);
  return verified.item;
}

async function resolveSource(type, imdbId, meta, season, episode) {
  const remembered = findSource(type, imdbId);
  if (remembered) return remembered;
  const key = type + ':' + imdbId;
  if (sourceResolvePending.has(key)) return sourceResolvePending.get(key);

  const work = (async () => {
    const started = Date.now();
    const titles = [...new Set([meta.name, ...(Array.isArray(meta.aliases) ? meta.aliases : [])]
      .map(t => String(t || '').trim()).filter(t => normalizeTitle(t).length >= 4))].slice(0, 3);
    for (const title of titles) {
      if (Date.now() - started >= 13000) break;
      const items = await (type === 'movie' ? searchBombujMovies(title) : searchBombujSeries(title))
        .catch(error => { console.warn('[source-search]',title,error.message); return []; });
      const verified = await inspectSources(type, items, imdbId, meta, season, episode);
      if (verified) return verified;
      if (Date.now() - started > 13000) break;
    }

    // A translated film/series is often absent from searches for its English
    // name. Bombuj's latest pages still provide an index of local detail URLs.
    // Keep this bounded to avoid scanning the entire site per Stremio request.
    if (Date.now() - started < 21000 && type === 'movie') {
      for (let page = 1; page <= 2; page++) {
        const cards = await listBombujMovies({ page }).catch(() => []);
        const verified = await inspectSources(type, cards, imdbId, meta, season, episode, 20);
        if (verified) return verified;
        if (!cards.length || Date.now() - started > 25000) break;
      }
    } else if (Date.now() - started < 21000 && type === 'series') {
      for (let page = 1; page <= 2; page++) {
        const cards = await fetchText(seriesBrowseUrl({ page }), {
          headers: { Referer: BOMBUJ_SERIES_BASE + '/' },
          signal: AbortSignal.timeout(8000)
        }).then(html => parseSeriesBrowseCards(html)).catch(() => []);
        const verified = await inspectSources(type, cards, imdbId, meta, season, episode, 5);
        if (verified) return verified;
        if (!cards.length || Date.now() - started > 25000) break;
      }
    }
    console.log('[source-match] ' + type + '/' + imdbId + ': no verified source');
    return null;
  })();
  sourceResolvePending.set(key, work);
  try { return await work; }
  finally { sourceResolvePending.delete(key); }
}

async function bombujStreams(args) {
  const imdbId = String(args.id || '').split(':')[0].toLowerCase();
  if (!/^tt\d{5,12}$/.test(imdbId)) return { streams: [] };
  const type = args.type;
  if (type !== 'movie' && type !== 'series') return { streams: [] };
  const meta = await getCinemetaMeta(type, imdbId).catch(() => null);
  const remembered = findSource(type, imdbId);
  if (!meta?.name && !remembered) return { streams: [] };

  let season, episode;
  if (type === 'series') {
    const parts = String(args.id).split(':');
    season = Number(parts[1]);
    episode = Number(parts[2]);
    if (!Number.isInteger(season) || season < 1 ||
        !Number.isInteger(episode) || episode < 1) return { streams: [] };
  }
  const best = remembered || await resolveSource(type, imdbId, meta, season, episode);
  if (!best) return { streams: [] };

  if (type === 'movie') {
    const players = await discoverBombujPlayers(best.detailUrl, BOMBUJ_BASE).catch(() => []);
    const year = String(meta?.releaseInfo || meta?.year || best.year || '').match(/(?:19|20)\d{2}/)?.[0];
    return { streams: await playersToStreams(players, best.detailUrl,
      { type: 'movie', title: meta?.name || best.title, year, imdbId }) };
  }
  const target = await findBombujSeriesEpisode(best, season, episode).catch(() => null);
  if (!target) return { streams: [] };
  const players = await discoverBombujPlayers(target.episodeUrl, BOMBUJ_SERIES_BASE, target.language).catch(() => []);
  return { streams: await playersToStreams(players, target.episodeUrl,
    { type: 'series', title: meta?.name || best.title, season, episode, imdbId }) };
}

const manifest = {
  id: 'community.caseycz.bombuj',
  version: '0.3.1',
  name: 'Bombuj',
  description: 'Bombuj.si katalogy a zdroje pro Stremio',
  resources: [
    { name: 'catalog', types: ['movie'] },
    { name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] }
  ],
  types: ['movie', 'series'],
  catalogs: [
    {
      type: 'movie',
      id: 'bombuj-movies',
      name: 'Bombuj – Filmy',
      extra: [
        { name: 'genre', options: GENRES },
        { name: 'search' },
        { name: 'skip' }
      ]
    }
  ],
  behaviorHints: { p2p: false }
};

const builder = new addonBuilder(manifest);

builder.defineCatalogHandler(async (args) => {
  if (args.type !== 'movie' || args.id !== 'bombuj-movies') return { metas: [] };
  try { return await bombujCatalog(args); }
  catch (error) {
    console.error('[catalog]', error);
    return { metas: [] };
  }
});

builder.defineStreamHandler(async (args) => {
  try { return await bombujStreams(args); }
  catch (error) {
    console.error('[stream]', error);
    return { streams: [] };
  }
});

serveHTTP(builder.getInterface(), { port: PORT });
console.log(`Bombuj Stremio addon listening on port ${PORT}`);

// Shared parser for catalogue titles without a reliable IMDb mapping.
module.exports = { discoverBombujPlayers, playersToStreams };
