const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const ONLINE_BASE_URL = 'https://online.sktorrent.eu';
const SLEDUJTETO_BASE_URL = 'https://www.sledujteto.cz';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const cache = new NodeCache({ stdTTL: 5 * 60, checkperiod: 60, maxKeys: 1600 });

const onlineHttp = axios.create({
  baseURL: ONLINE_BASE_URL,
  timeout: 9000,
  maxContentLength: 5 * 1024 * 1024,
  headers: {
    'User-Agent': USER_AGENT,
    Referer: `${ONLINE_BASE_URL}/`,
    'Accept-Encoding': 'identity',
    Accept: 'text/html,application/xhtml+xml,application/json'
  }
});

const sledujtetoHttp = axios.create({
  baseURL: SLEDUJTETO_BASE_URL,
  timeout: 9000,
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
function slugify(value) { return normalize(value).replace(/\s+/g, '-'); }

function titleMatchScore(candidate, wantedTitles) {
  const source = normalize(candidate);
  if (!source) return 0;
  let best = 0;
  for (const wanted of wantedTitles) {
    const target = normalize(wanted);
    if (!target) continue;
    if (source === target) best = Math.max(best, 1);
    else if (source.includes(target)) best = Math.max(best, 0.98);
    else if (target.includes(source) && source.length >= 4) best = Math.max(best, 0.85);
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
    const variants = dedupe([base, stripDiacritics(base), shortTitle(stripDiacritics(base), 3)]);
    if (type === 'series' && Number.isInteger(season) && Number.isInteger(episode)) {
      const sxxexx = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
      const x = `${season}x${String(episode).padStart(2, '0')}`;
      for (const variant of variants) queries.push(`${variant} ${sxxexx}`, `${variant} ${x}`);
      queries.push(base);
    } else {
      queries.push(...variants);
    }
  }
  return dedupe(queries).slice(0, 6);
}

function languageFlags(text) {
  const flags = [];
  const pairs = [['CZ', '🇨🇿'], ['SK', '🇸🇰'], ['EN', '🇬🇧'], ['PL', '🇵🇱'], ['DE', '🇩🇪'], ['HU', '🇭🇺']];
  for (const [code, icon] of pairs) if (new RegExp(`\\b${code}\\b`, 'i').test(text)) flags.push(icon);
  return flags.join(' ');
}

function qualityLabel(label, src) {
  const text = `${label || ''} ${src || ''}`;
  const match = text.match(/\b(2160|1440|1080|720|480|360)p?\b/i);
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

function isHttpUrl(url) {
  return /^https?:\/\//i.test(String(url || ''));
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
    add(
      $(el).attr('src') || $(el).attr('href'),
      $(el).attr('label') || $(el).attr('res') || $(el).attr('data-res') || $(el).attr('title') || ''
    );
  });

  const unescaped = cleanUrlText(html);
  const matches = unescaped.match(/https?:\/\/[^\s"'<>]+?\.(?:mp4|m3u8|webm|m4v|mov|ts)(?:\?[^\s"'<>]*)?/gi) || [];
  for (const raw of matches) add(raw);

  const seen = new Set();
  return out.filter(item => !seen.has(item.url) && seen.add(item.url));
}

function onlineVideoItemsFromPage($) {
  const items = [];
  const seen = new Set();
  $("a[href*='/video/']").each((_, el) => {
    const href = String($(el).attr('href') || '');
    const match = href.match(/\/video\/(\d+)/);
    if (!match || seen.has(match[1])) return;
    seen.add(match[1]);
    const card = $(el).closest('article, .video, .well, .col-sm-6, .col-md-3, .col-lg-3, li, div');
    const title = String($(el).attr('title') || $(el).find('[title]').first().attr('title') || card.find('[title]').first().attr('title') || $(el).text() || card.text() || '')
      .replace(/\s+/g, ' ').trim();
    items.push({ id: match[1], title });
  });
  return items.slice(0, 15);
}

async function searchOnlineVideoIds(query, wantedTitles) {
  const key = `online-search:${query.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const response = await onlineHttp.get('/search/videos', {
      params: { t: 'a', o: 'mr', type: 'public', search_query: query }
    });
    const $ = cheerio.load(response.data);
    const items = onlineVideoItemsFromPage($);
    const matched = items.filter(item => !item.title || titleMatchScore(item.title, wantedTitles) >= 0.45);
    const result = (matched.length ? matched : items).map(item => item.id).slice(0, 8);
    cache.set(key, result, 5 * 60);
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
    const response = await onlineHttp.get(pageUrl, { headers: { Referer: `${ONLINE_BASE_URL}/` } });
    const $ = cheerio.load(response.data);
    const pageTitle = $('title').text().replace(/\s+/g, ' ').trim();
    const media = mediaUrlsFromHtml($, response.data, pageUrl);
    const result = media.map(item => makeStream('SKTOnline', pageTitle, item.url, item.label, `${ONLINE_BASE_URL}/`));
    cache.set(key, result, result.length ? 2 * 60 : 60);
    return result;
  } catch (error) {
    console.warn(`[sktonline] page ${pageUrl}: ${error.message}`);
    return [];
  }
}

async function streamsForOnlineVideo(videoId) {
  return streamsForOnlinePage(`${ONLINE_BASE_URL}/video/${encodeURIComponent(videoId)}/`, `online-video:${videoId}`);
}

async function findSktOnlineByTitle(queries, titles) {
  for (const query of queries.slice(0, 4)) {
    const ids = await searchOnlineVideoIds(query, titles);
    if (!ids.length) continue;
    const batches = await Promise.all(ids.slice(0, 6).map(streamsForOnlineVideo));
    const all = dedupeStreams(batches.flat());
    if (all.length) return all.slice(0, 10);
  }
  return [];
}

function sledujtetoPageUrlFromItem(item) {
  if (!item || typeof item !== 'object') return null;
  const raw = item.url || item.link || item.href || item.web_url || item.webUrl || item.page_url || item.pageUrl;
  const url = absoluteUrl(raw, SLEDUJTETO_BASE_URL);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if ((parsed.hostname === 'sledujteto.cz' || parsed.hostname.endsWith('.sledujteto.cz')) && /\/file\/\d+/i.test(parsed.pathname)) return url;
  } catch (_) {}
  return null;
}

function sledujtetoItemTitle(item, pageUrl) {
  if (!item || typeof item !== 'object') return pageUrl || '';
  return String(item.name || item.title || item.filename || item.file_name || item.label || item.description || pageUrl || '').replace(/\s+/g, ' ').trim();
}

async function searchSledujtetoApi(query, wantedTitles) {
  const key = `sledujteto-search:${query.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const response = await sledujtetoHttp.get('/api/web/videos', {
      params: {
        query,
        page: 1,
        limit: 30,
        collection: 'suggestions',
        sort: 'relevance',
        me: 0,
        excluded_ids: ''
      },
      headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: `${SLEDUJTETO_BASE_URL}/` }
    });
    const files = Array.isArray(response.data?.data?.files)
      ? response.data.data.files
      : Array.isArray(response.data?.files)
        ? response.data.files
        : Array.isArray(response.data)
          ? response.data
          : [];
    const urls = [];
    for (const item of files) {
      const pageUrl = sledujtetoPageUrlFromItem(item);
      if (!pageUrl) continue;
      const title = sledujtetoItemTitle(item, pageUrl);
      if (titleMatchScore(title, wantedTitles) >= 0.45 || titleMatchScore(pageUrl, wantedTitles) >= 0.45) urls.push(pageUrl);
    }
    const result = dedupe(urls).slice(0, 8);
    cache.set(key, result, result.length ? 5 * 60 : 60);
    return result;
  } catch (error) {
    console.warn(`[sledujteto] API search "${query}": ${error.message}`);
    return [];
  }
}

async function searchSledujtetoSlug(query, wantedTitles) {
  const slug = slugify(query);
  if (!slug) return [];
  const pageUrl = `${SLEDUJTETO_BASE_URL}/vyhledat/${encodeURIComponent(slug)}.html`;
  const key = `sledujteto-slug:${slug}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const response = await sledujtetoHttp.get(pageUrl, { headers: { Referer: `${SLEDUJTETO_BASE_URL}/` } });
    const $ = cheerio.load(response.data);
    const finalUrl = absoluteUrl(response.request?.res?.responseUrl || pageUrl, SLEDUJTETO_BASE_URL) || pageUrl;
    const urls = [];
    if ($('#player').length || $('[data-ng-init*="init("]').length) urls.push(finalUrl);
    $('a[href*="/file/"]').each((_, el) => {
      const url = absoluteUrl($(el).attr('href'), finalUrl);
      if (!url) return;
      const title = String($(el).attr('title') || $(el).text() || url).replace(/\s+/g, ' ').trim();
      if (titleMatchScore(title, wantedTitles) >= 0.45 || titleMatchScore(url, wantedTitles) >= 0.45) urls.push(url);
    });
    const result = dedupe(urls).slice(0, 8);
    cache.set(key, result, result.length ? 5 * 60 : 60);
    return result;
  } catch (error) {
    console.warn(`[sledujteto] slug search "${query}": ${error.message}`);
    return [];
  }
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
    const file = node.file || node.video_url || node.videoUrl || node.url;
    if (typeof file === 'string' && isHttpUrl(file)) out.push({ url: file, label: String(node.label || node.quality || node.res || '') });
    for (const child of Object.values(node)) if (child && typeof child === 'object') walk(child);
  };
  walk(value);
  const seen = new Set();
  return out.filter(item => !seen.has(item.url) && seen.add(item.url));
}

function findVideoUrl(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['video_url', 'videoUrl', 'file']) {
    if (typeof value[key] === 'string' && isHttpUrl(value[key])) return value[key];
  }
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
    const response = await sledujtetoHttp.get(pageUrl, { headers: { Referer: `${SLEDUJTETO_BASE_URL}/` } });
    const finalUrl = absoluteUrl(response.request?.res?.responseUrl || pageUrl, SLEDUJTETO_BASE_URL) || pageUrl;
    const $ = cheerio.load(response.data);
    const pageTitle = $('title').text().replace(/\s+/g, ' ').trim() || 'SledujTo';
    const streams = mediaUrlsFromHtml($, response.data, finalUrl)
      .map(item => makeStream('SledujTo', pageTitle, item.url, item.label, finalUrl));

    const player = sledujtetoPlayerInit($, response.data, finalUrl);
    if (player) {
      try {
        const endpoint = new URL(String(player.fileId), player.apiUrl.endsWith('/') ? player.apiUrl : `${player.apiUrl}/`).toString();
        const info = await sledujtetoHttp.get(endpoint, { headers: { Referer: finalUrl } });
        for (const item of sourceItemsFromJson(info.data)) {
          const url = absoluteUrl(item.url, endpoint);
          if (url && isHttpUrl(url)) streams.push(makeStream('SledujTo', pageTitle, url, item.label, finalUrl));
        }
      } catch (error) {
        console.warn(`[sledujteto] player ${player.fileId}: ${error.message}`);
      }
    }

    const fileId = (player && player.fileId) || sledujtetoFileId(finalUrl, $, response.data);
    if (fileId) {
      try {
        const service = await sledujtetoHttp.post('/services/add-file-link', {
          params: { id: Number(fileId) }
        }, {
          headers: {
            'Content-Type': 'application/json',
            Origin: SLEDUJTETO_BASE_URL,
            Referer: finalUrl
          }
        });
        const rawVideoUrl = findVideoUrl(service.data);
        const url = absoluteUrl(rawVideoUrl, SLEDUJTETO_BASE_URL);
        if (url && isHttpUrl(url)) streams.push(makeStream('SledujTo', pageTitle, url, '', finalUrl));
      } catch (error) {
        console.warn(`[sledujteto] link ${fileId}: ${error.message}`);
      }
    }

    const result = dedupeStreams(streams);
    cache.set(pageKey, result, result.length ? 60 : 60);
    return result;
  } catch (error) {
    console.warn(`[sledujteto] page ${pageUrl}: ${error.message}`);
    return [];
  }
}

async function findSledujtetoByTitle(queries, titles) {
  for (const query of queries.slice(0, 4)) {
    let pages = await searchSledujtetoApi(query, titles);
    if (!pages.length) pages = await searchSledujtetoSlug(query, titles);
    if (!pages.length) continue;
    const batches = await Promise.all(pages.slice(0, 6).map(streamsForSledujteto));
    const all = dedupeStreams(batches.flat());
    if (all.length) return all.slice(0, 10);
  }
  return [];
}

async function findOnlineStreams({ titles, type, season, episode }) {
  const queries = buildQueries(titles, type, season, episode);
  const [sktOnline, sledujTo] = await Promise.all([
    findSktOnlineByTitle(queries, titles),
    findSledujtetoByTitle(queries, titles)
  ]);
  return dedupeStreams([...sledujTo, ...sktOnline]).slice(0, 15);
}

module.exports = { findOnlineStreams };
