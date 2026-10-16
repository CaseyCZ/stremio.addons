const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const ONLINE_BASE_URL = 'https://online.sktorrent.eu';
const SKTORRENT_BASE_URL = 'https://sktorrent.eu';
const SKTORRENT_SEARCH_URL = `${SKTORRENT_BASE_URL}/torrent/torrents_v2.php`;
const SLEDUJTETO_BASE_URL = 'https://www.sledujteto.cz';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const cache = new NodeCache({ stdTTL: 5 * 60, checkperiod: 60, maxKeys: 1600 });

const onlineHttp = axios.create({
  baseURL: ONLINE_BASE_URL,
  timeout: 10000,
  maxContentLength: 5 * 1024 * 1024,
  headers: {
    'User-Agent': USER_AGENT,
    'Accept-Encoding': 'identity',
    Accept: 'text/html,application/xhtml+xml,application/json'
  }
});

const sktorrentHttp = axios.create({
  timeout: 10000,
  maxContentLength: 5 * 1024 * 1024,
  headers: {
    'User-Agent': USER_AGENT,
    'Accept-Encoding': 'identity',
    Accept: 'text/html,application/xhtml+xml'
  }
});

const sledujtetoHttp = axios.create({
  timeout: 12000,
  maxContentLength: 8 * 1024 * 1024,
  headers: {
    'User-Agent': USER_AGENT,
    'Accept-Encoding': 'identity',
    Accept: 'text/html,application/xhtml+xml,application/json'
  }
});

function dedupe(values) { return [...new Set(values.filter(Boolean))]; }
function stripDiacritics(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function shortTitle(value, words = 3) { return String(value || '').split(/\s+/).filter(Boolean).slice(0, words).join(' '); }
function normalize(value) { return stripDiacritics(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }

function titleMatchScore(candidate, wantedTitles) {
  const source = normalize(candidate);
  if (!source) return 0;
  let best = 0;
  for (const wanted of wantedTitles) {
    const target = normalize(wanted);
    if (!target) continue;
    if (source === target) best = Math.max(best, 1);
    else if (source.includes(target) || target.includes(source)) best = Math.max(best, 0.95);
    else {
      const words = target.split(' ').filter(word => word.length > 1);
      if (!words.length) continue;
      const common = words.filter(word => source.includes(word)).length;
      best = Math.max(best, common / words.length);
    }
  }
  return best;
}

function buildQueries(titles, type, season, episode) {
  const queries = [];
  for (const raw of titles) {
    const base = String(raw || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (!base) continue;
    const variants = dedupe([base, stripDiacritics(base), shortTitle(stripDiacritics(base), 3), shortTitle(stripDiacritics(base), 1)]);
    if (type === 'series' && Number.isInteger(season) && Number.isInteger(episode)) {
      const sxxexx = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
      const x = `${season}x${String(episode).padStart(2, '0')}`;
      for (const variant of variants) queries.push(`${variant} ${sxxexx}`, `${variant} ${x}`);
    } else {
      queries.push(...variants.slice(0, 3));
    }
  }
  return dedupe(queries).slice(0, 8);
}

function languageFlags(text) {
  const flags = [];
  const pairs = [['CZ', '🇨🇿'], ['SK', '🇸🇰'], ['EN', '🇬🇧'], ['PL', '🇵🇱'], ['DE', '🇩🇪'], ['HU', '🇭🇺']];
  for (const [code, icon] of pairs) if (new RegExp(`\\b${code}\\b`, 'i').test(text)) flags.push(icon);
  return flags.join(' ');
}

function qualityLabel(label, src) {
  const text = `${label || ''} ${src || ''}`;
  const match = text.match(/\b(2160|1440|1080|720|480|360)p\b/i);
  if (match) return `${match[1]}p`;
  if (/\b4k\b/i.test(text)) return '2160p';
  if (/\bfull\s*hd\b|\bfhd\b/i.test(text)) return '1080p';
  if (/\bhd\b/i.test(text)) return '720p';
  return String(label || 'Direct').trim();
}

function cleanUrlText(value) {
  return String(value || '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .trim();
}

function absoluteUrl(value, baseUrl) {
  const raw = cleanUrlText(value);
  if (!raw || raw.startsWith('javascript:') || raw.startsWith('data:')) return null;
  try { return new URL(raw, baseUrl).toString(); } catch (_) { return null; }
}

function isPlayableMediaUrl(url) {
  return /\.(?:mp4|m3u8|webm|m4v|mov|ts)(?:$|[?#])/i.test(String(url || ''));
}

function proxyHints(referer) {
  return {
    notWebReady: false,
    proxyHeaders: {
      request: {
        Referer: referer,
        'User-Agent': USER_AGENT
      }
    }
  };
}

function makeStream(provider, pageTitle, url, label, referer) {
  const quality = qualityLabel(label, url);
  const flags = languageFlags(`${pageTitle} ${label || ''}`);
  return {
    name: `${provider} • ${quality}`,
    title: `${pageTitle || provider}${flags ? `\n${flags}` : ''}`,
    url,
    behaviorHints: proxyHints(referer)
  };
}

function dedupeStreams(streams) {
  const seen = new Set();
  return streams.filter(stream => {
    if (!stream || !stream.url || seen.has(stream.url)) return false;
    seen.add(stream.url);
    return true;
  });
}

function mediaUrlsFromHtml($, html, pageUrl) {
  const out = [];
  const add = (raw, label = '') => {
    const url = absoluteUrl(raw, pageUrl);
    if (url && isPlayableMediaUrl(url)) out.push({ url, label });
  };

  $('video source[src], video[src], source[src], #player a[href]').each((_, el) => {
    add($(el).attr('src') || $(el).attr('href'), $(el).attr('label') || $(el).attr('data-res') || $(el).attr('title') || '');
  });

  const unescaped = cleanUrlText(html);
  const matches = unescaped.match(/https?:\/\/[^\s"'<>]+?\.(?:mp4|m3u8|webm|m4v|mov|ts)(?:\?[^\s"'<>]*)?/gi) || [];
  for (const raw of matches) add(raw);

  const seen = new Set();
  return out.filter(item => !seen.has(item.url) && seen.add(item.url));
}

function videoIdsFromPage($) {
  const ids = [];
  $("a[href*='/video/']").each((_, el) => {
    const match = String($(el).attr('href') || '').match(/\/video\/(\d+)/);
    if (match) ids.push(match[1]);
  });
  return dedupe(ids).slice(0, 10);
}

async function searchVideoIds(query) {
  const key = `search:${query.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const response = await onlineHttp.get('/search/videos', { params: { search_query: query } });
    const $ = cheerio.load(response.data);
    const result = videoIdsFromPage($);
    cache.set(key, result);
    return result;
  } catch (error) {
    console.warn(`[sktonline] search "${query}": ${error.message}`);
    return [];
  }
}

async function streamsForOnlinePage(pageUrl, cacheKey = null) {
  const key = cacheKey || `online-page:${pageUrl}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const response = await onlineHttp.get(pageUrl, { headers: { Referer: ONLINE_BASE_URL } });
    const $ = cheerio.load(response.data);
    const pageTitle = $('title').text().replace(/\s+/g, ' ').trim();
    const media = mediaUrlsFromHtml($, response.data, pageUrl);
    const result = media.map(item => makeStream('SKTOnline', pageTitle, item.url, item.label, pageUrl));
    cache.set(key, result, 2 * 60);
    return result;
  } catch (error) {
    console.warn(`[sktonline] page ${pageUrl}: ${error.message}`);
    return [];
  }
}

async function streamsForVideo(videoId) {
  const pageUrl = `${ONLINE_BASE_URL}/video/${encodeURIComponent(videoId)}`;
  return streamsForOnlinePage(pageUrl, `video:${videoId}`);
}

async function searchTorrentDetails(query, wantedTitles) {
  const key = `skt-details:${query.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const response = await sktorrentHttp.get(SKTORRENT_SEARCH_URL, {
      params: { search: query, category: 0, active: 0, order: 'data', by: 'DESC', page: 0 }
    });
    const $ = cheerio.load(response.data);
    const items = [];
    const seen = new Set();
    $('a[href*="details.php"]').each((_, linkEl) => {
      const link = $(linkEl);
      const href = String(link.attr('href') || '');
      const idMatch = href.match(/[?&]id=([a-f0-9]{40})/i);
      if (!idMatch || seen.has(idMatch[1])) return;
      const name = String(link.attr('title') || link.find('img').attr('alt') || link.text() || '').replace(/\s+/g, ' ').trim();
      if (!name || titleMatchScore(name, wantedTitles) < 0.55) return;
      const detailsUrl = absoluteUrl(href, SKTORRENT_SEARCH_URL);
      if (!detailsUrl) return;
      seen.add(idMatch[1]);
      items.push({ id: idMatch[1], name, detailsUrl });
    });
    const result = items.slice(0, 8);
    cache.set(key, result, 10 * 60);
    return result;
  } catch (error) {
    console.warn(`[sktonline] SKTorrent search "${query}": ${error.message}`);
    return [];
  }
}

function providerUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'online.sktorrent.eu' || host === 'sledujteto.cz' || host.endsWith('.sledujteto.cz');
  } catch (_) {
    return false;
  }
}

function urlsFromText(text, baseUrl) {
  const normalized = cleanUrlText(text);
  const out = [];
  const absoluteMatches = normalized.match(/https?:\/\/[^\s"'<>\])}]+/gi) || [];
  for (const raw of absoluteMatches) {
    const url = absoluteUrl(raw, baseUrl);
    if (url) out.push(url);
  }
  return out;
}

async function onlineLinksFromTorrentDetail(candidate) {
  const key = `detail-links:${candidate.id}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const response = await sktorrentHttp.get(candidate.detailsUrl, { headers: { Referer: SKTORRENT_BASE_URL } });
    const $ = cheerio.load(response.data);
    const links = [];
    const addText = value => {
      for (const url of urlsFromText(value, candidate.detailsUrl)) if (providerUrl(url)) links.push(url);
    };

    $('a[href], iframe[src], frame[src], [data-src], [data-url], [onclick]').each((_, el) => {
      for (const attr of ['href', 'src', 'data-src', 'data-url', 'onclick']) {
        const value = $(el).attr(attr);
        if (value) addText(value);
      }
    });
    addText(response.data);

    const result = dedupe(links).slice(0, 10);
    cache.set(key, result, 10 * 60);
    return result;
  } catch (error) {
    console.warn(`[sktonline] SKTorrent detail ${candidate.id}: ${error.message}`);
    return [];
  }
}

async function discoverProviderLinks(titles, type, season, episode) {
  const queries = buildQueries(titles, type, season, episode);
  const candidates = new Map();
  for (const query of queries) {
    const found = await searchTorrentDetails(query, titles);
    for (const item of found) if (!candidates.has(item.id)) candidates.set(item.id, item);
    if (candidates.size >= 6) break;
  }
  const batches = await Promise.all([...candidates.values()].slice(0, 6).map(onlineLinksFromTorrentDetail));
  return dedupe(batches.flat()).slice(0, 12);
}

async function resolveOnlineSktorrentLink(url) {
  try {
    const parsed = new URL(url);
    const videoMatch = parsed.pathname.match(/\/video\/(\d+)/);
    if (videoMatch) return streamsForOnlinePage(url, `video-link:${videoMatch[1]}`);
    if (parsed.pathname.includes('/search/videos')) {
      const response = await onlineHttp.get(url, { headers: { Referer: SKTORRENT_BASE_URL } });
      const $ = cheerio.load(response.data);
      const ids = videoIdsFromPage($);
      const batches = await Promise.all(ids.slice(0, 5).map(streamsForVideo));
      return dedupeStreams(batches.flat());
    }
  } catch (error) {
    console.warn(`[sktonline] resolve ${url}: ${error.message}`);
  }
  return [];
}

function sledujtetoFileId(pageUrl, $, html) {
  try {
    const match = new URL(pageUrl).pathname.match(/\/file\/(\d+)/i);
    if (match) return match[1];
  } catch (_) {}
  const initScript = $('#player').attr('data-ng-init') || $('[data-ng-init*="init("]').first().attr('data-ng-init') || '';
  const initMatch = String(initScript).match(/init\s*\(\s*(\d+)/i);
  if (initMatch) return initMatch[1];
  const htmlMatch = String(html || '').match(/data-ng-init=["'][^"']*init\s*\(\s*(\d+)/i);
  return htmlMatch ? htmlMatch[1] : null;
}

function sledujtetoPlayerInit($, html, pageUrl) {
  const values = [
    $('#player').attr('data-ng-init'),
    $('[data-ng-init*="init("]').first().attr('data-ng-init')
  ].filter(Boolean);
  const rawMatch = String(html || '').match(/init\s*\(\s*(\d+)\s*,\s*['"]([^'"]+)['"]/i);
  if (rawMatch) values.push(`init(${rawMatch[1]},'${rawMatch[2]}')`);
  for (const value of values) {
    const match = String(value).match(/init\s*\(\s*(\d+)\s*,\s*['"]([^'"]+)['"]/i);
    if (!match) continue;
    const apiUrl = absoluteUrl(match[2], pageUrl);
    if (apiUrl) return { fileId: match[1], apiUrl };
  }
  return null;
}

function sourceItemsFromJson(value) {
  const out = [];
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    const file = node.file || node.video_url;
    if (typeof file === 'string' && isPlayableMediaUrl(file)) out.push({ url: file, label: String(node.label || node.quality || '') });
    for (const child of Object.values(node)) if (child && typeof child === 'object') walk(child);
  };
  walk(value);
  const seen = new Set();
  return out.filter(item => !seen.has(item.url) && seen.add(item.url));
}

function findVideoUrl(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.video_url === 'string') return value.video_url;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideoUrl(item);
      if (found) return found;
    }
    return null;
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const found = findVideoUrl(child);
      if (found) return found;
    }
  }
  return null;
}

async function streamsForSledujteto(pageUrl) {
  const pageKey = `sledujteto-page:${pageUrl}`;
  const cached = cache.get(pageKey);
  if (cached !== undefined) return cached;
  try {
    const response = await sledujtetoHttp.get(pageUrl, { headers: { Referer: SKTORRENT_BASE_URL } });
    const $ = cheerio.load(response.data);
    const pageTitle = $('title').text().replace(/\s+/g, ' ').trim() || 'Sledujteto';
    const streams = mediaUrlsFromHtml($, response.data, pageUrl)
      .map(item => makeStream('Sledujteto', pageTitle, item.url, item.label, pageUrl));

    const player = sledujtetoPlayerInit($, response.data, pageUrl);
    if (player) {
      try {
        const endpoint = new URL(String(player.fileId), player.apiUrl.endsWith('/') ? player.apiUrl : `${player.apiUrl}/`).toString();
        const info = await sledujtetoHttp.get(endpoint, { headers: { Referer: pageUrl } });
        for (const item of sourceItemsFromJson(info.data)) {
          const url = absoluteUrl(item.url, endpoint);
          if (url) streams.push(makeStream('Sledujteto', pageTitle, url, item.label, pageUrl));
        }
      } catch (error) {
        console.warn(`[sledujteto] player ${player.fileId}: ${error.message}`);
      }
    }

    const fileId = (player && player.fileId) || sledujtetoFileId(pageUrl, $, response.data);
    if (fileId) {
      try {
        const service = await sledujtetoHttp.post(`${SLEDUJTETO_BASE_URL}/services/add-file-link`, {
          params: { id: Number(fileId) }
        }, {
          headers: {
            'Content-Type': 'application/json',
            Origin: SLEDUJTETO_BASE_URL,
            Referer: pageUrl
          }
        });
        const rawVideoUrl = findVideoUrl(service.data);
        const url = absoluteUrl(rawVideoUrl, SLEDUJTETO_BASE_URL);
        if (url && isPlayableMediaUrl(url)) streams.push(makeStream('Sledujteto', pageTitle, url, '', pageUrl));
      } catch (error) {
        console.warn(`[sledujteto] link ${fileId}: ${error.message}`);
      }
    }

    const result = dedupeStreams(streams);
    // Sledujteto playback links are short-lived; do not keep them for the normal 5-minute cache TTL.
    cache.set(pageKey, result, result.length ? 60 : 90);
    return result;
  } catch (error) {
    console.warn(`[sledujteto] page ${pageUrl}: ${error.message}`);
    return [];
  }
}

async function resolveProviderLink(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'online.sktorrent.eu') return resolveOnlineSktorrentLink(url);
    if (host === 'sledujteto.cz' || host.endsWith('.sledujteto.cz')) {
      if (isPlayableMediaUrl(url)) return [makeStream('Sledujteto', 'Sledujteto', url, '', SLEDUJTETO_BASE_URL)];
      return streamsForSledujteto(url);
    }
  } catch (_) {}
  return [];
}

async function fallbackOnlineSearch(queries) {
  for (const query of queries) {
    const ids = await searchVideoIds(query);
    if (!ids.length) continue;
    const batches = await Promise.all(ids.slice(0, 5).map(streamsForVideo));
    const all = dedupeStreams(batches.flat());
    if (all.length) return all;
  }
  return [];
}

async function findOnlineStreams({ titles, type, season, episode }) {
  const queries = buildQueries(titles, type, season, episode);
  const providerLinks = await discoverProviderLinks(titles, type, season, episode);
  const resolvedBatches = await Promise.all(providerLinks.map(resolveProviderLink));
  const discovered = dedupeStreams(resolvedBatches.flat());

  // Keep the old direct SkTonline search as a fallback and merge it when it finds
  // another copy/quality that is not linked from the torrent detail page.
  const fallback = await fallbackOnlineSearch(queries);
  return dedupeStreams([...discovered, ...fallback]).slice(0, 15);
}

module.exports = { findOnlineStreams };
