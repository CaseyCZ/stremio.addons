'use strict';

const { parseBombujPlayerGroups } = require('./player-groups.js');
const IMDB_ID = /^tt\d{5,12}$/i;

function movieImdbId(html) {
  // Player AJAX settings in Bombuj movie detail contain the authoritative
  // IMDb identifier. Never infer an ID from unrelated sidebar recommendations.
  const ids = [...new Set([...String(html || '').matchAll(/\bimdb_id\s*:\s*["'](tt\d{5,12})["']/gi)]
    .map(m => m[1].toLowerCase()))];
  return ids.length === 1 ? ids[0] : null;
}

function seriesImdbId(episodeHtml) {
  // The series show detail page has no IMDb ID. The episode's real player
  // links (EN embeds) use iid=tt..., while the player AJAX IDs in movies
  // use imdb_id. Ignore arbitrary text, comments and recommendations.
  const players = parseBombujPlayerGroups(episodeHtml);
  const ids = new Set();
  for (const p of players) {
    try {
      const url = new URL(p.url, 'https://serialy.bombuj.si');
      const id = String(url.searchParams.get('iid') ||
        url.searchParams.get('imdb_id') || '').toLowerCase();
      if (IMDB_ID.test(id)) ids.add(id);
    } catch {}
  }
  return ids.size === 1 ? [...ids][0] : null;
}

async function fetchCinemetaById(type, imdbId, fetchJson) {
  if (!['movie', 'series'].includes(type) || !IMDB_ID.test(imdbId || '')) return null;
  const id = imdbId.toLowerCase();
  const result = await fetchJson(
    'https://v3-cinemeta.strem.io/meta/' + type + '/' + id + '.json'
  );
  const meta = result?.meta;
  if (!meta || String(meta.id || '').toLowerCase() !== id ||
      (meta.type && meta.type !== type)) return null;
  return meta;
}

function mismatchedSeriesYear(source, meta) {
  if (source?.type !== 'series') return false;
  const firstYear = text => String(text || '').match(/(?:19|20)\d{2}/)?.[0];
  const local = firstYear(source.releaseInfo || source.released);
  const remote = firstYear(meta?.releaseInfo || meta?.released);
  return Boolean(local && remote && Math.abs(Number(local) - Number(remote)) >= 2);
}

function mergeCinemeta(source, meta) {
  if (!source || !meta) return source;
  // Strong IDs can legitimately refer to an anthology's parent series
  // (Monster vs Bombuj's "Lizzie Borden Story"). Retain Bombuj's names
  // and *all* locally resolved episode IDs; never adopt Cinemeta videos.
  const fields = [
    'poster', 'background', 'logo', 'description', 'genres', 'cast',
    'director', 'runtime', 'imdbRating', 'country', 'releaseInfo',
    'released', 'trailers', 'links', 'awards', 'website'
  ];
  const merged = { ...source, imdb_id: meta.id };

  // A Bombuj "show" can actually be one recent season of an older
  // anthology. For example The Lizzie Borden Story (2026) resolves to
  // the parent show Monster (2022). The ID is valid but the parent's
  // synopsis, year, poster and cast would misdescribe the requested season.
  // Prefer Bombuj's existing information when those release years diverge
  // substantially; leave the ID attached for future episode lookups.
  if (mismatchedSeriesYear(source, meta)) {
    return merged;
  }

  for (const field of fields) {
    if (meta[field] != null && meta[field] !== '') merged[field] = meta[field];
  }
  return merged;
}

// When an episode player has no IMDb ID, match the series catalogue by
// *complete* title and compatible year. Substring matches are unsafe.
function seriesSearchName(name) {
  return String(name || '').replace(/\s*\(\d{1,2}\.\s*(?:séria|série|season)\)\s*$/i, '').trim();
}

function comparableTitle(title) {
  return String(title || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function selectCinemetaSeriesCandidate(metas, name, year) {
  const expected = comparableTitle(seriesSearchName(name));
  if (expected.length < 3 || !Array.isArray(metas)) return null;
  const compact = expected.replace(/\s+/g, '');
  const expectedYear = String(year || '').match(/(?:19|20)\d{2}/)?.[0];
  const matches = [];
  for (const meta of metas) {
    const id = meta?.id || meta?.imdb_id;
    if (!/^tt\d{5,12}$/i.test(id || '') || (meta.type && meta.type !== 'series')) continue;
    const candidateNames = [meta.name, ...(Array.isArray(meta.aliases) ? meta.aliases : [])]
      .map(comparableTitle).filter(Boolean);
    if (!candidateNames.some(value => value === expected ||
      (compact.length >= 5 && value.replace(/\s+/g, '') === compact))) continue;
    const remoteYear = String(meta.releaseInfo || meta.year || meta.released || '')
      .match(/(?:19|20)\d{2}/)?.[0];
    if (expectedYear && remoteYear && Math.abs(Number(expectedYear)-Number(remoteYear)) >= 2) continue;
    const exact = candidateNames.includes(expected);
    matches.push({ meta, score: (exact ? 100 : 90) +
      (expectedYear && remoteYear === expectedYear ? 20 : 0) });
  }
  matches.sort((a,b) => b.score - a.score);
  // An identical-score tie means we cannot safely identify the show.
  return matches.length && (matches.length === 1 || matches[0].score > matches[1].score)
    ? matches[0].meta : null;
}

// Cinemeta returns Stremio videos as { season, number, name } (rather than
// { season, episode, title }). Support BOTH formats, but only enrich the
// same numbered episode; never remap Bombuj IDs or use array positions.
function cinemetaEpisodeTitle(meta, season, episode) {
  if (!Number.isInteger(season) || !Number.isInteger(episode) ||
      !Array.isArray(meta?.videos)) return null;
  const video = meta.videos.find(item => item &&
    Number(item.season) === season &&
    Number(item.episode ?? item.number) === episode);
  if (!video) return null;
  for (const value of [video.name, video.title]) {
    const title = String(value || '').replace(/\s+/g, ' ').trim();
    if (title && title.length <= 160 &&
        !/^(?:episode|epizoda|epizóda|ep\.?)\s*#?\s*(?:\d+(?:[.×x]\d+)?|[ivxlcdm]+)$/i.test(title)) {
      return title;
    }
  }
  return null;
}

function enrichCinemetaSeries(source, meta) {
  if (!source || !meta) return source;
  const merged = mergeCinemeta(source, meta);
  if (mismatchedSeriesYear(source, meta) || !Array.isArray(source.videos)) return merged;
  return {
    ...merged,
    videos: source.videos.map(video => {
      const title = cinemetaEpisodeTitle(meta, video.season, video.episode);
      return title ? { ...video, title } : video;
    })
  };
}

// Native Bombuj catalogue IDs cannot be queried by independent addons such
// as Sosac (which supports IMDb IDs). Prefer a VERIFIED shared IMDb identity
// for show catalogue cards. Preserve native IDs whenever mapping or season
// identity is unavailable; individual latest-episode cards remain untouched.
function sharedCinemetaSeriesCatalogMeta(source, meta) {
  const merged = mergeCinemeta(source, meta);
  if (!meta || !/^tt\d{5,12}$/i.test(String(meta.id || '')) ||
      mismatchedSeriesYear(source, meta)) return merged;
  return { ...merged, id: String(meta.id).toLowerCase() };
}

function enrichCinemetaEpisode(source, meta, season, episode) {
  if (!source || !meta) return source;
  const enriched = enrichCinemetaSeries(source, meta);
  if (mismatchedSeriesYear(source, meta)) return enriched;
  const title = cinemetaEpisodeTitle(meta, season, episode);
  return title ? { ...enriched, name: source.name + ' – ' + title } : enriched;
}

module.exports = {
  movieImdbId, seriesImdbId, fetchCinemetaById, mergeCinemeta,
  cinemetaEpisodeTitle, enrichCinemetaSeries, enrichCinemetaEpisode,
  sharedCinemetaSeriesCatalogMeta,
  seriesSearchName, selectCinemetaSeriesCandidate
};
