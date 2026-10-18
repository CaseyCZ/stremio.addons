'use strict';

// Read-only translation of Bombuj catalogue IDs to their verified IMDb identities.
// Existing Bombuj metadata service remains the source of truth.
const BASE_URL = process.env.BOMBUJ_META_URL || 'http://127.0.0.1:7004';
const IMDB = /^tt\d{5,12}$/i;
const MOVIE = /^bombuj-movie-[a-z0-9-]+$/i;
const SERIES = /^bombuj-series-([a-z0-9-]+?)(?::(\d+):(\d+))?$/i;
const EPISODE = /^bombuj-episode-([a-z0-9-]+)-(\d+)x(\d+)$/i;
const cache = new Map();

function parseBombujId(type, input) {
  const id = String(input || '').toLowerCase();
  if (type === 'movie' && MOVIE.test(id)) {
    return {metaId:id,season:null,episode:null};
  }
  if (type !== 'series') return null;
  const show = id.match(SERIES);
  const ep = show ? null : id.match(EPISODE);
  if (!show && !ep) return null;
  const season = (show ? show[2] : ep[2]) ? Number(show ? show[2] : ep[2]) : null;
  const episode = (show ? show[3] : ep[3]) ? Number(show ? show[3] : ep[3]) : null;
  if ((season !== null && (season < 1 || season > 100)) ||
      (episode !== null && (episode < 1 || episode > 1000))) return null;
  return {metaId:show ? 'bombuj-series-'+show[1] : id,season,episode};
}

async function resolveBombujId(type, input, options = {}) {
  const parsed = parseBombujId(type, input);
  if (!parsed) return null;
  const key = type + ':' + String(input).toLowerCase();
  if (!options.fetchImpl) {
    const hit = cache.get(key);
    if (hit && hit.expiry > Date.now()) return hit.value;
  }
  const fetcher = options.fetchImpl || fetch;
  const base = options.baseUrl || BASE_URL;
  const response = await fetcher(base + '/meta/' + type + '/' + parsed.metaId + '.json', {
    signal: AbortSignal.timeout(9000),
    headers: {Accept:'application/json'}
  });
  if (!response.ok) throw Error('Bombuj metadata HTTP '+response.status);
  const body = await response.json();
  const meta = body && body.meta;
  const imdbId = String((meta && meta.imdb_id) ||
    (meta && IMDB.test(meta.id || '') ? meta.id : '')).toLowerCase();
  const value = IMDB.test(imdbId) ? {
    imdbId,
    season:parsed.season,
    episode:parsed.episode,
    canonicalId:parsed.season !== null && parsed.episode !== null ?
      imdbId+':'+parsed.season+':'+parsed.episode : imdbId,
    sourceId:String(input)
  } : null;
  if (!options.fetchImpl) cache.set(key,{value,expiry:Date.now()+(value?43200000:120000)});
  return value;
}

module.exports = {parseBombujId,resolveBombujId};
