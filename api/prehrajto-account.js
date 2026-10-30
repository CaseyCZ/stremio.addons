'use strict';

// Optional registered (including free) Přehraj.to account path, modelled on the
// Streamlet search -> link workflow. The legacy guest resolver stays separate.
// This service handles metadata and signed URL creation only, never media bytes.
const crypto = require('node:crypto');
const { acceptsCandidate, titlesFromMeta, makeQueries } = require('./prehrajto');

const BASE = 'https://prehrajto.cz';
const TOKEN_TTL_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 10 * 60 * 1000;
const MAX_STREAMS = 8;
const MAX_CANDIDATES = 12;
const MAX_SEARCH_QUERIES = 2;
const MAX_LINK_WORKERS = 3;

function accountKey(email, password) {
  return crypto.createHash('sha256').update(JSON.stringify([email, password])).digest('hex');
}

function payload(data) {
  if (!data || typeof data !== 'object') return {};
  return data.payload && data.payload.data || data.data || data.payload || data;
}

function accountToken(data) {
  for (const source of [payload(data), data && data.payload, data]) {
    if (!source || typeof source !== 'object') continue;
    const token = source.access_token || source.accessToken || source.token || source.authToken;
    if (typeof token === 'string' && token.length >= 4 && token.length <= 4096) return token;
  }
  return null;
}

function searchItems(data) {
  const source = payload(data);
  if (Array.isArray(source)) return source;
  for (const list of [source.videos, source.results, source.items, source.files, source.data]) {
    if (Array.isArray(list)) return list;
  }
  return [];
}

function safeVideoId(raw) {
  const value = String(raw == null ? '' : raw).trim();
  return /^[a-z0-9_-]{1,80}$/i.test(value) ? value : null;
}

function publicHttpsUrl(raw, extension = '') {
  try {
    const url = new URL(String(raw || ''));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
        host === '0.0.0.0' || host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
    if (!['prehraj.to', 'prehrajto.cz', 'premiumcdn.net'].some(root =>
      host === root || host.endsWith('.' + root))) return null;
    if (extension && !url.pathname.toLowerCase().endsWith('.' + extension)) return null;
    return url.toString();
  } catch (_) { return null; }
}

function yearFromMeta(meta) {
  for (const value of [meta && meta.year, meta && meta.releaseInfo, meta && meta.released]) {
    const match = String(value || '').match(/\b(?:19|20)\d{2}\b/);
    if (match) return match[0];
  }
  return '';
}

function subtitleLanguage(raw) {
  const value = String(raw || '').toLowerCase().replace(/[0-9]+$/, '').split(/[-_]/)[0];
  const aliases = { cs: 'ces', cze: 'ces', ces: 'ces', sk: 'slk', slo: 'slk', slk: 'slk',
    en: 'eng', eng: 'eng' };
  return aliases[value] || (/^[a-z]{3}$/.test(value) ? value : 'und');
}

function mappedSubtitles(raw, id) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.map((entry, index) => {
    const url = publicHttpsUrl(entry && (entry.cdnUrl || entry.url), 'vtt');
    if (!url || seen.has(url)) return null;
    seen.add(url);
    const label = String(entry.title || entry.label || entry.language || 'Titulky')
      .trim().slice(0, 50);
    return { id: 'prehrajto-account-' + id + '-' + index,
      lang: subtitleLanguage(entry.language || entry.lang),
      label: 'Přehraj.to • ' + label, url };
  }).filter(Boolean).slice(0, 32);
}

function createPrehrajtoAccountClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function') throw TypeError('fetch required');
  const tokens = new Map();
  const logins = new Map();
  const cooldowns = new Map();

  async function login(email, password, key) {
    if (logins.has(key)) return logins.get(key);
    const pending = (async () => {
      const response = await fetchImpl(BASE + '/api/v2/users/login', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
        signal: AbortSignal.timeout(10000)
      });
      if (response.status === 429) cooldowns.set(key, now() + COOLDOWN_MS);
      if (!response.ok) throw Error('Přehraj.to login HTTP ' + response.status);
      const token = accountToken(await response.json());
      if (!token) throw Error('Přehraj.to login: missing token');
      tokens.set(key, { token, until: now() + TOKEN_TTL_MS });
      return token;
    })();
    logins.set(key, pending);
    try { return await pending; }
    finally { logins.delete(key); }
  }

  async function authorized(email, password, path) {
    const key = accountKey(email, password);
    if ((cooldowns.get(key) || 0) > now()) throw Error('Přehraj.to temporarily rate limited');
    for (let attempt = 0; attempt < 2; attempt++) {
      const saved = tokens.get(key);
      const token = saved && saved.until > now() ? saved.token : await login(email, password, key);
      const response = await fetchImpl(BASE + path, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + token },
        signal: AbortSignal.timeout(10000)
      });
      if (response.status === 401 && attempt === 0) {
        tokens.delete(key);
        continue;
      }
      if (response.status === 429) cooldowns.set(key, now() + COOLDOWN_MS);
      if (!response.ok) throw Error('Přehraj.to API HTTP ' + response.status);
      return response.json();
    }
    throw Error('Přehraj.to authorization expired');
  }

  async function search({ email, password, phrase }) {
    if (!phrase || phrase.length > 160) return [];
    const params = new URLSearchParams({ phrase, 'sort-by': 'relevance', limit: '20' });
    return searchItems(await authorized(email, password, '/api/v2/videos/search?' + params));
  }

  async function link({ email, password, id }) {
    const safeId = safeVideoId(id);
    if (!safeId) return null;
    const response = payload(await authorized(email, password,
      '/api/v2/videos/' + encodeURIComponent(safeId) + '/download?mp4=true'));
    const raw = response.download_link || response.downloadLink || null;
    return publicHttpsUrl(raw);
  }

  return { search, link };
}

const accountClient = createPrehrajtoAccountClient();

async function findPrehrajtoAccountStreams({ cfg, meta, type, season, episode },
  { api = accountClient } = {}) {
  if (!cfg || !cfg.prehrajtoEmail || !cfg.prehrajtoPassword ||
      !['movie', 'series'].includes(type)) return [];
  if (type === 'series' && (!Number.isInteger(season) || season < 1 ||
      !Number.isInteger(episode) || episode < 1)) return [];
  const titles = titlesFromMeta(meta);
  if (!titles.length) return [];
  const year = type === 'movie' ? yearFromMeta(meta) : '';
  const credentials = { email: cfg.prehrajtoEmail, password: cfg.prehrajtoPassword };
  const queries = makeQueries(titles, type, year, season, episode).slice(0, MAX_SEARCH_QUERIES);
  const candidates = [];
  const seenIds = new Set();
  // Search sequentially to avoid overwhelming a free account.
  for (const phrase of queries) {
    const files = await api.search({ ...credentials, phrase });
    for (const file of files) {
      const id = safeVideoId(file && (file.id || file.videoId || file.video_id));
      const title = String(file && (file.title || file.name || file.filename) || '').trim();
      if (!id || !acceptsCandidate(title, titles, type, year, season, episode) ||
          seenIds.has(id)) continue;
      seenIds.add(id);
      candidates.push({ id, title, subtitles: file.subtitles });
      if (candidates.length >= MAX_CANDIDATES) break;
    }
    if (candidates.length >= MAX_CANDIDATES) break;
  }
  const streams = Array(candidates.length);
  const seenUrls = new Set();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(MAX_LINK_WORKERS, candidates.length) },
    async () => {
      while (cursor < candidates.length) {
        const index = cursor++;
        const item = candidates[index];
        try {
          const url = publicHttpsUrl(await api.link({ ...credentials, id: item.id }));
          if (!url || seenUrls.has(url)) continue;
          seenUrls.add(url);
          const subtitles = mappedSubtitles(item.subtitles, item.id);
          streams[index] = {
            name: 'Přehraj.to • Direct (účet)',
            title: ['🎧 Neuvedeno',
              '💬 ' + (subtitles.length ? subtitles.length + ' ověřených VTT titulků' : 'Bez ověřených titulků'),
              '🎬 Direct', '🎞 ' + item.title.slice(0, 180)].join('\n'),
            url,
            subtitles,
            behaviorHints: { notWebReady: false }
          };
        } catch (_) {
          // A free account can reject a specific download link. Never bypass
          // the provider's access decision or invent a stream.
        }
      }
    }));
  return streams.filter(Boolean).slice(0, MAX_STREAMS);
}

module.exports = { createPrehrajtoAccountClient, findPrehrajtoAccountStreams,
  publicHttpsUrl, searchItems, accountToken, mappedSubtitles, safeVideoId };
