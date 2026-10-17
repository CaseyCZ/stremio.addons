const axios = require('axios');
const crypto = require('crypto');
const NodeCache = require('node-cache');

const DEFAULT_DOMAIN = 'kodi-api.sosac.to';
const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const cache = new NodeCache({ stdTTL: 12 * 60 * 60, checkperiod: 10 * 60, maxKeys: 3000 });

function sosacHash(username, password) {
  const step1 = crypto.createHash('md5').update(`${username}:${password}`).digest('hex');
  return crypto.createHash('md5').update(step1 + 'EWs5yVD4QF2sshGm22EWVa').digest('hex');
}

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    const text = String(value || '').trim();
    const key = normalizeTitle(text);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function addTextValues(target, value) {
  if (!value) return;
  if (typeof value === 'string' || typeof value === 'number') {
    target.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(item => addTextValues(target, item));
    return;
  }
  if (typeof value === 'object') Object.values(value).forEach(item => addTextValues(target, item));
}

function itemTitles(item, episodeSeriesOnly = false) {
  const values = [];
  if (!item || typeof item !== 'object') return [];

  if (episodeSeriesOnly) {
    if (item.ne) addTextValues(values, item.n);
    else {
      addTextValues(values, item.t);
      addTextValues(values, item.seriesTitle);
      addTextValues(values, item.show);
    }
  } else {
    addTextValues(values, item.n);
    addTextValues(values, item.originalName);
    addTextValues(values, item.title);
  }
  return uniqueStrings(values);
}

function normalizeImdb(value) {
  if (typeof value === 'string') {
    const text = value.trim();
    const found = text.match(/\btt\d{5,10}\b/i);
    if (found) return found[0].toLowerCase();
    if (/^\d{5,10}$/.test(text)) return `tt${text.padStart(7, '0')}`.toLowerCase();
  }
  if (typeof value === 'number' && Number.isInteger(value) && value >= 10000) {
    const text = String(value);
    if (text.length <= 10) return `tt${text.padStart(7, '0')}`.toLowerCase();
  }
  return null;
}

function extractImdb(value, depth = 0, seen = new Set()) {
  if (depth > 4 || value === null || value === undefined) return null;
  if (typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);

  const preferred = ['imdb', 'imdb_id', 'imdbId', 'imdbid', 'imdbID', 'm'];
  for (const key of preferred) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const candidate = value[key];
    const direct = normalizeImdb(candidate);
    if (direct) return direct;
    if (candidate && typeof candidate === 'object') {
      const nested = extractImdb(candidate, depth + 1, seen);
      if (nested) return nested;
    }
  }

  for (const [key, nested] of Object.entries(value)) {
    if (preferred.includes(key) || !nested || typeof nested !== 'object') continue;
    const found = extractImdb(nested, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function itemYear(item) {
  const direct = Number(item && item.y);
  if (Number.isFinite(direct) && direct >= 1800 && direct <= 2200) return Math.trunc(direct);
  const raw = String(item && (item.releaseInfo || item.released || item.r) || '');
  const match = raw.match(/\b(18|19|20|21)\d{2}\b/);
  return match ? Number(match[0]) : undefined;
}

function titleScore(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.startsWith(nb) || nb.startsWith(na)) return 0.9;
  if (na.includes(nb) || nb.includes(na)) return 0.82;
  const aa = new Set(na.split(' ').filter(Boolean));
  const bb = new Set(nb.split(' ').filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const token of aa) if (bb.has(token)) common += 1;
  return common / Math.max(aa.size, bb.size);
}

function candidateYear(meta) {
  const direct = Number(meta && meta.year);
  if (Number.isFinite(direct) && direct > 1800) return Math.trunc(direct);
  const match = String(meta && meta.releaseInfo || '').match(/\b(18|19|20|21)\d{2}\b/);
  return match ? Number(match[0]) : undefined;
}

function scoreCinemetaCandidate(meta, titles, year) {
  const names = uniqueStrings([
    meta && meta.name,
    meta && meta.originalName,
    ...(Array.isArray(meta && meta.nameTranslations) ? meta.nameTranslations : [])
  ]);
  let score = 0;
  for (const wanted of titles) for (const name of names) score = Math.max(score, titleScore(wanted, name));
  const y = candidateYear(meta);
  if (year && y) {
    const diff = Math.abs(year - y);
    if (diff === 0) score += 0.12;
    else if (diff === 1) score += 0.06;
    else if (diff >= 3) score -= 0.2;
  }
  return score;
}

class SosacOverlay {
  constructor(options = {}) {
    this.username = String(options.username || '').trim();
    this.password = String(options.password || '');
    this.domain = String(options.domain || DEFAULT_DOMAIN).trim() || DEFAULT_DOMAIN;
    this.passwordHash = this.username && this.password ? sosacHash(this.username, this.password) : '';
    this.sosac = axios.create({
      baseURL: `https://${this.domain}`,
      timeout: 15000,
      maxContentLength: 4 * 1024 * 1024,
      headers: { 'User-Agent': 'CaseyCZ-Stremio-SKTOnline-SosacOverlay/1.0', Accept: 'application/json,text/plain,*/*' }
    });
    this.cinemeta = axios.create({
      baseURL: CINEMETA_BASE,
      timeout: 8000,
      maxContentLength: 4 * 1024 * 1024,
      headers: { 'User-Agent': 'CaseyCZ-Stremio-SKTOnline-SosacOverlay/1.0', Accept: 'application/json' }
    });
  }

  isConfigured() {
    return Boolean(this.username && this.passwordHash);
  }

  authParams() {
    if (!this.isConfigured()) throw new Error('Sosac overlay credentials are missing');
    return { username: this.username, password: this.passwordHash };
  }

  async getSosac(path) {
    const response = await this.sosac.get(String(path || '').replace(/^\/+/, ''), { params: this.authParams() });
    return response.data;
  }

  async getCinemetaMeta(type, imdbId) {
    try {
      const response = await this.cinemeta.get(`/meta/${type}/${encodeURIComponent(imdbId)}.json`);
      return response.data && response.data.meta ? response.data.meta : null;
    } catch (_) {
      return null;
    }
  }

  async resolveCinemetaByTitle(type, titles, year) {
    const wanted = uniqueStrings(titles).slice(0, 4);
    if (!wanted.length) return null;
    let best = null;
    let bestScore = -1;

    for (const title of wanted) {
      let metas = [];
      try {
        const response = await this.cinemeta.get(`/catalog/${type}/top/search=${encodeURIComponent(title)}.json`);
        metas = Array.isArray(response.data && response.data.metas) ? response.data.metas : [];
      } catch (_) {}

      for (const meta of metas.slice(0, 15)) {
        if (!/^tt\d{5,10}$/i.test(String(meta && meta.id || ''))) continue;
        const score = scoreCinemetaCandidate(meta, wanted, year);
        if (score > bestScore) {
          best = meta;
          bestScore = score;
        }
      }
      if (bestScore >= 1.05) break;
    }

    if (!best || bestScore < 0.68) return null;
    return String(best.id).toLowerCase();
  }

  async resolve(type, stremioId) {
    const raw = String(stremioId || '');
    const key = `${this.username}:${this.domain}:${type}:${raw}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached || null;
    if (!this.isConfigured()) return null;

    let result = null;

    const movieMatch = raw.match(/^sosac_m_(\d+)$/i);
    if (type === 'movie' && movieMatch) {
      const item = await this.getSosac(`movies/${encodeURIComponent(movieMatch[1])}`);
      let imdbId = extractImdb(item);
      if (!imdbId) imdbId = await this.resolveCinemetaByTitle('movie', itemTitles(item), itemYear(item));
      if (imdbId) result = { id: imdbId, imdbId, season: null, episode: null, sourceId: raw };
    }

    const seriesMatch = raw.match(/^sosac_s_(\d+)$/i);
    if (!result && type === 'series' && seriesMatch) {
      const detail = await this.getSosac(`serials/${encodeURIComponent(seriesMatch[1])}`);
      const info = detail && typeof detail === 'object' && detail.info ? detail.info : detail;
      let imdbId = extractImdb(info);
      if (!imdbId) imdbId = await this.resolveCinemetaByTitle('series', itemTitles(info), itemYear(info));
      if (imdbId) result = { id: imdbId, imdbId, season: null, episode: null, sourceId: raw };
    }

    const episodeMatch = raw.match(/^sosac_ep_(\d+)$/i);
    if (!result && type === 'series' && episodeMatch) {
      const item = await this.getSosac(`episodes/${encodeURIComponent(episodeMatch[1])}`);
      const season = Number(item && item.s);
      const episode = Number(item && item.ep);
      let imdbId = null;
      if (item && item.series && typeof item.series === 'object') imdbId = extractImdb(item.series);
      if (!imdbId) imdbId = await this.resolveCinemetaByTitle('series', itemTitles(item, true), itemYear(item));
      if (imdbId && Number.isFinite(season) && Number.isFinite(episode)) {
        result = { id: `${imdbId}:${season}:${episode}`, imdbId, season, episode, sourceId: raw };
      }
    }

    cache.set(key, result || false, result ? 12 * 60 * 60 : 15 * 60);
    return result;
  }
}

module.exports = { SosacOverlay, extractImdb, itemTitles };
