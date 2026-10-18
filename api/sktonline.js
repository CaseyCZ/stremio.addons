const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { getClient } = require('./sktorrent');

const SKTORRENT_BASE_URL = 'https://sktorrent.eu';
const SKTORRENT_SEARCH_URL = `${SKTORRENT_BASE_URL}/torrent/torrents_v2.php`;
const ONLINE_BASE_URL = 'https://online.sktorrent.eu';
const RESOLVER_BASE_URL = String(process.env.SKTONLINE_RESOLVER_URL || '').replace(/\/+$/, '');
const RESOLVER_TOKEN = String(process.env.SKTONLINE_RESOLVER_TOKEN || '').trim();
const SKTONLINE_PROXY_URL = String(process.env.SKTONLINE_PROXY_URL || '').trim();
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
const cache = new NodeCache({ stdTTL: 5 * 60, checkperiod: 60, maxKeys: 1800 });

const LANGUAGE_DEFS = [
  { code: 'CZ', flag: '🇨🇿', aliases: ['CZ', 'CS', 'CZE', 'CES'] },
  { code: 'SK', flag: '🇸🇰', aliases: ['SK', 'SLK', 'SLO'] },
  { code: 'EN', flag: '🇬🇧', aliases: ['EN', 'ENG'] },
  { code: 'PL', flag: '🇵🇱', aliases: ['PL', 'POL'] },
  { code: 'DE', flag: '🇩🇪', aliases: ['DE', 'GER', 'DEU'] },
  { code: 'HU', flag: '🇭🇺', aliases: ['HU', 'HUN'] }
];

function proxyConfig(agent) {
  return agent ? { httpAgent: agent, httpsAgent: agent, proxy: false } : {};
}

const sktOnlineProxyAgent = SKTONLINE_PROXY_URL ? new SocksProxyAgent(SKTONLINE_PROXY_URL) : null;

function makeHttp(baseURL, timeout = 9000, agent = null) {
  return axios.create({
    baseURL,
    timeout,
    maxContentLength: 8 * 1024 * 1024,
    ...proxyConfig(agent),
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Encoding': 'identity',
      Accept: 'text/html,application/xhtml+xml,application/json,*/*'
    }
  });
}

const sktorrentHttp = makeHttp(SKTORRENT_BASE_URL, 9000);
const onlineHttp = makeHttp(ONLINE_BASE_URL, 9000, sktOnlineProxyAgent);
const resolverHttp = RESOLVER_BASE_URL ? makeHttp(RESOLVER_BASE_URL, 12000) : null;

let onlineCookieHeader = '';
let onlinePrimePromise = null;

function normalizeOnlineSetCookies(values) {
  return (Array.isArray(values) ? values : values ? [values] : [])
    .map(value => String(value || '').split(';', 1)[0].trim())
    .filter(Boolean)
    .join('; ');
}

function captureOnlineCookies(response) {
  const value = normalizeOnlineSetCookies(response && response.headers && response.headers['set-cookie']);
  if (value) onlineCookieHeader = value;
}

async function primeOnlineSession(force = false) {
  if (onlineCookieHeader && !force) return;
  if (onlinePrimePromise) return onlinePrimePromise;
  onlinePrimePromise = (async () => {
    try {
      const response = await onlineHttp.get('/', {
        headers: { Referer: ONLINE_BASE_URL },
        validateStatus: status => status >= 200 && status < 400
      });
      captureOnlineCookies(response);
    } finally {
      onlinePrimePromise = null;
    }
  })();
  return onlinePrimePromise;
}

async function onlineGet(url, options = {}) {
  if (!onlineCookieHeader) {
    try { await primeOnlineSession(false); } catch (_) {}
  }

  const request = () => onlineHttp.get(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Referer: (options.headers && options.headers.Referer) || ONLINE_BASE_URL,
      ...(onlineCookieHeader ? { Cookie: onlineCookieHeader } : {})
    }
  });

  try {
    const response = await request();
    captureOnlineCookies(response);
    return response;
  } catch (error) {
    const status = Number(error && error.response && error.response.status || 0);
    if (status !== 401 && status !== 403) throw error;
    onlineCookieHeader = '';
    await primeOnlineSession(true);
    const response = await request();
    captureOnlineCookies(response);
    return response;
  }
}

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

// A search query is NOT proof that the returned video belongs to a show.
// In particular, "Ted" is a different show from "Ted Lasso". Require an
// actual full show title AND an explicit, matching episode in the release
// name before resolving its SKTOnline player. Reject ambiguous season packs.
function episodeIdentityMatches(candidate, wantedTitles, season, episode) {
  if (!Number.isInteger(season) || season < 1 ||
      !Number.isInteger(episode) || episode < 1) return false;
  const name = normalize(candidate);
  const raw = stripDiacritics(candidate).toLowerCase();
  if (!name || /\b(?:parody|parodie|spoof|trailer|teaser|review|reaction|recap)\b/.test(raw)) return false;
  const wanted = dedupe((wantedTitles || []).map(normalize)).filter(Boolean);
  const unambiguous = wanted.filter(title => !wanted.some(other =>
    other !== title && (' ' + other + ' ').includes(' ' + title + ' ')));
  if (!unambiguous.some(title => (' ' + name + ' ').includes(' ' + title + ' '))) return false;

  const episodePatterns = [
    /(?:^|[^a-z0-9])s(?:eason)?[\s._-]*0*(\d+)[\s._-]*e(?:p(?:isode|izoda)?)?[\s._-]*0*(\d+)(?=$|[^a-z0-9])/gi,
    /(?:^|[^a-z0-9])0*(\d+)\s*[x×]\s*0*(\d+)(?=$|[^a-z0-9])/gi,
    /\bseason[\s._-]*0*(\d+)[\s._-]*episode[\s._-]*0*(\d+)\b/gi,
    /(?:^|[^0-9])0*(\d+)\.\s*(?:seria|serie|rada)\s+0*(\d+)\.\s*(?:epizoda|epizody|dil)(?=$|[^a-z])/gi
  ];
  const episodes = [];
  for (const pattern of episodePatterns) {
    for (const match of raw.matchAll(pattern)) {
      episodes.push([Number(match[1]), Number(match[2])]);
    }
  }
  return episodes.length > 0 && episodes.every(([s, e]) =>
    s === season && e === episode);
}

function buildQueries(titles, type, season, episode) {
  const queries = [];
  for (const raw of titles) {
    const base = String(raw || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (!base) continue;
    const plain = stripDiacritics(base);
  const variants = type === 'movie'
    ? dedupe([stripYearTokens(base), stripYearTokens(plain), base, plain, shortTitle(stripYearTokens(plain), 3), shortTitle(stripYearTokens(plain), 2)])
    : dedupe([base, plain, shortTitle(plain, 3)]);
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
  const match = text.match(/\b(2160|1440|1080|720|480|360|240)p?\b/i);
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


function onlineVideoIdFromItem(item) {
  const explicit = String(item && item.id || '').trim();
  if (/^\d+$/.test(explicit)) return explicit;
  const href = String(item && item.href || '').trim();
  const match = href.match(/\/video\/(\d+)(?:\/|$)/i);
  return match ? match[1] : null;
}

async function probeSktCdnHead(url) {
  try {
    const response = await axios.head(url, {
      timeout: 2200,
      ...proxyConfig(sktOnlineProxyAgent),
      maxRedirects: 2,
      validateStatus: () => true,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Encoding': 'identity',
        Referer: `${SKTORRENT_BASE_URL}/`
      }
    });
    const status = Number(response.status || 0);
    const length = Number(response.headers && response.headers['content-length'] || 0);
    const contentType = String(response.headers && response.headers['content-type'] || '').toLowerCase();
    return (status === 200 || status === 206) && (length > 1000000 || contentType.startsWith('video/'));
  } catch (_) {
    return false;
  }
}

async function findSktCdnEdge(videoId) {
  const id = String(videoId || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const key = `skt-cdn-edge-v1:${id}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached || null;

  const edges = Array.from({ length: 30 }, (_, index) => index + 1);
  for (let offset = 0; offset < edges.length; offset += 10) {
    const group = edges.slice(offset, offset + 10);
    const checks = await Promise.all(group.map(async edge => {
      const base = `https://online${edge}.sktorrent.eu/media/videos//h264/${id}`;
      const [p480, p720] = await Promise.all([
        probeSktCdnHead(`${base}_480p.mp4`),
        probeSktCdnHead(`${base}_720p.mp4`)
      ]);
      return p480 || p720 ? edge : null;
    }));
    const found = checks.find(Boolean);
    if (found) {
      cache.set(key, found, 6 * 60 * 60);
      return found;
    }
  }

  cache.set(key, '', 90);
  return null;
}

async function streamsForKnownOnlineVideoId(videoId, pageTitle = 'SKTOnline') {
  const id = String(videoId || '').trim();
  if (!/^\d+$/.test(id)) return [];
  const key = `skt-cdn-streams-v1:${id}:${normalize(pageTitle)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const edge = await findSktCdnEdge(id);
  if (!edge) {
    cache.set(key, [], 90);
    return [];
  }

  const qualities = ['1080p', '720p', '480p', '360p', '240p'];
  const checks = await Promise.all(qualities.map(async quality => {
    const url = `https://online${edge}.sktorrent.eu/media/videos//h264/${id}_${quality}.mp4`;
    return await probeSktCdnHead(url) ? { url, quality } : null;
  }));

  const streams = checks.filter(Boolean).map(item => {
    const stream = makeStream('SKTOnline', pageTitle || 'SKTOnline', item.url, item.quality, `${ONLINE_BASE_URL}/`);
    stream.behaviorHints = { notWebReady: false };
    // Internal identity only. findOnlineSourceBundle strips this before the
    // stream is returned to Stremio, while keeping videoId for subtitles.
    stream._sktVideoId = id;
    return stream;
  });
  const result = dedupeStreams(streams);
  cache.set(key, result, result.length ? 60 * 60 : 90);
  return result;
}

function onlineVideoIdFromHtml($, html = '') {
  const values = [String(html || '')];
  if ($) {
    $('video[poster], [style*="media/videos/tmb"], img[src*="media/videos/tmb"], script').each((_, el) => {
      const node = $(el);
      values.push(
        String(node.attr('poster') || ''),
        String(node.attr('style') || ''),
        String(node.attr('src') || ''),
        String(node.html() || '')
      );
    });
  }

  for (const raw of values) {
    const source = cleanUrlText(raw);
    if (!source) continue;
    for (const pattern of [
      /\bvideo_id\s*=\s*["']?(\d{1,10})/i,
      /\/media\/videos\/(?:tmb1?|h264)\/+([0-9]{1,10})(?:\/|_)/i,
      /\/video\/([0-9]{1,10})(?:\/|$)/i
    ]) {
      const match = source.match(pattern);
      if (match) return match[1];
    }
  }
  return null;
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

function onlineEmbedEntriesFromDetail($, pageUrl, releaseTitle, html = '') {
  const entries = [];
  const byUrl = new Map();

  const add = (raw, title = '') => {
    const source = cleanUrlText(raw);
    if (!source) return;

    const candidates = [];
    for (const match of source.match(/(?:https?:)?\/\/online(?:\d+)?\.sktorrent\.eu\/embed\/[a-z0-9_-]+(?:&\d+)?(?:[?#][^\s\"'<>]*)?/gi) || []) {
      candidates.push(match);
    }
    for (const match of source.match(/(?:^|[\s"'=(])\/embed\/[a-z0-9_-]+/gi) || []) {
      candidates.push(match.replace(/^[\s"'=(]+/, ''));
    }
    if (!candidates.length && /^\/embed\/[a-z0-9_-]+(?:&\d+)?(?:[?#].*)?$/i.test(source)) candidates.push(source);

    for (const candidate of candidates) {
      let url = null;
      if (/^\/embed\//i.test(candidate)) url = absoluteUrl(candidate, ONLINE_BASE_URL);
      else if (/^\/\//.test(candidate)) url = `https:${candidate}`;
      else url = absoluteUrl(candidate, pageUrl);
      if (!url || !isSktOnlineUrl(url) || !/\/embed\/[a-z0-9_-]+(?:&\d+)?/i.test(url)) continue;

      const existing = byUrl.get(url);
      const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim();
      if (existing) {
        if (!existing.title && cleanTitle) existing.title = cleanTitle;
        continue;
      }
      const entry = { url, title: cleanTitle };
      byUrl.set(url, entry);
      entries.push(entry);
    }
  };

  // The original site usually embeds the player in an iframe. Some current
  // SKTorrent detail pages expose the same link as an anchor, data attribute
  // or JavaScript handler instead, so inspect all of those forms as well.
  $('iframe[src], frame[src]').each((_, el) => {
    add($(el).attr('src'), nearbyTitleForOnlineEmbed($, el));
  });

  $('meta[itemprop="embedURL"][content], meta[property="og:url"][content], meta[property="og:video"][content]').each((_, el) => {
    add($(el).attr('content'), releaseTitle);
  });

  $('a[href], [data-src], [data-url], [data-file], [data-video], [onclick]').each((_, el) => {
    const node = $(el);
    const title = String(
      node.attr('title') ||
      node.attr('aria-label') ||
      node.text() ||
      releaseTitle || ''
    ).replace(/\s+/g, ' ').trim();
    for (const attr of ['href', 'src', 'data-src', 'data-url', 'data-file', 'data-video', 'onclick']) {
      add(node.attr(attr), title);
    }
  });

  // Also scan raw HTML. This catches escaped URLs inside inline scripts such as
  // https:\/\/online.sktorrent.eu\/embed\/<token> that Cheerio does not expose
  // as a normal attribute.
  add(cleanUrlText(html), releaseTitle);

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

function isSktOnlineUrl(url) {
  const host = hostOf(url);
  return host === 'online.sktorrent.eu' || /^online\d+\.sktorrent\.eu$/i.test(host);
}

async function searchSktorrentDetails(query, wantedTitles, trustedReference = false) {
  // Direct must inspect every relevant SKTorrent result, not only the first
  // handful. Walk result pages until pagination ends (with a high safety cap),
  // dedupe by torrent id and keep all title-matching candidates.
  const wantedKey = (wantedTitles || []).map(normalize).sort().join('|');
  const key = `skt-detail-search-all-v1:${normalize(query)}:${trustedReference ? 'trusted' : 'normal'}:${wantedKey}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const items = [];
  const seen = new Set();
  let lastPage = 0;

  try {
    for (let page = 0; page <= lastPage; page += 1) {
      const response = await sktorrentHttp.get('/torrent/torrents_v2.php', {
        params: { search: query, category: 0, active: 0, order: 'data', by: 'DESC', page },
        headers: { Referer: `${SKTORRENT_BASE_URL}/torrent/torrents_v2.php` }
      });
      const $ = cheerio.load(response.data);

      $('a[href*="page="]').each((_, el) => {
        const href = String($(el).attr('href') || '');
        const match = href.match(/[?&]page=(\d+)/i);
        if (match) lastPage = Math.max(lastPage, Number(match[1]));
      });

      let rawCount = 0;
      let newIds = 0;
      $('a[href*="details.php"]').each((_, el) => {
        const link = $(el);
        const href = String(link.attr('href') || '');
        const idMatch = href.match(/[?&]id=([a-f0-9]{40})/i);
        if (!idMatch) return;
        rawCount += 1;
        if (seen.has(idMatch[1])) return;

        const cell = link.closest('td');
        const card = cell.length ? cell : link.closest('tr, article, div');
        const name = String(
          link.attr('title') ||
          link.find('img').attr('alt') ||
          link.text() ||
          card.text() || ''
        ).replace(/\s+/g, ' ').trim();
        if (!name) return;

        const score = titleMatchScore(name, wantedTitles);
        if (!trustedReference && score < 0.45) return;

        const category = String(card.find('b').first().text() || '').trim();
        if (/^x{3}$/i.test(category) || /\bxxx\b/i.test(category)) return;

        const detailsUrl = absoluteUrl(href, SKTORRENT_SEARCH_URL);
        if (!detailsUrl) return;

        const cardHtml = String(card.html() || '');
        const hasPlayVideo = /play[\s_-]*video|title\s*=\s*["'][^"']*\bplay\b|malt\s*=\s*["'][^"']*\bplay\b|fa-play(?:-circle)?|glyphicon-play|online\d*\.sktorrent\.eu/i.test(cardHtml);

        seen.add(idMatch[1]);
        newIds += 1;
        items.push({
          id: idMatch[1],
          name,
          category,
          score,
          detailsUrl,
          hasPlayVideo
        });
      });

      if (!rawCount || (page > 0 && newIds === 0)) break;
    }

    const result = items.sort((a, b) => {
      const scoreDiff = (b.score || 0) - (a.score || 0);
      if (scoreDiff) return scoreDiff;
      const playVideoDiff = Number(b.hasPlayVideo) - Number(a.hasPlayVideo);
      if (playVideoDiff) return playVideoDiff;
      return candidateLanguagePriority(a.name) - candidateLanguagePriority(b.name);
    });

    cache.set(key, result, result.length ? 5 * 60 : 60);
    return result;
  } catch (error) {
    console.warn(`[direct] SKTorrent search "${query}": ${error.message}`);
    return items;
  }
}

async function streamsForOnlinePage(pageUrl, referer, sourceTitle = '') {
  const key = `linked-online-v2:${pageUrl}:${normalize(sourceTitle)}`;
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
    const response = await onlineGet(pageUrl, { headers: { Referer: referer || `${SKTORRENT_BASE_URL}/` } });
    const finalUrl = absoluteUrl(response.request?.res?.responseUrl || pageUrl, ONLINE_BASE_URL) || pageUrl;
    const $ = cheerio.load(response.data);
    const title = sourceTitle || $('title').text().replace(/\s+/g, ' ').trim() || 'SKTOnline';
    let streams = mediaUrlsFromHtml($, response.data, finalUrl)
      .map(item => makeStream('SKTOnline', title, item.url, item.label, referer || finalUrl));

    if (!streams.length) {
      const videoId = onlineVideoIdFromHtml($, response.data);
      if (videoId) streams = await streamsForKnownOnlineVideoId(videoId, title);
    }

    const result = dedupeStreams(streams);
    cache.set(key, result, result.length ? 120 : 60);
    return result;
  } catch (error) {
    console.warn(`[direct] linked SKTOnline ${pageUrl}: ${error.message}`);
    return [];
  }
}

function onlineSearchItemsFromHtml($, wantedTitles) {
  let cards = $('div.well.well-sm').toArray();
  if (!cards.length) cards = $('div.well-sm').toArray();
  if (!cards.length) cards = $('div.well').toArray();
  if (!cards.length) cards = $('article, .post, .item, .card').toArray();

  const items = [];
  const seen = new Set();
  const collect = (link, contextNode) => {
    const href = String(link.attr('href') || '').trim();
    const pageUrl = absoluteUrl(href, ONLINE_BASE_URL);
    if (!pageUrl || seen.has(pageUrl)) return;

    let parsed;
    try { parsed = new URL(pageUrl); } catch (_) { return; }
    if (parsed.hostname.toLowerCase() !== 'online.sktorrent.eu') return;
    const pathname = parsed.pathname || '/';
    if (/^\/(?:search|login|register|users?|categories?)(?:\/|$)/i.test(pathname)) return;
    if (pathname === '/' || pathname === '/videos') return;

    const title = String(
      link.attr('title') ||
      link.find('img').attr('alt') ||
      contextNode.find('span').first().text() ||
      contextNode.find('h1,h2,h3,h4').first().text() ||
      link.text() ||
      contextNode.text() || ''
    ).replace(/\s+/g, ' ').trim();

    // Do not hard-reject cards here: current SKTOnline cards can contain dates,
    // metadata and localized titles. The search itself already narrows results.
    const score = title ? titleMatchScore(title, wantedTitles) : 0;
    seen.add(pageUrl);
    items.push({ href: pageUrl, title, score });
  };

  if (cards.length) {
    for (const card of cards) {
      const node = $(card);
      const link = node.find('a[href]').first();
      if (link.length) collect(link, node);
    }
  } else {
    $('a[href]').each((_, element) => {
      const link = $(element);
      collect(link, link.closest('article,li,div,tr,td'));
    });
  }

  return items
    .sort((a, b) => (b.score - a.score))
    .slice(0, 20);
}

async function searchDirectOnlineVideos(query, wantedTitles) {
  const key = `online-title-search-v4:${normalize(query)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  if (resolverHttp) {
    try {
      const payload = await resolverPost('/v1/search', { query });
      const items = (Array.isArray(payload.items) ? payload.items : [])
        .filter(item => item && /^\d+$/.test(String(item.id || '')))
        .map(item => ({
          id: String(item.id),
          href: `${ONLINE_BASE_URL}/video/${encodeURIComponent(String(item.id))}`,
          title: String(item.title || '').replace(/\s+/g, ' ').trim(),
          score: titleMatchScore(String(item.title || ''), wantedTitles)
        }));
      if (items.length) {
        cache.set(key, items, 5 * 60);
        return items;
      }
    } catch (error) {
      console.warn(`[resolver] search "${query}": ${error.message}`);
    }
  }

  try {
    const response = await onlineGet('/search/videos', {
      params: {
        type: 'public',
        t: 'a',
        o: 'mr',
        search_query: query,
        page: 1
      },
      headers: { Referer: `${ONLINE_BASE_URL}/` }
    });
    const $ = cheerio.load(response.data);
    const items = onlineSearchItemsFromHtml($, wantedTitles);
    cache.set(key, items, items.length ? 5 * 60 : 45);
    return items;
  } catch (error) {
    console.warn(`[direct-online] search "${query}": ${error.message}`);
    return [];
  }
}

async function streamsForDirectOnlineVideo(item) {
  const videoId = onlineVideoIdFromItem(item);
  const sourceTitle = String(item && item.title || '').replace(/\s+/g, ' ').trim() || 'SKTOnline';

  // Current online.sktorrent.eu /video/<id> pages can return an empty body to
  // server-side clients while the actual MP4 remains available on one of the
  // online1..online30 CDN edges. Resolve the edge directly from the video ID.
  if (videoId) {
    const direct = await streamsForKnownOnlineVideoId(videoId, sourceTitle);
    if (direct.length) return direct.slice(0, 8);
  }

  const pageUrl = absoluteUrl(item && (item.href || (item.id ? `/video/${item.id}` : '')), ONLINE_BASE_URL);
  if (!pageUrl) return [];
  const key = `direct-online-video-v5:${pageUrl}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const response = await onlineGet(pageUrl, { headers: { Referer: `${ONLINE_BASE_URL}/` } });
    const finalUrl = absoluteUrl(response.request?.res?.responseUrl || pageUrl, ONLINE_BASE_URL) || pageUrl;
    const $ = cheerio.load(response.data);
    const pageTitle = $('title').text().replace(/\s+/g, ' ').trim() || sourceTitle;
    const streams = [];

    const add = (raw, label = '') => {
      const url = absoluteUrl(raw, finalUrl);
      if (!url || !isPlayableMediaUrl(url)) return;
      const stream = makeStream('SKTOnline', pageTitle, url, label, finalUrl);
      if (/\.mp4(?:$|[?#])/i.test(url)) stream.behaviorHints = { notWebReady: false };
      streams.push(stream);
    };

    $('video#video source[src], video source[src], video[src], source[src]').each((_, el) => {
      add(
        $(el).attr('src'),
        $(el).attr('label') || $(el).attr('res') || $(el).attr('data-res') || ''
      );
    });

    if (!streams.length) {
      for (const media of mediaUrlsFromHtml($, response.data, finalUrl)) add(media.url, media.label);
    }

    const result = dedupeStreams(streams).slice(0, 8);
    cache.set(key, result, result.length ? 10 * 60 : 45);
    return result;
  } catch (error) {
    console.warn(`[direct-online] page ${pageUrl}: ${error.message}`);
    return [];
  }
}

async function findDirectOnlineByTitle(queries, titles, type, season, episode) {
  const seenPages = new Set();
  const searchQueries = dedupe(queries || []).slice(0, 9);

  for (let offset = 0; offset < searchQueries.length; offset += 3) {
    const group = searchQueries.slice(offset, offset + 3);
    const resultGroups = await Promise.all(group.map(query => searchDirectOnlineVideos(query, titles)));
    const fresh = [];
    for (const items of resultGroups) {
      for (const item of items) {
        if (type === 'series' && !episodeIdentityMatches(item.title, titles, season, episode)) continue;
        const key = String(item.href || item.id || '');
        if (!key || seenPages.has(key)) continue;
        seenPages.add(key);
        fresh.push(item);
      }
    }
    if (!fresh.length) continue;

    fresh.sort((a, b) => (Number(b.score || 0) - Number(a.score || 0)));
    const all = [];
    for (const item of fresh.slice(0, 4)) {
      const streams = await streamsForDirectOnlineVideo(item);
      all.push(...streams);
      const unique = dedupeStreams(all);
      if (unique.length >= 4) return unique.slice(0, 12);
    }
    const unique = dedupeStreams(all);
    if (unique.length) return unique.slice(0, 12);
  }
  return [];
}

async function streamsFromSktorrentDetail(candidate, client = null) {
  const key = `skt-detail-direct-v3:${client ? client.clientKey : 'anon'}:${candidate.id}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const fetchDetail = () => client
      ? client.authenticatedGet(candidate.detailsUrl, { headers: { Referer: SKTORRENT_SEARCH_URL } })
      : sktorrentHttp.get(candidate.detailsUrl, { headers: { Referer: SKTORRENT_SEARCH_URL } });
    let response = await fetchDetail();

    // SKTorrent can occasionally answer an authenticated detail request with a
    // successful but empty body when the session has gone stale. Force a fresh
    // login once before giving up so the direct player links are not lost.
    if (client && !String(response.data || '').trim()) {
      await client.login(true);
      response = await fetchDetail();
    }

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
    const onlineEntries = onlineEmbedEntriesFromDetail($, finalUrl, title, response.data);
    const detailVideoId = onlineVideoIdFromHtml($, response.data);
    const onlineDirectLinks = links.filter(url => isSktOnlineUrl(url) && isPlayableMediaUrl(url));

    const onlineBatches = await Promise.all([
      ...(detailVideoId ? [streamsForKnownOnlineVideoId(detailVideoId, title)] : []),
      ...onlineEntries.slice(0, 6).map(entry => streamsForOnlinePage(entry.url, finalUrl, entry.title || title)),
      ...onlineDirectLinks.slice(0, 4).map(url => Promise.resolve([makeStream('SKTOnline', title, url, '', finalUrl)]))
    ]);

    streams.push(...onlineBatches.flat());
    const result = dedupeStreams(streams).slice(0, 12);
    cache.set(key, result, result.length ? 120 : 60);
    return result;
  } catch (error) {
    console.warn(`[direct] SKTorrent detail ${candidate.id}: ${error.message}`);
    return [];
  }
}

async function findFromSktorrentDetails(queries, titles, imdbId, client = null, type = 'movie', season = null, episode = null) {
  // Collect every candidate returned by all useful title variants, then inspect
  // every candidate detail. A later torrent can be the one carrying the
  // SKTOnline iframe, so do not stop after the first Direct hit.
  const candidates = new Map();
  const historyQueries = dedupe((queries || []).filter(Boolean));

  for (let offset = 0; offset < historyQueries.length; offset += 3) {
    const group = historyQueries.slice(offset, offset + 3);
    const groups = await Promise.all(group.map(query => searchSktorrentDetails(query, titles)));
    for (const found of groups) {
      for (const item of found) {
        if (type === 'series' && !episodeIdentityMatches(item.name, titles, season, episode)) continue;
        if (!candidates.has(item.id)) candidates.set(item.id, item);
      }
    }
  }

  if (!candidates.size) return [];

  const rankedCandidates = [...candidates.values()].sort((a, b) => {
    const scoreDiff = (b.score || titleMatchScore(b.name, titles)) - (a.score || titleMatchScore(a.name, titles));
    if (scoreDiff) return scoreDiff;
    const playVideoDiff = Number(b.hasPlayVideo) - Number(a.hasPlayVideo);
    if (playVideoDiff) return playVideoDiff;
    return candidateLanguagePriority(a.name) - candidateLanguagePriority(b.name);
  });

  let result = [];
  const DETAIL_CONCURRENCY = 6;
  for (let offset = 0; offset < rankedCandidates.length; offset += DETAIL_CONCURRENCY) {
    const batch = rankedCandidates.slice(offset, offset + DETAIL_CONCURRENCY);
    const resolved = await Promise.all(
      batch.map(candidate => streamsFromSktorrentDetail(candidate, client))
    );
    result = dedupeStreams([...result, ...resolved.flat()]);
  }

  return result;
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

function videoIdFromResolvedStream(stream) {
  const explicit = String(stream && stream._sktVideoId || '').trim();
  if (/^\d+$/.test(explicit)) return explicit;
  try {
    const parsed = new URL(String(stream && stream.url || ''));
    const match = decodeURIComponent(parsed.pathname || '').match(/\/h264\/(\d+)_((?:2160|1440|1080|720|480|360|240)p)\.mp4$/i);
    return match ? match[1] : null;
  } catch (_) {
    return null;
  }
}

function cleanResolvedStream(stream) {
  if (!stream || typeof stream !== 'object') return stream;
  const { _sktVideoId, ...clean } = stream;
  return clean;
}

function sktDisplayVariantKey(stream) {
  const videoId = videoIdFromResolvedStream(stream);
  if (!videoId || !String(stream && stream.name || '').startsWith('SKTOnline • ')) return null;
  const title = String(stream && stream.title || '');
  const audio = (title.match(/^🎧\s*(.+)$/m) || [])[1] || '?';
  const subtitles = (title.match(/^💬\s*(.+)$/m) || [])[1] || 'Bez titulků';
  return `${normalize(audio)}|${normalize(subtitles)}`;
}

function streamQualityNumber(stream) {
  const text = `${String(stream && stream.name || '')} ${String(stream && stream.url || '')}`;
  const match = text.match(/\b(2160|1440|1080|720|480|360|240)p\b/i);
  return match ? Number(match[1]) : 0;
}

function selectBestSktDisplayStreams(streams) {
  const groups = new Map();
  (streams || []).forEach((stream, index) => {
    const variant = sktDisplayVariantKey(stream);
    const videoId = videoIdFromResolvedStream(stream);
    if (!variant || !videoId) return;
    const key = `${variant}|${videoId}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, variant, videoId, firstIndex: index, count: 0, maxQuality: 0 };
      groups.set(key, group);
    }
    group.count += 1;
    group.maxQuality = Math.max(group.maxQuality, streamQualityNumber(stream));
  });

  const winnerByVariant = new Map();
  for (const group of groups.values()) {
    const current = winnerByVariant.get(group.variant);
    if (!current ||
        group.maxQuality > current.maxQuality ||
        (group.maxQuality === current.maxQuality && group.count > current.count) ||
        (group.maxQuality === current.maxQuality && group.count === current.count && group.firstIndex < current.firstIndex)) {
      winnerByVariant.set(group.variant, group);
    }
  }

  const selected = new Set([...winnerByVariant.values()].map(group => group.key));
  return (streams || []).filter(stream => {
    const variant = sktDisplayVariantKey(stream);
    const videoId = videoIdFromResolvedStream(stream);
    if (!variant || !videoId) return true;
    return selected.has(`${variant}|${videoId}`);
  });
}

async function findOnlineSourceBundle({ imdbId, titles, type, season, episode, sktUsername = '', sktPassword = '' }) {
  const queries = buildQueries(titles, type, season, episode);
  let sktClient = null;
  if (sktUsername && sktPassword) {
    try { sktClient = getClient(sktUsername, sktPassword); } catch (_) {}
  }

  const [fromDirectOnline, fromTorrentDetails] = await Promise.all([
  directProviderWithin(findDirectOnlineByTitle(queries, titles, type, season, episode), 18000, 'SKTOnline title search'),
  directProviderWithin(findFromSktorrentDetails(queries, titles, imdbId, sktClient, type, season, episode), 18000, 'SKTorrent detail players')
]);

const resolvedAll = dedupeStreams([
  ...fromDirectOnline,
  ...fromTorrentDetails
]).slice(0, 48);

  // Keep every healthy SKTOnline videoId internally for subtitles and future
  // rediscovery, but show only the best source for each audio/subtitle variant.
  const videoIds = dedupe(resolvedAll.map(videoIdFromResolvedStream).filter(Boolean));
  const resolved = selectBestSktDisplayStreams(resolvedAll);
  return {
    streams: resolved.map(cleanResolvedStream),
    videoIds
  };
}

async function findOnlineStreams(options) {
  return (await findOnlineSourceBundle(options)).streams;
}

module.exports = {
  findOnlineStreams,
  findOnlineSourceBundle,
  findDirectOnlineByTitle,
  findFromSktorrentDetails,
  episodeIdentityMatches,
  buildQueries
};
