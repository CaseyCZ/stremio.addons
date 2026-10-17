const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const { getCsfdUrl } = require('./csfd');
const { getClient } = require('./sktorrent');

const SKTORRENT_BASE_URL = 'https://sktorrent.eu';
const SKTORRENT_SEARCH_URL = `${SKTORRENT_BASE_URL}/torrent/torrents_v2.php`;
const ONLINE_BASE_URL = 'https://online.sktorrent.eu';
const SLEDUJTETO_BASE_URL = 'https://www.sledujteto.cz';
const RESOLVER_BASE_URL = String(process.env.SKTONLINE_RESOLVER_URL || '').replace(/\/+$/, '');
const RESOLVER_TOKEN = String(process.env.SKTONLINE_RESOLVER_TOKEN || '').trim();
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const cache = new NodeCache({ stdTTL: 5 * 60, checkperiod: 60, maxKeys: 1800 });

const LANGUAGE_DEFS = [
  { code: 'CZ', flag: '🇨🇿', aliases: ['CZ', 'CS', 'CZE', 'CES'] },
  { code: 'SK', flag: '🇸🇰', aliases: ['SK', 'SLK', 'SLO'] },
  { code: 'EN', flag: '🇬🇧', aliases: ['EN', 'ENG'] },
  { code: 'PL', flag: '🇵🇱', aliases: ['PL', 'POL'] },
  { code: 'DE', flag: '🇩🇪', aliases: ['DE', 'GER', 'DEU'] },
  { code: 'HU', flag: '🇭🇺', aliases: ['HU', 'HUN'] }
];

function makeHttp(baseURL, timeout = 9000) {
  return axios.create({
    baseURL,
    timeout,
    maxContentLength: 8 * 1024 * 1024,
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Encoding': 'identity',
      Accept: 'text/html,application/xhtml+xml,application/json,*/*'
    }
  });
}

const sktorrentHttp = makeHttp(SKTORRENT_BASE_URL, 9000);
const onlineHttp = makeHttp(ONLINE_BASE_URL, 9000);
const sledujtetoHttp = makeHttp(SLEDUJTETO_BASE_URL, 9000);
const resolverHttp = RESOLVER_BASE_URL ? makeHttp(RESOLVER_BASE_URL, 12000) : null;

async function resolverPost(path, body) {
  if (!resolverHttp) throw new Error('SKTOnline resolver is not configured');
  const response = await resolverHttp.post(path, body, {
    headers: RESOLVER_TOKEN ? { Authorization: `Bearer ${RESOLVER_TOKEN}` } : {}
  });
  return response.data || {};
}

function dedupe(values) { return [...new Set(values.filter(Boolean))]; }
function stripDiacritics(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function shortTitle(value, words = 3) { return String(value || '').split(/\s+/).filter(Boolean).slice(0, words).join(' '); }
function stripYearTokens(value) { return String(value || '').replace(/\b(?:19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim(); }
function normalize(value) { return stripDiacritics(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function slugify(value) { return normalize(value).replace(/\s+/g, '-'); }

function yearsInText(value) {
  return dedupe((String(value || '').match(/\b(?:19|20)\d{2}\b/g) || []));
}

function candidateYearMatches(candidate, wantedTitles) {
  const wantedYears = dedupe((wantedTitles || []).flatMap(yearsInText));
  if (!wantedYears.length) return true;
  const candidateYears = yearsInText(candidate);
  if (!candidateYears.length) return true;
  return candidateYears.some(year => wantedYears.includes(year));
}

function candidateHasConflictingYears(candidate, wantedTitles) {
  const wantedYears = dedupe((wantedTitles || []).flatMap(yearsInText));
  if (wantedYears.length !== 1) return false;
  const candidateYears = yearsInText(candidate);
  return candidateYears.some(year => year !== wantedYears[0]);
}

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
    const plain = stripDiacritics(base);
  const variants = type === 'movie'
    ? dedupe([stripYearTokens(base), stripYearTokens(plain), base, plain, shortTitle(stripYearTokens(plain), 3), shortTitle(stripYearTokens(plain), 2)])
    : dedupe([base, plain, shortTitle(plain, 3), shortTitle(plain, 1)]);
    if (type === 'series' && Number.isInteger(season) && Number.isInteger(episode)) {
      const sxxexx = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
      const x = `${season}x${String(episode).padStart(2, '0')}`;
      for (const variant of variants) queries.push(`${variant} ${sxxexx}`, `${variant} ${x}`);
      queries.push(base);
    } else {
      queries.push(...variants);
    }
  }
  return dedupe(queries).slice(0, 12);
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

function isHttpUrl(url) { return /^https?:\/\//i.test(String(url || '')); }
function isPlayableMediaUrl(url) { return /\.(?:mp4|m3u8|webm|m4v|mov|ts)(?:$|[?#])/i.test(String(url || '')); }

function languageDefForAlias(alias) {
  const upper = String(alias || '').toUpperCase();
  return LANGUAGE_DEFS.find(def => def.aliases.includes(upper)) || null;
}

function languageCodesInText(text) {
  const source = String(text || '').toUpperCase();
  const out = [];
  for (const def of LANGUAGE_DEFS) {
    if (def.aliases.some(alias => new RegExp(`\\b${alias}\\b`, 'i').test(source))) out.push(def.code);
  }
  return out;
}

function releaseLanguageCodesInText(text) {
  const source = stripDiacritics(String(text || '')).toUpperCase();
  const out = [];
  const groups = source.matchAll(/[\[(]\s*([A-Z]{2,3}(?:\s*[\/+ ,]\s*[A-Z]{2,3}){0,4})\s*[\])]/g);
  for (const match of groups) {
    for (const token of String(match[1] || '').split(/[\/+ ,]+/)) {
      const def = languageDefForAlias(token);
      if (def) out.push(def.code);
    }
  }
  return dedupe(out);
}

function candidateLanguagePriority(text) {
  const codes = releaseLanguageCodesInText(text);
  if (codes.includes('CZ') && codes.includes('EN')) return 0;
  if (codes.length === 1 && codes[0] === 'CZ') return 1;
  if (codes.includes('CZ')) return 2;
  if (codes.length === 1 && codes[0] === 'SK') return 3;
  if (codes.includes('SK')) return 4;
  if (!codes.length) return 5;
  if (codes.includes('EN')) return 6;
  return 7;
}

function subtitleCodesInText(text) {
  const source = stripDiacritics(String(text || '')).toUpperCase();
  const found = [];
  const subtitleWord = '(?:TITULKY|TITULKU|TITULKYMI|TIT|SUBS?|SUBTITLE[S]?)';
  for (const def of LANGUAGE_DEFS) {
    for (const alias of def.aliases) {
      const before = new RegExp(`\\b${alias}\\b[^\\n\\r,;|]{0,12}\\b${subtitleWord}\\b`, 'i');
      const after = new RegExp(`\\b${subtitleWord}\\b[^\\n\\r,;|]{0,12}\\b${alias}\\b`, 'i');
      if (before.test(source) || after.test(source)) {
        found.push(def.code);
        break;
      }
    }
  }
  return dedupe(found);
}

function streamLanguages(text) {
  const subtitles = subtitleCodesInText(text);
  const releaseLanguages = releaseLanguageCodesInText(text);
  const all = releaseLanguages.length ? releaseLanguages : languageCodesInText(text);
  const audio = all.filter(code => !subtitles.includes(code));
  return { audio, subtitles };
}

function formatLanguages(codes) {
  if (!codes.length) return '🌐 ?';
  return codes.map(code => {
    const def = languageDefForAlias(code);
    return `${def ? def.flag : '🌐'} ${code}`;
  }).join(' • ');
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

function proxyHints(referer) {
  return {
    notWebReady: true,
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
  const languages = streamLanguages(`${pageTitle || ''} ${label || ''}`);
  return {
    name: `${provider} • ${quality}`,
    title: `🎧 ${formatLanguages(languages.audio)}\n💬 ${languages.subtitles.length ? formatLanguages(languages.subtitles) : 'Bez titulků'}\n🎬 ${quality}`,
    url,
    behaviorHints: proxyHints(referer)
  };
}

function canonicalDirectIdentity(stream) {
  const raw = String(stream && stream.url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const path = decodeURIComponent(parsed.pathname || '');
    const skt = path.match(/\/h264\/(\d+)_((?:2160|1440|1080|720|480|360|240)p)\.mp4$/i);
    if (skt) return `sktvideo:${skt[1]}:${skt[2].toLowerCase()}`;
    return `url:${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${parsed.pathname}${parsed.search}`;
  } catch (_) {
    return `url:${raw}`;
  }
}

function dedupeStreams(streams) {
  const seen = new Set();
  return (streams || []).filter(stream => {
    if (!stream || !stream.url) return false;
    const identity = canonicalDirectIdentity(stream);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function mediaUrlsFromHtml($, html, pageUrl) {
  const out = [];
  const add = (raw, label = '') => {
    const url = absoluteUrl(raw, pageUrl);
    if (url && isPlayableMediaUrl(url)) out.push({ url, label });
  };

  $('video source[src], video[src], source[src], #player a[href], [data-file], [data-video]').each((_, el) => {
    add(
      $(el).attr('src') || $(el).attr('href') || $(el).attr('data-file') || $(el).attr('data-video'),
      $(el).attr('label') || $(el).attr('res') || $(el).attr('data-res') || $(el).attr('title') || ''
    );
  });

  const unescaped = cleanUrlText(html);
  const matches = unescaped.match(/https?:\/\/[^\s"'<>]+?\.(?:mp4|m3u8|webm|m4v|mov|ts)(?:\?[^\s"'<>]*)?/gi) || [];
  for (const raw of matches) add(raw);

  const seen = new Set();
  return out.filter(item => !seen.has(item.url) && seen.add(item.url));
}

function urlsFromHtml($, html, pageUrl) {
  const urls = [];
  const add = raw => {
    const url = absoluteUrl(raw, pageUrl);
    if (url && isHttpUrl(url)) urls.push(url);
  };

  $('a[href], iframe[src], frame[src], source[src], video[src], [data-src], [data-url], [data-file], [data-video], [onclick]').each((_, el) => {
    for (const attr of ['href', 'src', 'data-src', 'data-url', 'data-file', 'data-video']) add($(el).attr(attr));
    const onclick = cleanUrlText($(el).attr('onclick') || '');
    for (const match of onclick.match(/https?:\/\/[^\s"'<>\])}]+/gi) || []) add(match);
  });

  const raw = cleanUrlText(html);
  for (const match of raw.match(/https?:\/\/[^\s"'<>\])}]+/gi) || []) add(match);
  return dedupe(urls);
}

function nearbyTitleForOnlineEmbed($, el) {
  const container = $(el).closest('[itemscope]');
  let cursor = container.length ? container.prev() : $(el).prev();
  for (let i = 0; cursor.length && i < 12; i += 1, cursor = cursor.prev()) {
    const text = String(cursor.text() || '').replace(/\s+/g, ' ').trim();
    if (text && !/^ONLINE$/i.test(text)) return text;
  }
  return '';
}

function detailAudioCodes($) {
  const text = stripDiacritics(String($('body').text() || '')).replace(/\s+/g, ' ').toUpperCase();
  const match = text.match(/\bJAZYK\s*:\s*([A-Z]{2,3}(?:\s*[,\/]\s*[A-Z]{2,3}){0,6})/i);
  if (!match) return [];
  const out = [];
  for (const token of String(match[1] || '').split(/[,\/]+/)) {
    const def = languageDefForAlias(token.trim());
    if (def) out.push(def.code);
  }
  return dedupe(out);
}

function onlineEmbedEntriesFromDetail($, pageUrl, releaseTitle) {
  const entries = [];
  const seen = new Set();
  $('iframe[src], frame[src]').each((_, el) => {
    const url = absoluteUrl($(el).attr('src'), pageUrl);
    if (!url || !isSktOnlineUrl(url) || !/\/embed\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    entries.push({ url, title: nearbyTitleForOnlineEmbed($, el) });
  });

  const pageCodes = detailAudioCodes($);
  if (pageCodes.length && pageCodes.length === entries.length) {
    entries.forEach((entry, index) => {
      const codes = releaseLanguageCodesInText(entry.title);
      if (codes.length !== 1) entry.title = `(${pageCodes[index]})`;
    });
  } else {
    const explicitCodes = dedupe(entries.flatMap(entry => releaseLanguageCodesInText(entry.title)));
    const releaseCodes = releaseLanguageCodesInText(releaseTitle);
    const remainingCodes = releaseCodes.filter(code => !explicitCodes.includes(code));
    if (remainingCodes.length === 1) {
      for (const entry of entries) {
        if (!releaseLanguageCodesInText(entry.title).length) {
          entry.title = `${entry.title || releaseTitle} (${remainingCodes[0]})`;
        }
      }
    }
  }

  return entries.sort((a, b) => candidateLanguagePriority(a.title) - candidateLanguagePriority(b.title));
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ''; }
}

function isSledujToUrl(url) {
  const host = hostOf(url);
  return host === 'sledujteto.cz' || host.endsWith('.sledujteto.cz');
}

function isSktOnlineUrl(url) {
  const host = hostOf(url);
  return host === 'online.sktorrent.eu' || /^online\d+\.sktorrent\.eu$/i.test(host);
}

async function searchSktorrentDetails(query, wantedTitles, trustedReference = false) {
  const key = `skt-detail-search:${query.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const response = await sktorrentHttp.get('/torrent/torrents_v2.php', {
      params: { search: query, category: 0, active: 0, order: 'data', by: 'DESC', page: 0 },
      headers: { Referer: `${SKTORRENT_BASE_URL}/torrent/torrents_v2.php` }
    });
    const $ = cheerio.load(response.data);
    const items = [];
    const seen = new Set();

    $('a[href*="details.php"]').each((_, el) => {
      const link = $(el);
      const href = String(link.attr('href') || '');
      const idMatch = href.match(/[?&]id=([a-f0-9]{40})/i);
      if (!idMatch || seen.has(idMatch[1])) return;
      // Use the whole result row when possible: the blue Play Video icon is
      // often a sibling of the details link, not inside the link itself.
      const row = link.closest('tr');
      const card = row.length ? row : link.closest('td, article, div');
      const name = String(link.attr('title') || link.find('img').attr('alt') || link.text() || card.text() || '')
        .replace(/\s+/g, ' ').trim();
      const score = titleMatchScore(name, wantedTitles);
      const category = String(card.find('b').first().text() || '').trim();
      if (!name || candidateHasConflictingYears(name, wantedTitles)) return;
      if (!trustedReference && (!candidateYearMatches(name, wantedTitles) || score < 0.55)) return;
      if (category && !/(film|seri|dokum|tv)/i.test(category)) return;
      const detailsUrl = absoluteUrl(href, SKTORRENT_SEARCH_URL);
      if (!detailsUrl) return;

      // Priority hint only: entries without the icon remain as fallback.
      const rowHtml = String(card.html() || '');
      const hasPlayVideo = /play[\s_-]*video|title\s*=\s*["'][^"']*\bplay\b|alt\s*=\s*["'][^"']*\bplay\b|fa-play(?:-circle)?|glyphicon-play|online\d*\.sktorrent\.eu/i.test(rowHtml);

      seen.add(idMatch[1]);
      items.push({ id: idMatch[1], name, detailsUrl, score, category, hasPlayVideo });
    });

    const result = items
      .sort((a, b) =>
        (Number(b.hasPlayVideo) - Number(a.hasPlayVideo)) ||
        (b.score - a.score) ||
        (candidateLanguagePriority(a.name) - candidateLanguagePriority(b.name))
      )
      .slice(0, 10);
    cache.set(key, result, result.length ? 5 * 60 : 60);
    return result;
  } catch (error) {
    console.warn(`[direct] SKTorrent search "${query}": ${error.message}`);
    return [];
  }
}

async function streamsForOnlinePage(pageUrl, referer, sourceTitle = '') {
  const key = `linked-online:${pageUrl}:${normalize(sourceTitle)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  if (resolverHttp && isSktOnlineUrl(pageUrl)) {
    try {
      const payload = await resolverPost('/v1/resolve', {
        url: pageUrl,
        referer: referer || `${SKTORRENT_BASE_URL}/`
      });
      const pageTitle = sourceTitle || String(payload.title || '').trim() || 'SKTOnline';
      const sources = Array.isArray(payload.sources) ? payload.sources : [];
      const result = dedupeStreams(sources.map(item => makeStream(
        'SKTOnline',
        pageTitle,
        String(item && item.url || ''),
        String(item && item.label || ''),
        pageUrl
      ))).slice(0, 8);
      cache.set(key, result, result.length ? 10 * 60 : 60);
      return result;
    } catch (error) {
      console.warn(`[resolver] page ${pageUrl}: ${error.message}`);
    }
  }

  try {
    const response = await onlineHttp.get(pageUrl, { headers: { Referer: referer || `${SKTORRENT_BASE_URL}/` } });
    const finalUrl = absoluteUrl(response.request?.res?.responseUrl || pageUrl, ONLINE_BASE_URL) || pageUrl;
    const $ = cheerio.load(response.data);
    const title = sourceTitle || $('title').text().replace(/\s+/g, ' ').trim() || 'SKTOnline';
    const streams = mediaUrlsFromHtml($, response.data, finalUrl)
      .map(item => makeStream('SKTOnline', title, item.url, item.label, referer || finalUrl));
    const result = dedupeStreams(streams);
    cache.set(key, result, result.length ? 120 : 60);
    return result;
  } catch (error) {
    console.warn(`[direct] linked SKTOnline ${pageUrl}: ${error.message}`);
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

async function streamsForSledujteto(pageUrl, referer = `${SLEDUJTETO_BASE_URL}/`) {
  const pageKey = `sledujteto-page:${pageUrl}`;
  const cached = cache.get(pageKey);
  if (cached !== undefined) return cached;
  try {
    const response = await sledujtetoHttp.get(pageUrl, { headers: { Referer: referer } });
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
    cache.set(pageKey, result, 60);
    return result;
  } catch (error) {
    console.warn(`[sledujteto] page ${pageUrl}: ${error.message}`);
    return [];
  }
}

function sledujtetoPageUrlFromItem(item) {
  if (!item || typeof item !== 'object') return null;
  const raw = item.url || item.link || item.href || item.web_url || item.webUrl || item.page_url || item.pageUrl;
  const url = absoluteUrl(raw, SLEDUJTETO_BASE_URL);
  if (!url || !isSledujToUrl(url)) return null;
  try { return /\/file\/\d+/i.test(new URL(url).pathname) ? url : null; } catch (_) { return null; }
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
      params: { query, page: 1, limit: 30, collection: 'suggestions', sort: 'relevance', me: 0, excluded_ids: '' },
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
    cache.set(key, result, result.length ? 300 : 60);
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
    cache.set(key, result, result.length ? 300 : 60);
    return result;
  } catch (error) {
    console.warn(`[sledujteto] slug search "${query}": ${error.message}`);
    return [];
  }
}

async function findSledujtetoByTitle(queries, titles) {
  for (const query of queries.slice(0, 6)) {
    let pages = await searchSledujtetoApi(query, titles);
    if (!pages.length) pages = await searchSledujtetoSlug(query, titles);
    if (!pages.length) continue;
    const batches = await Promise.all(pages.slice(0, 6).map(page => streamsForSledujteto(page)));
    const all = dedupeStreams(batches.flat());
    if (all.length) return all.slice(0, 8);
  }
  return [];
}




async function searchDirectOnlineVideos(query, wantedTitles) {
  const key = `online-title-search-v2:${normalize(query)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  if (resolverHttp) {
    try {
      const payload = await resolverPost('/v1/search', { query });
      const items = (Array.isArray(payload.items) ? payload.items : [])
        .filter(item => item && /^\d+$/.test(String(item.id || '')))
        .filter(item => {
          const context = String(item.title || '').replace(/\s+/g, ' ').trim();
          return !context || !candidateHasConflictingYears(context, wantedTitles);
        })
        .map(item => ({
          id: String(item.id),
          title: String(item.title || '').replace(/\s+/g, ' ').trim()
        }));
      cache.set(key, items, items.length ? 5 * 60 : 60);
      return items;
    } catch (error) {
      console.warn(`[resolver] search "${query}": ${error.message}`);
    }
  }

  try {
    const response = await onlineHttp.get('/search/videos', {
      params: { search_query: query },
      headers: { Referer: `${ONLINE_BASE_URL}/` }
    });
    const $ = cheerio.load(response.data);
    const items = [];
    const seen = new Set();

    $("a[href^='/video/'], a[href*='online.sktorrent.eu/video/']").each((_, el) => {
      const link = $(el);
      const href = String(link.attr('href') || '');
      const match = href.match(/\/video\/(\d+)/i);
      if (!match || seen.has(match[1])) return;

      const context = String(
        link.attr('title') ||
        link.find('img').attr('alt') ||
        link.text() ||
        link.closest('article,li,div,tr,td').text() || ''
      ).replace(/\s+/g, ' ').trim();

      if (context && candidateHasConflictingYears(context, wantedTitles)) return;
      seen.add(match[1]);
      items.push({ id: match[1], title: context });
    });

    cache.set(key, items, items.length ? 5 * 60 : 60);
    return items;
  } catch (error) {
    console.warn(`[direct-online] search "${query}": ${error.message}`);
    return [];
  }
}

async function streamsForDirectOnlineVideo(item) {
  const pageUrl = `${ONLINE_BASE_URL}/video/${encodeURIComponent(item.id)}`;
  return streamsForOnlinePage(pageUrl, `${ONLINE_BASE_URL}/`, item.title || '');
}

async function findDirectOnlineByTitle(queries, titles) {
  const seenIds = new Set();
  for (const query of queries.slice(0, 10)) {
    const items = await searchDirectOnlineVideos(query, titles);
    const fresh = items.filter(item => !seenIds.has(item.id)).slice(0, 10);
    fresh.forEach(item => seenIds.add(item.id));
    if (!fresh.length) continue;

    const batches = await Promise.all(fresh.map(streamsForDirectOnlineVideo));
    const streams = dedupeStreams(batches.flat());
    if (streams.length) return streams.slice(0, 12);
  }
  return [];
}

async function streamsFromSktorrentDetail(candidate, client = null) {
  const key = `skt-detail-direct:${client ? client.clientKey : 'anon'}:${candidate.id}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const response = client
      ? await client.authenticatedGet(candidate.detailsUrl, { headers: { Referer: SKTORRENT_SEARCH_URL } })
      : await sktorrentHttp.get(candidate.detailsUrl, { headers: { Referer: SKTORRENT_SEARCH_URL } });
    const finalUrl = absoluteUrl(response.request?.res?.responseUrl || candidate.detailsUrl, SKTORRENT_BASE_URL) || candidate.detailsUrl;
    const $ = cheerio.load(response.data);
    const title = candidate.name || $('title').text().replace(/\s+/g, ' ').trim() || 'SKTOnline';
    const streams = [];

    // On SKTorrent detail pages SKTOnline is embedded directly. Prefer those media
    // sources and use the SKTorrent detail page as Referer instead of searching the
    // separate online.sktorrent.eu website.
    for (const item of mediaUrlsFromHtml($, response.data, finalUrl)) {
      streams.push(makeStream('SKTOnline', title, item.url, item.label, finalUrl));
    }

    const links = urlsFromHtml($, response.data, finalUrl);
    const sledujLinks = links.filter(url => isSledujToUrl(url) && /\/file\/\d+/i.test(url));
    const onlineEntries = onlineEmbedEntriesFromDetail($, finalUrl, title);
  const onlineDirectLinks = links.filter(url => isSktOnlineUrl(url) && isPlayableMediaUrl(url));

    const [sledujBatches, onlineBatches] = await Promise.all([
      Promise.all(sledujLinks.slice(0, 4).map(url => streamsForSledujteto(url, finalUrl))),
      Promise.all([
      ...onlineEntries.slice(0, 6).map(entry => streamsForOnlinePage(entry.url, finalUrl, entry.title || title)),
      ...onlineDirectLinks.slice(0, 4).map(url => Promise.resolve([makeStream('SKTOnline', title, url, '', finalUrl)]))
    ])
    ]);

    streams.push(...sledujBatches.flat(), ...onlineBatches.flat());
    const result = dedupeStreams(streams).slice(0, 12);
    cache.set(key, result, result.length ? 120 : 60);
    return result;
  } catch (error) {
    console.warn(`[direct] SKTorrent detail ${candidate.id}: ${error.message}`);
    return [];
  }
}

async function findFromSktorrentDetails(queries, titles, imdbId, client = null) {
  const candidates = new Map();
  const csfdUrl = await getCsfdUrl(imdbId);
  if (csfdUrl) {
    const exact = await searchSktorrentDetails(csfdUrl, titles, true);
    for (const item of exact) if (!candidates.has(item.id)) candidates.set(item.id, item);
  }

  const fallbacks = queries.slice(0, 6);
  for (let offset = 0; offset < fallbacks.length && candidates.size < 10; offset += 3) {
    const batch = fallbacks.slice(offset, offset + 3);
    const groups = await Promise.all(batch.map(query => searchSktorrentDetails(query, titles)));
    for (const found of groups) {
      for (const item of found) if (!candidates.has(item.id)) candidates.set(item.id, item);
    }
  }
  if (!candidates.size) return [];
  const rankedCandidates = [...candidates.values()].sort((a, b) => {
    const playVideoDiff = Number(b.hasPlayVideo) - Number(a.hasPlayVideo);
    if (playVideoDiff) return playVideoDiff;
    const scoreDiff = (b.score || titleMatchScore(b.name, titles)) - (a.score || titleMatchScore(a.name, titles));
    if (scoreDiff) return scoreDiff;
    return candidateLanguagePriority(a.name) - candidateLanguagePriority(b.name);
  });
  const batches = await Promise.all(rankedCandidates.slice(0, 10).map(candidate => streamsFromSktorrentDetail(candidate, client)));
  return dedupeStreams(batches.flat()).slice(0, 12);
}

function directProviderWithin(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      console.warn(`[direct] ${label} timed out after ${timeoutMs}ms`);
      resolve([]);
    }, timeoutMs);
  });
  return Promise.race([
    Promise.resolve(promise).catch(error => {
      console.warn(`[direct] ${label} failed: ${error.message}`);
      return [];
    }),
    timeout
  ]).finally(() => clearTimeout(timer));
}

async function findOnlineStreams({ imdbId, titles, type, season, episode, sktUsername = '', sktPassword = '' }) {
  const queries = buildQueries(titles, type, season, episode);
  let sktClient = null;
  if (sktUsername && sktPassword) {
    try { sktClient = getClient(sktUsername, sktPassword); } catch (_) {}
  }

  const [fromDirectOnline, fromTorrentDetails, sledujToByTitle] = await Promise.all([
    directProviderWithin(findDirectOnlineByTitle(queries, titles), 13000, 'SKTOnline title search'),
    directProviderWithin(findFromSktorrentDetails(queries, titles, imdbId, sktClient), 20000, 'SKTorrent detail players'),
    directProviderWithin(findSledujtetoByTitle(queries, titles), 12000, 'SledujTo title search')
  ]);

  return dedupeStreams([
    ...fromDirectOnline,
    ...fromTorrentDetails,
    ...sledujToByTitle
  ]).slice(0, 24);
}

module.exports = {
  findOnlineStreams,
  findDirectOnlineByTitle,
  findFromSktorrentDetails
};
