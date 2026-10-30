'use strict';

// Experimental, account-scoped Sledujteto resolver. Only its JSON API is
// contacted by this server. Media and VTT bytes go from the CDN to Stremio.
const crypto = require('node:crypto');
const { normalizeTitle, titleMatchScore, episodeTokens } = require('./search-matching');

const BASE = 'https://www.sledujteto.com/api';
const USER_AGENT = 'Kodi/plugin.video.sledujteto';
const MAX_STREAMS = 12;
const TOKEN_TTL_MS = 5 * 60 * 1000;
const SEARCH_TTL_MS = 2 * 60 * 1000;
const COOLDOWN_MS = 10 * 60 * 1000;

function accountKey(email, password) {
  return crypto.createHash('sha256').update(JSON.stringify([email, password])).digest('hex');
}

function providerUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const hostname = url.hostname.toLowerCase();
    if (!/(^|\.)sledujteto\.(?:com|cz)$/.test(hostname)) return null;
    return url.toString();
  } catch (_) { return null; }
}

function directVttUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (url.protocol !== 'https:' || url.username || url.password || !/\.vtt$/i.test(url.pathname)) return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ||
        hostname.endsWith('.local')) return null;
    return url.toString();
  } catch (_) { return null; }
}

function subtitleLang(raw) {
  const code = String(raw || '').toLowerCase().split(/[-_]/)[0];
  return ({ cs: 'ces', cze: 'ces', ces: 'ces', sk: 'slk', slo: 'slk', slk: 'slk',
    en: 'eng', eng: 'eng' })[code] || (/^[a-z]{3}$/.test(code) ? code : 'und');
}

function subtitlesFromVideo(video, id) {
  const subtitles = Array.isArray(video && video.subtitles) ? video.subtitles : [];
  return subtitles.map((entry, index) => {
    const url = directVttUrl(entry && (entry.cdnUrl || entry.url));
    if (!url) return null;
    const language = String(entry.language || entry.lang || '').trim();
    const label = String(entry.title || language || `Stopa ${index + 1}`).trim().slice(0, 50);
    return { id: `sledujteto-${id}-${index}`, lang: subtitleLang(language),
      label: `Sledujteto • ${label}`, url };
  }).filter(Boolean);
}

function matchingScore(filename, titles, type, year, season, episode) {
  const name = String(filename || '');
  const episodes = episodeTokens(name);
  if (type === 'movie') {
    if (episodes.length) return 0;
    const embeddedYears = name.match(/\b(?:19|20)\d{2}\b/g) || [];
    if (year && embeddedYears.some(found => found !== String(year))) return 0;
    return titleMatchScore(name, titles);
  }
  if (type !== 'series' || !episodes.length ||
      episodes.some(item => item.season !== season || item.episode !== episode)) return 0;
  // Refuse episode ranges (S01E01-03), even when the first episode matches.
  const tail = name.slice(episodes[0].end);
  if (/^\s*(?:-|to|e|\+)\s*(?:e)?0*\d+\b/i.test(tail)) return 0;
  const prefix = normalizeTitle(name.slice(0, episodes[0].pos));
  return titles.some(title => normalizeTitle(title) === prefix) ? 0.98 :
    titleMatchScore(name, titles);
}

function searchTitles(meta) {
  const seen = new Set();
  return [meta && meta.name, meta && meta.originalName,
    ...(Array.isArray(meta && meta.nameTranslations) ? meta.nameTranslations : [])]
    .map(value => String(value || '').trim())
    .filter(value => {
      const normalized = normalizeTitle(value);
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    }).slice(0, 6);
}

function movieYear(meta) {
  for (const field of [meta && meta.year, meta && meta.releaseInfo, meta && meta.released]) {
    const match = String(field || '').match(/\b(?:19|20)\d{2}\b/);
    if (match) return match[0];
  }
  return '';
}

function createSledujtetoClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function') throw TypeError('fetch required');
  const tokens = new Map();
  const logins = new Map();
  const searches = new Map();
  const pendingSearches = new Map();
  const cooldowns = new Map();

  async function login(email, password, key) {
    const pending = logins.get(key);
    if (pending) return pending;
    const task = (async () => {
      const response = await fetchImpl(`${BASE}/v1/token`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json',
          'User-Agent': USER_AGENT, 'X-Device-ID': USER_AGENT },
        body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(10000)
      });
      if (!response.ok) throw Error(`Sledujteto login HTTP ${response.status}`);
      const data = await response.json();
      const token = data && data.data && data.data.token;
      if (typeof token !== 'string' || !token || token.length > 4096) throw Error('Invalid Sledujteto login response');
      tokens.set(key, { token, until: now() + TOKEN_TTL_MS });
      return token;
    })();
    logins.set(key, task);
    try { return await task; }
    finally { logins.delete(key); }
  }

  async function authorized(email, password, path) {
    const key = accountKey(email, password);
    if (now() < (cooldowns.get(key) || 0)) throw Error('Sledujteto rate limited');
    for (let attempt = 0; attempt < 2; attempt++) {
      const saved = tokens.get(key);
      const token = saved && now() < saved.until ? saved.token : await login(email, password, key);
      const response = await fetchImpl(BASE + path, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`,
          'User-Agent': USER_AGENT, 'X-Device-ID': USER_AGENT },
        signal: AbortSignal.timeout(10000)
      });
      if (response.status === 401 && attempt === 0) {
        tokens.delete(key);
        continue;
      }
      if (response.status === 429) cooldowns.set(key, now() + COOLDOWN_MS);
      if (!response.ok) throw Error(`Sledujteto API HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload || typeof payload !== 'object' || !payload.data) throw Error('Invalid Sledujteto API response');
      return payload.data;
    }
    throw Error('Sledujteto authentication expired');
  }

  async function search({ email, password, query, titles, type, year, season, episode }) {
    if (!email || !password || !['movie', 'series'].includes(type) || !Array.isArray(titles) ||
        !titles.length || !query || query.length > 160) return [];
    const key = JSON.stringify([accountKey(email, password), query, titles, type, year, season, episode]);
    const cached = searches.get(key);
    if (cached && now() < cached.until) return cached.items.map(item => ({ ...item, video: { ...item.video } }));
    if (cached) searches.delete(key);
    const pending = pendingSearches.get(key);
    if (pending) return (await pending).map(item => ({ ...item, video: { ...item.video } }));
    const task = (async () => {
      const seen = new Set();
      const found = [];
      const pageLimit = 32;
      // Streamlet supports offset pagination. Only paginate if there is no
      // matching result and the provider reports additional pages.
      // Never run unbounded scans against a free account.
      for (let page = 0; page < 3; page++) {
        const offset = page * pageLimit;
        const params = new URLSearchParams({
          query, limit: String(pageLimit), offset: String(offset)
        });
        const data = await authorized(email, password, '/v1/videos?' + params);
        const results = data && (data.results || data.items || data.videos);
        if (!Array.isArray(results)) throw Error('Invalid Sledujteto search response');
        for (const file of results) {
          const id = Number(file && file.id);
          const name = String(file && (file.name || file.title) || '');
          const score = matchingScore(name, titles, type, year, season, episode);
          if (!Number.isSafeInteger(id) || id < 1 || !name || score < 0.75 || seen.has(id)) continue;
          seen.add(id);
          found.push({ id, name, score, video: file.video || {} });
        }
        if (found.length || !results.length) break;
        const total = Number(data.total || data.total_count || 0);
        if (!Number.isFinite(total) || offset + results.length >= total) break;
      }
      found.sort((a, b) => b.score - a.score);
      const limited = found.slice(0, MAX_STREAMS);
      if (searches.size >= 100) searches.delete(searches.keys().next().value);
      searches.set(key, { items: limited, until: now() + SEARCH_TTL_MS });
      return limited;
    })();
    pendingSearches.set(key, task);
    try { return (await task).map(item => ({ ...item, video: { ...item.video } })); }
    finally { pendingSearches.delete(key); }
  }

  async function link({ email, password, id }) {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const data = await authorized(email, password, `/v1/video/${id}/link`);
    // Never cache signed media links; fetch a fresh one for each stream request.
    return providerUrl(data.link || data.download_link || data.downloadLink);
  }

  return { search, link };
}

const client = createSledujtetoClient();

async function findSledujtetoStreams({ cfg, meta, type, season, episode }, { api = client } = {}) {
  if (!cfg || !cfg.sledujtetoEmail || !cfg.sledujtetoPassword || !['movie', 'series'].includes(type)) return [];
  if (type === 'series' && (!Number.isInteger(season) || season < 1 ||
      !Number.isInteger(episode) || episode < 1)) return [];
  const titles = searchTitles(meta);
  if (!titles.length) return [];
  const year = type === 'movie' ? movieYear(meta) : '';
  const query = type === 'series'
    ? `${titles[0]} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : titles[0];
  const credentials = { email: cfg.sledujtetoEmail, password: cfg.sledujtetoPassword };
  const matches = await api.search({ ...credentials, query, titles, type, year, season, episode });
  const streams = new Array(matches.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(3, matches.length) }, async () => {
    while (cursor < matches.length) {
      const index = cursor++;
      const item = matches[index];
      try {
        const url = await api.link({ ...credentials, id: item.id });
        if (!url) continue;
        const quality = item.video.is_4k ? '2160p' : item.video.is_hd ? 'HD' :
          (/\b(?:2160p|4k)\b/i.test(item.name) ? '2160p' :
            /\b1080p\b/i.test(item.name) ? '1080p' : 'Direct');
        const subtitles = subtitlesFromVideo(item.video, item.id);
        streams[index] = {
          name: `Sledujteto • ${quality}`,
          title: [`💬 ${subtitles.length ? `${subtitles.length} VTT titulků` : 'Bez ověřených VTT titulků'}`,
            `🎬 ${quality}`, `🎞 ${item.name.slice(0, 180)}`].join('\n'),
          url, subtitles, behaviorHints: {
            notWebReady: false,
            filename: `${item.name.replace(/[\\/\r\n\t]/g, '').slice(0, 160)}.mp4`
          }
        };
      } catch (error) {
        console.warn(`[sledujteto] link ${item.id} unavailable: ${error.message}`);
      }
    }
  }));
  return streams.filter(Boolean);
}

module.exports = { createSledujtetoClient, findSledujtetoStreams, matchingScore,
  providerUrl, directVttUrl, subtitlesFromVideo };
