'use strict';

// Standalone Prehraj.to provider. Oracle fetches only search/metadata; playback
// and subtitles are requested from premiumcdn.net directly by Stremio clients.
// External APIs are best-effort third-party services, not guaranteed contracts.
const axios = require('axios');
const NodeCache = require('node-cache');

const SEARCH_API = process.env.PREHRAJTO_SEARCH_API || 'https://blaniok.azurewebsites.net/api/search';
const RESOLVE_API = process.env.PREHRAJTO_RESOLVE_API || 'https://ceskarepublika.wiki/api/movies/video-url';
const cache = new NodeCache({ stdTTL: 60, checkperiod: 60, maxKeys: 300 });
const http = axios.create({
  timeout: 11000,
  maxContentLength: 2 * 1024 * 1024,
  headers: {
    Accept: 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36'
  }
});

function normalize(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&amp;/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function yearFromMeta(meta) {
  for (const input of [meta && meta.year, meta && meta.releaseInfo, meta && meta.released]) {
    const match = String(input || '').match(/\b(?:19|20)\d{2}\b/);
    if (match) return match[0];
  }
  return '';
}

function titlesFromMeta(meta) {
  const items = [
    meta && meta.name,
    meta && meta.originalName,
    ...(Array.isArray(meta && meta.nameTranslations) ? meta.nameTranslations : [])
  ];
  const seen = new Set();
  return items.map(value => String(value || '').trim()).filter(value => {
    const key = normalize(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

function validDetailUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (url.protocol !== 'https:' || !['prehraj.to', 'prehrajto.cz'].includes(url.hostname.toLowerCase())) return null;
    if (!/\/[a-f0-9]{13,16}\/?$/i.test(url.pathname)) return null;
    url.hostname = 'prehraj.to';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch (_) { return null; }
}

function validCdnUrl(raw, extension) {
  try {
    const url = new URL(String(raw || '').replace(/&amp;/g, '&'));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || (host !== 'premiumcdn.net' && !host.endsWith('.premiumcdn.net'))) return null;
    if (!url.pathname.toLowerCase().endsWith('.' + extension)) return null;
    const expires = url.searchParams.get('expires');
    if (expires && Number(expires) * 1000 < Date.now() + 60000) return null;
    return url.toString();
  } catch (_) { return null; }
}

function hasMatchingYear(candidate, wantedYear) {
  if (!wantedYear) return true;
  const years = String(candidate || '').match(/\b(?:19|20)\d{2}\b/g) || [];
  return years.length === 0 || years.every(year => year === wantedYear);
}

// Words allowed after an *entire* movie/show name, not an arbitrary substring.
// Prevents a search for "Ted" from matching "Ted Lasso" or other spin-offs.
function metadataOnly(text) {
  return !String(text || '').split(/\s+/).filter(Boolean).some(word =>
    !/^(?:(?:19|20)\d{2}|(?:2160|1440|1080|720|576|480|360)p|4k|uhd|fhd|hd|sd|cz|cs|cze|sk|slo|en|eng|dab|dabing|dub|sub|subs|titulky|titulkovana|tit|srt|vtt|rip|webrip|web|dl|bluray|brrip|h264|h265|x264|x265|hevc|mp4|mkv|aac|dts|ddp|ac3|a|audiotrack|original|dual|multi|původní|top\d*)$/i.test(word)
  );
}

function episodeTokens(text) {
  const source = String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const tokens = [];
  for (const re of [
    /(?:^|[^a-z0-9])s0*(\d{1,2})[\s._-]*e0*(\d{1,3})(?=$|[^a-z0-9])/g,
    /(?:^|[^a-z0-9])0*(\d{1,2})\s*[x×]\s*0*(\d{1,3})(?=$|[^a-z0-9])/g
  ]) {
    for (const match of source.matchAll(re)) {
      const offset = match[0].length - match[0].trimStart().length;
      tokens.push({ season: Number(match[1]), episode: Number(match[2]), pos: match.index + offset, end: match.index + match[0].length });
    }
  }
  return tokens.sort((a, b) => a.pos - b.pos);
}

function acceptsCandidate(candidateTitle, titles, type, year, season, episode) {
  const raw = String(candidateTitle || '');
  if (!raw || !titles.length || /\b(?:trailer|teaser|recap|review|reaction|parody)\b/i.test(raw)) return false;
  if (type === 'movie') {
    if (episodeTokens(raw).length || !hasMatchingYear(raw, year)) return false;
    const source = normalize(raw);
    return titles.some(title => {
      const wanted = normalize(title);
      if (source === wanted) return true;
      if (!source.startsWith(wanted + ' ')) return false;
      return metadataOnly(source.slice(wanted.length).trim());
    });
  }
  if (type !== 'series' || !Number.isInteger(season) || season < 1 ||
      !Number.isInteger(episode) || episode < 1) return false;
  const found = episodeTokens(raw);
  if (!found.length || !found.every(item => item.season === season && item.episode === episode)) return false;
  // Reject multi-episode packages such as S01E02-13 or S01E02E03.
  const after = raw.slice(found[0].end);
  if (/^\s*(?:-|to|e|\+)\s*(?:e)?0*\d+\b/i.test(after)) return false;
  const before = normalize(raw.slice(0, found[0].pos));
  return titles.some(title => {
    const wanted = normalize(title);
    return before === wanted || (before.startsWith(wanted + ' ') && metadataOnly(before.slice(wanted.length).trim()));
  });
}

function makeQueries(titles, type, year, season, episode) {
  const queries = [];
  for (const title of titles.slice(0, 3)) {
    if (type === 'series') {
      if (!Number.isInteger(season) || !Number.isInteger(episode)) continue;
      queries.push(title + ' S' + String(season).padStart(2, '0') + 'E' + String(episode).padStart(2, '0'));
    } else {
      queries.push(year ? title + ' ' + year : title);
    }
  }
  if (type === 'movie' && titles[0] && year) queries.push(titles[0]);
  if (type === 'series' && titles[0]) queries.push(titles[0]);
  return [...new Set(queries)].slice(0, 4);
}

async function searchApi(query) {
  const key = normalize(query);
  const found = cache.get(key);
  if (found !== undefined) return found;
  const resp = await http.get(SEARCH_API, { params: { q: query } });
  if (!resp.data || resp.data.success !== true || !Array.isArray(resp.data.movies)) throw Error('search API returned no valid movie list');
  const movies = resp.data.movies.slice(0, 40);
  cache.set(key, movies, movies.length ? 60 : 10);
  return movies;
}

async function resolveApi(pageUrl) {
  const resp = await http.get(RESOLVE_API, { params: { url: pageUrl } });
  if (!resp.data || resp.data.success !== true) throw Error('resolver did not return a playable source');
  return resp.data;
}

function mapSubtitle(item, uploadId, index) {
  const url = validCdnUrl(item && item.url, 'vtt');
  if (!url) return null;
  const incoming = String(item.lang || '').toLowerCase();
  const label = String(item.label || '').trim().slice(0, 40);
  let lang;
  if (['cze', 'ces', 'cs'].includes(incoming)) lang = 'ces';
  else if (['slo', 'slk', 'sk'].includes(incoming)) lang = 'slk';
  else if (/^(?:eng|en|ng)[0-9]*$/.test(incoming) || /^eng\d*$/i.test(label)) lang = 'eng';
  else return null;
  const human = lang === 'ces' ? 'Čeština' : lang === 'slk' ? 'Slovenčina' : 'English';
  const suffix = /^(?:ENG)(\d+)$/i.exec(label);
  return {
    id: 'prehrajto-' + uploadId + '-' + index + '-' + lang,
    lang,
    label: 'Přehraj.to – ' + human + (suffix ? ' ' + suffix[1] : ''),
    url
  };
}

function makeStream(item, pageUrl, resolved) {
  const url = validCdnUrl(resolved && (resolved.video_url || resolved.videoUrl), 'mp4');
  if (!url) return null;
  const id = new URL(pageUrl).pathname.split('/').filter(Boolean).pop();
  const subtitles = (Array.isArray(resolved.subtitles) ? resolved.subtitles : [])
    .slice(0, 20).map((sub, index) => mapSubtitle(sub, id, index)).filter(Boolean);
  const languages = [...new Set(subtitles.map(sub => sub.lang === 'ces' ? 'CZ' : sub.lang === 'slk' ? 'SK' : 'EN'))];
  const title = String(item.title || '').trim().slice(0, 180);
  return {
    name: 'Přehraj.to',
    title: 'MP4 • kvalita nezjištěna\n💬 ' + (languages.join(' / ') || 'Bez ověřených titulků') + (title ? '\n' + title : ''),
    description: title,
    url,
    subtitles,
    behaviorHints: { notWebReady: false, filename: title ? title + '.mp4' : undefined }
  };
}

async function findPrehrajtoStreams({ meta, type, season, episode }, injected = {}) {
  if (!['movie', 'series'].includes(type)) return [];
  const titles = titlesFromMeta(meta);
  if (!titles.length) return [];
  const year = type === 'movie' ? yearFromMeta(meta) : '';
  const search = injected.search || searchApi;
  const resolve = injected.resolve || resolveApi;
  const visited = new Set();
  let attempts = 0;
  const streams = [];
  for (const query of makeQueries(titles, type, year, season, episode)) {
    let movies;
    try { movies = await search(query); }
    catch (error) {
      console.warn('[prehrajto] search unavailable: ' + error.message);
      continue;
    }
    for (const item of Array.isArray(movies) ? movies : []) {
      const pageUrl = validDetailUrl(item && item.url);
      if (!pageUrl || visited.has(pageUrl)) continue;
      visited.add(pageUrl);
      if (!acceptsCandidate(item.title, titles, type, year, season, episode)) continue;
      if (++attempts > 3) return streams;
      try {
        const result = makeStream(item, pageUrl, await resolve(pageUrl));
        if (result) streams.push(result);
      } catch (error) {
        console.warn('[prehrajto] resolver unavailable: ' + error.message);
      }
    }
    if (streams.length) break;
  }
  return streams;
}

module.exports = {
  findPrehrajtoStreams, acceptsCandidate, episodeTokens, mapSubtitle, makeStream,
  validDetailUrl, validCdnUrl, titlesFromMeta, makeQueries
};
