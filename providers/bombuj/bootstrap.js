'use strict';

const http = require('http');
const { subtitleTracks, formatBombujStream } = require('./stream-display.js');

const originalFetch = global.fetch.bind(global);
const PUBLIC_PORT = Number(process.env.PORT || 7004);
const INTERNAL_PORT = Number(process.env.BOMBUJ_INTERNAL_PORT || (PUBLIC_PORT + 1));
const VERSION = require('./package.json').version;
const cinemetaMetaByTitle = new Map();
const subtitleCache = new Map();

console.log('[bootstrap] Bombuj bootstrap active');

function responseFromText(source, text, contentType = null) {
  const headers = new Headers(source?.headers || {});
  if (contentType) headers.set('content-type', contentType);
  return new Response(text, {
    status: source?.status || 200,
    statusText: source?.statusText || 'OK',
    headers
  });
}

function unique(values) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function stripTags(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(value) {
  return stripTags(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function significantTokens(value) {
  return normalizeText(value)
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !/^(the|and|with|from|into|out|this|that|film|movie)$/i.test(word));
}

function extractYear(value) {
  return String(value || '').match(/\b(?:19|20)\d{2}\b/)?.[0] || null;
}

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function decodeUrlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#0*38;/gi, '&');
}

function rememberCinemetaMeta(metaRequest, meta) {
  if (!meta?.name) return;
  const record = {
    imdbId: metaRequest.imdbId,
    type: metaRequest.type,
    name: String(meta.name),
    year: extractYear(meta.releaseInfo || meta.year || meta.released || ''),
    aliases: Array.isArray(meta.aliases) ? meta.aliases.map(String) : []
  };
  for (const title of [record.name, ...record.aliases]) {
    const key = normalizeText(title);
    if (key) cinemetaMetaByTitle.set(key, record);
  }
  console.log(`[diag] Cinemeta ${record.imdbId}: name="${record.name}" year=${record.year || '-'} aliases=${record.aliases.length}`);
}

function searchVariants(query) {
  const clean = String(query || '').replace(/\s+/g, ' ').trim();
  const beforeParen = clean.replace(/\s*\((?:19|20)\d{2}\)\s*$/, '').trim();
  const beforeColon = beforeParen.split(':')[0]?.trim();
  const words = beforeParen.match(/[\p{L}\p{N}]+/gu) || [];
  const meaningful = words.filter((word) => word.length >= 4 && !/^(the|and|with|from|into|out|of)$/i.test(word));
  return unique([clean, beforeParen, beforeColon, meaningful.slice(0, 2).join(' '), meaningful[0]]);
}

function isBombujSearch(url, init) {
  if (String(init?.method || 'GET').toUpperCase() !== 'POST') return false;
  try {
    const parsed = new URL(String(url));
    return /(^|\.)bombuj\.si$/i.test(parsed.hostname) && parsed.pathname.endsWith('/4154q37rpc4dsvbp.php');
  } catch {
    return false;
  }
}

function readQuery(body) {
  if (typeof body !== 'string') return '';
  try { return new URLSearchParams(body).get('queryString') || ''; }
  catch { return ''; }
}

function hasSuggestion(html) {
  return /class=["']nazov["']/i.test(html) && /(?:online-(?:film|serial)-|\/serial\/|serial-)/i.test(html);
}

function summarizeSuggestions(html) {
  const out = [];
  for (const match of String(html || '').matchAll(/<span class=["']nazov["']>([\s\S]*?)<\/span>/gi)) {
    out.push(stripTags(match[1]));
    if (out.length >= 5) break;
  }
  return out;
}

const verifiedOriginalTitleCache = new Map();

function bombujSuggestionDetailUrl(html, matchIndex) {
  const prefix = String(html || '').slice(Math.max(0, matchIndex - 2400), matchIndex);
  const anchors = [...prefix.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']*online-film-[^"']+)["']/gi)];
  const href = anchors.at(-1)?.[1];
  if (!href) return null;
  try {
    const url = new URL(decodeUrlEntities(href), 'https://www.bombuj.si');
    if (!/^(?:www\.)?bombuj\.si$/i.test(url.hostname) || !/^\/online-film-[^/]+$/i.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function confirmOriginalTitleFromBombuj(detailUrl, originalQuery) {
  if (!detailUrl) return false;
  const key = detailUrl + '|' + normalizeText(originalQuery);
  const cached = verifiedOriginalTitleCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.confirmed;

  let confirmed = false;
  try {
    const response = await originalFetch(detailUrl, {
      signal: AbortSignal.timeout(7000),
      headers: {
        'User-Agent': 'Mozilla/5.0',
        Accept: 'text/html,application/xhtml+xml',
        Referer: 'https://www.bombuj.si/'
      }
    });
    if (response.ok) {
      const html = await response.text();
      const headings = [...html.matchAll(/<h[12]\b[^>]*>([\s\S]*?)<\/h[12]>/gi)]
        .map((match) => stripTags(match[1]));
      const target = normalizeText(originalQuery);
      confirmed = headings.some((heading) =>
        heading.split(/\s+[-–—]\s+/).some((part) => normalizeText(part) === target)
      );
    }
  } catch (error) {
    console.warn('[Bombuj match] detail title check failed:', String(error?.message || error));
  }

  verifiedOriginalTitleCache.set(key, { confirmed, expiresAt: Date.now() + (confirmed ? 12 * 60 * 60 * 1000 : 5 * 60 * 1000) });
  return confirmed;
}

async function enrichLocalizedSuggestionAliases(html, originalQuery) {
  const meta = cinemetaMetaByTitle.get(normalizeText(originalQuery));
  if (!meta?.year) return html;

  const input = String(html || '');
  const queryTokens = significantTokens(originalQuery);
  const re = /<span class=["']nazov["']>([\s\S]*?)<\/span>(\s*<span class=["']zanre["']>([\s\S]*?)<\/span>)?/gi;
  let output = '';
  let offset = 0;

  for (const match of input.matchAll(re)) {
    const [whole, rawTitle, zanreBlock = '', rawGenre = ''] = match;
    const plainTitle = stripTags(rawTitle);
    const candidateYear = extractYear(plainTitle) || extractYear(stripTags(rawGenre));
    let updated = whole;

    if (candidateYear === meta.year) {
      const candidateTokens = new Set(significantTokens(plainTitle));
      const shared = queryTokens.filter((token) => candidateTokens.has(token));
      const verified = shared.length
        ? true
        : await confirmOriginalTitleFromBombuj(bombujSuggestionDetailUrl(input, match.index), originalQuery);

      if (verified && normalizeText(plainTitle.replace(/\s*\((?:19|20)\d{2}\)\s*$/, '')) !== normalizeText(originalQuery)) {
        const titleWithoutYear = plainTitle.replace(/\s*\((?:19|20)\d{2}\)\s*$/, '').trim();
        const yearSuffix = extractYear(plainTitle) ? ' (' + candidateYear + ')' : '';
        const method = shared.length ? 'token: ' + shared[0] : 'verified original title on detail';
        console.log('[Bombuj match] localized title: "' + titleWithoutYear + '" ~= "' + originalQuery + '" (' + candidateYear + ', ' + method + ')');
        updated = '<span class="nazov">' + htmlEscape(titleWithoutYear) + ' - ' + htmlEscape(originalQuery) + yearSuffix + '</span>' + zanreBlock;
      }
    }

    output += input.slice(offset, match.index) + updated;
    offset = match.index + whole.length;
  }
  return output + input.slice(offset);
}

function parseCinemetaMetaUrl(url) {
  try {
    const parsed = new URL(String(url));
    if (!/(^|\.)v3-cinemeta\.strem\.io$/i.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/^\/meta\/(movie|series)\/(tt\d+)\.json$/i);
    return match ? { type: match[1].toLowerCase(), imdbId: match[2] } : null;
  } catch {
    return null;
  }
}

async function fetchCinemetaMetaWithFallback(input, init, metaRequest) {
  console.log(`[diag] Cinemeta request ${metaRequest.type}/${metaRequest.imdbId}`);
  let primary = null;
  let primaryText = '';
  try {
    primary = await originalFetch(input, init);
    primaryText = await primary.text();
    if (primary.ok) {
      try {
        const parsed = JSON.parse(primaryText);
        if (parsed?.meta?.name) {
          rememberCinemetaMeta(metaRequest, parsed.meta);
          return responseFromText(primary, primaryText, 'application/json');
        }
      } catch {}
    }
  } catch (error) {
    console.warn('[diag] Cinemeta primary failed:', error?.message || error);
  }

  const fallbackUrl = `https://v3-cinemeta.strem.io/catalog/${metaRequest.type}/top/search=${encodeURIComponent(metaRequest.imdbId)}.json`;
  try {
    const fallback = await originalFetch(fallbackUrl, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (fallback.ok) {
      const data = await fallback.json();
      const metas = Array.isArray(data?.metas) ? data.metas : [];
      const exact = metas.find((item) => String(item?.id || item?.imdb_id || '').toLowerCase() === metaRequest.imdbId.toLowerCase());
      if (exact?.name) {
        rememberCinemetaMeta(metaRequest, exact);
        console.log(`[Cinemeta] meta fallback: ${metaRequest.imdbId} -> catalog search`);
        return responseFromText(fallback, JSON.stringify({ meta: exact }), 'application/json');
      }
    }
  } catch (error) {
    console.warn('[Cinemeta] catalog fallback failed:', error?.message || error);
  }

  if (primary) return responseFromText(primary, primaryText, 'application/json');
  return originalFetch(input, init);
}

global.fetch = async function resilientFetch(input, init = {}) {
  const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || input);
  const url = decodeUrlEntities(rawUrl);
  const normalizedInput = (typeof input === 'string' || input instanceof URL) ? url : input;

  if (url !== rawUrl && /(^|\.)bombuj\.si\//i.test(url)) {
    console.log(`[Bombuj URL] decoded HTML entities: ${rawUrl} -> ${url}`);
  }

  const cinemetaMeta = parseCinemetaMetaUrl(url);
  if (cinemetaMeta) return fetchCinemetaMetaWithFallback(normalizedInput, init, cinemetaMeta);
  if (!isBombujSearch(url, init)) return originalFetch(normalizedInput, init);

  const originalQuery = readQuery(init.body);
  const variants = searchVariants(originalQuery);
  let firstResponse = null;
  let firstText = '';

  for (let index = 0; index < variants.length; index += 1) {
    const query = variants[index];
    const response = await originalFetch(url, { ...init, body: `queryString=${encodeURIComponent(query)}` });
    const text = await response.text();
    if (index === 0) { firstResponse = response; firstText = text; }
    console.log(`[diag] Bombuj search query="${query}" status=${response.status} suggestions=${JSON.stringify(summarizeSuggestions(text))}`);
    if (response.ok && hasSuggestion(text)) {
      if (query !== originalQuery) console.log(`[Bombuj search] fallback: "${originalQuery}" -> "${query}"`);
      return responseFromText(response, await enrichLocalizedSuggestionAliases(text, originalQuery));
    }
  }

  if (firstResponse) return responseFromText(firstResponse, firstText);
  return originalFetch(normalizedInput, init);
};

function subtitleUrlsFromStream(stream) {
  return subtitleTracks([stream]);
}

function collectSubtitles(streams) {
  return subtitleTracks(streams);
}


function nativeTitle(stream) {
  return formatBombujStream(stream).title;
}

function streamCacheKey(type, id) {
  return `${String(type || '')}:${String(id || '')}`;
}

function transformStreamPayload(type, id, payload) {
  const discovered = Array.isArray(payload?.streams) ? payload.streams : [];
  const subtitles = collectSubtitles(discovered);
  if (subtitles.length) subtitleCache.set(streamCacheKey(type, id), { expiresAt: Date.now() + 20 * 60 * 1000, subtitles });

  const streams = discovered
    .filter((stream) => stream?.url && /^https?:\/\//i.test(String(stream.url)))
    .map((stream) => ({
      ...formatBombujStream(stream),
      externalUrl: undefined
    }));

  console.log(`[native] ${type}/${id}: playable=${streams.length} discovered=${discovered.length} subtitles=${subtitles.length}`);
  return { streams };
}

function manifestPayload(payload) {
  const resources = Array.isArray(payload?.resources) ? [...payload.resources] : [];
  if (!resources.some((resource) => resource === 'subtitles' || resource?.name === 'subtitles')) {
    resources.push({ name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] });
  }
  return { ...payload, version: VERSION, resources };
}

function parseResourcePath(pathname, resource) {
  const match = pathname.match(new RegExp(`^/${resource}/(movie|series)/(.+)\\.json$`, 'i'));
  if (!match) return null;
  return { type: match[1].toLowerCase(), id: decodeURIComponent(match[2]) };
}

async function internalJson(pathname) {
  const response = await originalFetch(`http://127.0.0.1:${INTERNAL_PORT}${pathname}`);
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { response, text, json };
}

async function subtitlesFor(type, id) {
  const key = streamCacheKey(type, id);
  const cached = subtitleCache.get(key);
  if (cached && cached.expiresAt >= Date.now()) return cached.subtitles;
  subtitleCache.delete(key);

  const streamPath = `/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  const result = await internalJson(streamPath).catch(() => null);
  if (!result?.json) return [];
  transformStreamPayload(type, id, result.json);
  const refreshed = subtitleCache.get(key);
  return refreshed?.subtitles || [];
}

async function proxyRequest(req, res) {
  try {
    const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${PUBLIC_PORT}`);
    const subtitleRequest = parseResourcePath(requestUrl.pathname, 'subtitles');
    if (subtitleRequest) {
      const subtitles = await subtitlesFor(subtitleRequest.type, subtitleRequest.id);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      });
      res.end(JSON.stringify({ subtitles }));
      return;
    }

    const internal = await internalJson(`${requestUrl.pathname}${requestUrl.search}`);
    let body = internal.text;
    let contentType = internal.response.headers.get('content-type') || 'application/json; charset=utf-8';

    if (requestUrl.pathname === '/manifest.json' && internal.json) {
      body = JSON.stringify(manifestPayload(internal.json));
    } else {
      const streamRequest = parseResourcePath(requestUrl.pathname, 'stream');
      if (streamRequest && internal.json) body = JSON.stringify(transformStreamPayload(streamRequest.type, streamRequest.id, internal.json));
    }

    const headers = {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    };
    res.writeHead(internal.response.status, headers);
    res.end(body);
  } catch (error) {
    console.error('[proxy]', error?.stack || error);
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Bombuj internal addon unavailable' }));
  }
}

process.env.PORT = String(INTERNAL_PORT);
require('./index.js');

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS'
    });
    res.end();
    return;
  }
  proxyRequest(req, res);
});

server.listen(PUBLIC_PORT, '127.0.0.1', () => {
  console.log(`[bootstrap] Bombuj public wrapper listening on 127.0.0.1:${PUBLIC_PORT} -> internal ${INTERNAL_PORT}`);
});
