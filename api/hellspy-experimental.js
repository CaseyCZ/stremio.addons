'use strict';

// Read-only experimental resolver. Not attached to a Stremio manifest yet.
// The service returns only metadata and an HTTPS redirect target; the Oracle
// instance never downloads or proxies the video bytes.
const { titleMatchScore, episodeTokens } = require('./search-matching');

const API = 'https://api.hellspy.to/gw/';

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

function createHellspyClient({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
  let cooldownUntil = 0;

  async function search({ query, titles, type, season, episode, year }) {
    const lookup = String(query || '').trim();
    if (!lookup || lookup.length > 160 || !Array.isArray(titles) || !titles.length) return [];
    if (now() < cooldownUntil) throw Error('HellSpy search temporarily rate limited');
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
    return data.items.filter(item => item && item.objectType === 'GWSearchVideo')
      .map(item => {
        const id = Number(item.id);
        const fileHash = String(item.fileHash || '');
        const title = String(item.title || '');
        const score = titleMatchScore(title, titles);
        if (!Number.isSafeInteger(id) || id <= 0 || !/^[a-z0-9_-]{6,128}$/i.test(fileHash) || score < 0.55) return null;
        if (type === 'series' ? !exactEpisode(title, season, episode) : !yearIsCompatible(title, year)) return null;
        const key = `${id}:${fileHash}`;
        if (unique.has(key)) return null;
        unique.add(key);
        return { id, fileHash, title, size: Number(item.size) || 0, duration: Number(item.duration) || 0, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
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

module.exports = { createHellspyClient, exactEpisode };
