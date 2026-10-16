const axios = require('axios');
const NodeCache = require('node-cache');

const BASE_URL = 'https://v3-cinemeta.strem.io';
const cache = new NodeCache({ stdTTL: 6 * 60 * 60, checkperiod: 10 * 60, maxKeys: 3000 });
const pending = new Map();

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = String(value || '').trim();
    if (!text) continue;
    const key = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

class CinemetaApi {
  constructor() {
    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: 8000,
      maxContentLength: 4 * 1024 * 1024,
      headers: { 'User-Agent': 'CaseyCZ-Stremio-SKTOnline/0.1', Accept: 'application/json' }
    });
  }

  async getMeta(type, imdbId) {
    if (!['movie', 'series'].includes(type) || !/^tt\d{5,10}$/i.test(String(imdbId || ''))) return null;
    const id = String(imdbId).toLowerCase();
    const key = `${type}:${id}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached || null;
    if (pending.has(key)) return pending.get(key);

    const request = this.http.get(`/meta/${type}/${encodeURIComponent(id)}.json`)
      .then(response => response.data && response.data.meta ? response.data.meta : null)
      .catch(error => {
        console.warn(`[cinemeta] ${type}/${id}: ${error.message}`);
        return null;
      })
      .then(meta => {
        cache.set(key, meta || false, meta ? 6 * 60 * 60 : 15 * 60);
        return meta;
      })
      .finally(() => pending.delete(key));

    pending.set(key, request);
    return request;
  }
}

module.exports = { CinemetaApi, uniqueStrings };
