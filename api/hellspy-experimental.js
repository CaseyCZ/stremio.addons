'use strict';

// Read-only experimental resolver. Not attached to a Stremio manifest yet.
// The service returns only metadata and an HTTPS redirect target; the Oracle
// instance never downloads or proxies the video bytes.
const { normalizeTitle, titleMatchScore, episodeTokens } = require('./search-matching');

const API = 'https://api.hellspy.to/gw/';
const SEARCH_CACHE_MS = 10 * 60 * 1000;
const MAX_CACHED_SEARCHES = 100;

function exactEpisode(title, season, episode) {
  if (!Number.isInteger(season) || season < 1 || !Number.isInteger(episode) || episode < 1) return false;
  const tokens = episodeTokens(title);
  if (!tokens.length || !tokens.every(token => token.season === season && token.episode === episode)) return false;
  const tail = String(title).slice(tokens[0].end);
  return !/^\s*(?:-|to|e|\+)\s*(?:e)?0*\d+\b/i.test(tail);
}

function yearIsCompatible(title, year) {
  if (!year) return true;
  const years = String(title).match(/\b(?:19|20)\d{2}\b/g) || [];
  return years.every(found => found === String(year));
}

function matchingScore(title, titles, type, year, season, episode) {
  if (type === 'series') {
    if (!exactEpisode(title, season, episode)) return 0;
    const normalScore = titleMatchScore(title, titles);
    if (normalScore >= 0.55) return normalScore;
    // Release names often end in an episode title: "Ted Lasso S04E01 Home EN".
    // Only the complete series name BEFORE the episode marker identifies the
    // show; arbitrary spin-off prefixes must not be accepted.
    const token = episodeTokens(title)[0];
    const showName = normalizeTitle(String(title).slice(0, token.pos));
    return titles.some(wanted => normalizeTitle(wanted) === showName) ? 0.98 : 0;
  }
  if (type !== 'movie' || episodeTokens(title).length || !yearIsCompatible(title, year)) return 0;
  let score = titleMatchScore(title, titles);
  // Original films can be uploaded as "Avatar 1 (2009)". Only admit that
  // numbered alias when the exact requested year appears in the filename.
  if (year && normalizeTitle(title).split(' ').includes(String(year))) {
    score = Math.max(score, titleMatchScore(title, titles.map(wanted => wanted + ' 1')));
  }
  return score;
}

function createHellspyClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
  let cooldownUntil = 0;
  const searchCache = new Map();
  const pendingSearches = new Map();

  async function search({ query, titles, type, season, episode, year }) {
    const lookup = String(query || '').trim();
    if (!lookup || lookup.length > 160 || !Array.isArray(titles) || !titles.length) return [];
    if (!['movie', 'series'].includes(type)) return [];
    const key = JSON.stringify([lookup, titles, type, season, episode, year]);
    const cached = searchCache.get(key);
    if (cached && now() < cached.until) return cached.items.map(item => ({ ...item }));
    if (cached) searchCache.delete(key);
    // Simultaneous requests for the same title share one HTTP request, so a
    // burst of Stremio clients cannot accidentally multiply API traffic.
    const pending = pendingSearches.get(key);
    if (pending) return (await pending).map(item => ({ ...item }));
    if (now() < cooldownUntil) throw Error('HellSpy search temporarily rate limited');
    const task = searchUncached({ lookup, key, titles, type, season, episode, year });
    pendingSearches.set(key, task);
    try { return (await task).map(item => ({ ...item })); }
    finally { pendingSearches.delete(key); }
  }

  async function searchUncached({ lookup, key, titles, type, season, episode, year }) {
    const url = new URL('search', API);
    url.searchParams.set('query', lookup);
    url.searchParams.set('offset', '0');
    url.searchParams.set('limit', '40');
    const response = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (response.status === 429) {
      cooldownUntil = now() + 10 * 60 * 1000;
      throw Error('HellSpy search HTTP 429');
    }
    if (!response.ok) throw Error(`HellSpy search HTTP ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data && data.items)) throw Error('Invalid HellSpy search response');
    const unique = new Set();
    const items = data.items.filter(item => item && item.objectType === 'GWSearchVideo')
      .map(item => {
        const id = Number(item.id);
        const fileHash = String(item.fileHash || '');
        const title = String(item.title || '');
        const score = matchingScore(title, titles, type, year, season, episode);
        if (!Number.isSafeInteger(id) || id <= 0 || !/^[a-z0-9_-]{6,128}$/i.test(fileHash) || score < 0.55) return null;
        const key = `${id}:${fileHash}`;
        if (unique.has(key)) return null;
        unique.add(key);
        return { id, fileHash, title, size: Number(item.size) || 0, duration: Number(item.duration) || 0, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    if (searchCache.size >= MAX_CACHED_SEARCHES) searchCache.delete(searchCache.keys().next().value);
    searchCache.set(key, { until: now() + SEARCH_CACHE_MS, items });
    return items;
  }

  async function resolveOriginal({ id, fileHash }) {
    if (!Number.isSafeInteger(id) || id <= 0 || !/^[a-z0-9_-]{6,128}$/i.test(String(fileHash || ''))) return null;
    const response = await fetchImpl(`${API}video/${id}/${fileHash}/download`, {
      method: 'GET', redirect: 'manual',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return null;
    try {
      const redirect = new URL(response.headers.get('location'));
      if (redirect.protocol !== 'https:' || redirect.username || redirect.password) return null;
      if (redirect.hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(redirect.hostname)) return null;
      return redirect.toString();
    } catch (_) { return null; }
  }

  return { search, resolveOriginal };
}

module.exports = { createHellspyClient, exactEpisode, matchingScore };
