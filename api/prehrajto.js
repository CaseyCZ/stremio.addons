'use strict';

// Standalone Prehraj.to provider. Oracle fetches only search/metadata; playback
// and subtitles are requested from premiumcdn.net directly by Stremio clients.
// External APIs are best-effort third-party services, not guaranteed contracts.
const axios = require('axios');
const NodeCache = require('node-cache');
const { episodeTokens } = require('./search-matching');

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

// Only accept release metadata after a COMPLETE movie title. Release groups
// are allowed after a known format marker; sequel/spinoff words stay rejected.
// Series matching intentionally keeps its existing stricter logic.
const movieReleaseWords = new Set([
  "2160p",
  "1440p",
  "1080p",
  "720p",
  "576p",
  "480p",
  "360p",
  "240p",
  "4k",
  "uhd",
  "fhd",
  "hd",
  "sd",
  "web",
  "dl",
  "webrip",
  "webdl",
  "webcap",
  "bluray",
  "blu",
  "ray",
  "bdrip",
  "brrip",
  "bdremux",
  "bd",
  "rip",
  "dvdrip",
  "dvd",
  "hdrip",
  "hdtv",
  "remux",
  "repack",
  "proper",
  "internal",
  "extended",
  "uncut",
  "remastered",
  "theatrical",
  "directors",
  "director",
  "cut",
  "criterion",
  "imax",
  "edition",
  "special",
  "anniversary",
  "hybrid",
  "hevc",
  "avc",
  "av1",
  "x264",
  "x265",
  "h264",
  "h265",
  "h266",
  "h",
  "xvid",
  "divx",
  "hdr",
  "hdr10",
  "hdr10plus",
  "dv",
  "dovi",
  "dolby",
  "vision",
  "sdr",
  "bit",
  "8bit",
  "10bit",
  "12bit",
  "fps",
  "aac",
  "ac3",
  "eac3",
  "dd",
  "ddp",
  "ddplus",
  "dts",
  "truehd",
  "ma",
  "atmos",
  "flac",
  "mp3",
  "opus",
  "pcm",
  "cz",
  "cs",
  "cze",
  "ces",
  "sk",
  "slo",
  "slk",
  "en",
  "eng",
  "czech",
  "english",
  "slovak",
  "cesky",
  "cestina",
  "slovensky",
  "slovencina",
  "dab",
  "dabing",
  "dub",
  "dubbed",
  "sub",
  "subs",
  "subtitles",
  "titulky",
  "tit",
  "srt",
  "vtt",
  "dual",
  "multi",
  "audio",
  "audiotrack",
  "original",
  "forced",
  "max",
  "hmax",
  "hbo",
  "nf",
  "netflix",
  "amzn",
  "amazon",
  "dsnp",
  "disney",
  "atvp",
  "itunes",
  "hulu",
  "apple",
  "paramount"
]);

function movieReleaseMatches(candidate, title) {
  const wanted = normalize(title);
  if (!wanted) return false;
  const raw = String(candidate || '');
  // Accept hyphenated release-group tags only after a genuine format marker.
  // This never treats an arbitrary extra film-title word as release metadata.
  const group = raw.match(/[-–—][a-z][a-z0-9]{1,24}(?:\s*\(\d{1,2}\))?\s*$/i);
  const prefix = group ? raw.slice(0, group.index) : raw;
  const prefixNormalized = normalize(prefix);
  const afterTitle = prefixNormalized.startsWith(wanted + ' ')
    ? prefixNormalized.slice(wanted.length).trim().split(' ') : [];
  const hasFormatMarker = afterTitle.some(word =>
    /^(?:2160p|1440p|1080p|720p|576p|480p|360p|240p|4k|uhd|fhd|webrip|web|bluray|bdrip|dvdrip|remux|x264|x265|hevc|h264|h265|hdr|hdr10|dv|ddp|dts|aac|ac3)$/.test(word));
  const withoutGroup = group && hasFormatMarker ? prefix : raw;
  const source = normalize(withoutGroup);
  if (source === wanted) return true;
  if (!source.startsWith(wanted + ' ')) return false;
  const remainder = source.slice(wanted.length).trim().split(' ');
  let hasMediaTag = false;
  for (const word of remainder) {
    if (/^(?:19|20)\d{2}$/.test(word)) continue;
    if (movieReleaseWords.has(word)) { hasMediaTag = true; continue; }
    // Czech/English conjunctions occur in language tags (CZ a SK / CZ and SK).
    if (hasMediaTag && /^(?:a|and)$/.test(word)) continue;
    // Numeric codec/channel metadata only applies after a release tag,
    // never immediately after the movie title (e.g. Ted vs Ted 2).
    if (hasMediaTag && /^\d{1,3}$/.test(word)) continue;
    return false;
  }
  return true;
}

function acceptsCandidate(candidateTitle, titles, type, year, season, episode) {
  const raw = String(candidateTitle || '');
  if (!raw || !titles.length || /\b(?:trailer|teaser|recap|review|reaction|parody)\b/i.test(raw)) return false;
  if (type === 'movie') {
    if (episodeTokens(raw).length || !hasMatchingYear(raw, year)) return false;
    return titles.some(title => movieReleaseMatches(raw, title));
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
  for (const [index, title] of titles.slice(0, 3).entries()) {
    if (type === 'series') {
      if (!Number.isInteger(season) || !Number.isInteger(episode)) continue;
      queries.push(title + ' S' + String(season).padStart(2, '0') + 'E' + String(episode).padStart(2, '0'));
      // Some uploads use S4E4 instead of S04E04; only query this for the
      // primary title to avoid overloading the upstream search service.
      if (index === 0) queries.push(title + ' S' + season + 'E' + episode);
    } else {
      queries.push(year ? title + ' ' + year : title);
    }
  }
  if (type === 'movie' && titles[0] && year) queries.push(titles[0]);
  if (type === 'series' && titles[0]) queries.push(titles[0]);
  return [...new Set(queries)].slice(0, type === 'series' ? 5 : 4);
}

// Keep more distinct uploads for episodes with many valid releases. The
// four-worker concurrency and overall deadline still bound upstream load.
const MAX_STREAMS = 16;
const MAX_RESOLVE_ATTEMPTS = 24;
const RESOLVE_CONCURRENCY = 4;
const LOOKUP_BUDGET_MS = 22000;

// Upstream lookup shares one deadline and aborts unfinished HTTP requests.
async function searchApi(query, { signal } = {}) {
  const key = normalize(query);
  const found = cache.get(key);
  if (found !== undefined) return found;
  const resp = await http.get(SEARCH_API, { params: { q: query }, signal });
  if (!resp.data || resp.data.success !== true || !Array.isArray(resp.data.movies)) throw Error('search API returned no valid movie list');
  const movies = resp.data.movies.slice(0, 60);
  cache.set(key, movies, movies.length ? 60 : 10);
  return movies;
}

async function resolveApi(pageUrl, { signal } = {}) {
  const resp = await http.get(RESOLVE_API, { params: { url: pageUrl }, signal });
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

// Quality below is a release-name label, NOT a measured video resolution.
function releaseQuality(title) {
  const value = String(title || '');
  if (/\b(?:2160p|4k|uhd)\b/i.test(value)) return '2160p';
  if (/\b1440p\b/i.test(value)) return '1440p';
  if (/\b(?:1080p|fhd)\b|\bfull[\s._-]*hd\b/i.test(value)) return '1080p';
  if (/\b720p\b/i.test(value)) return '720p';
  if (/\b(?:480p|576p)\b/i.test(value)) return /\b576p\b/i.test(value) ? '576p' : '480p';
  if (/\b360p\b/i.test(value)) return '360p';
  if (/\bhd\b/i.test(value)) return 'HD';
  if (/\bsd\b/i.test(value)) return 'SD';
  return 'Direct';
}

// Only call an audio language when the release title explicitly says DAB/DUB.
// "CZ titulky" alone must not be treated as Czech dubbing.
function releaseAudio(title) {
  const value = normalize(title);
  const dub = '(?:dab|dabing|dub|dubbed)';
  const languages = [
    ['(?:cz|cs|cze|ces|cesky|cestina)', '🇨🇿 CZ'],
    ['(?:sk|slo|slk|slovensky|slovencina)', '🇸🇰 SK'],
    ['(?:en|eng|english|anglicky)', '🇬🇧 EN']
  ];
  const found = languages.filter(([code]) =>
    new RegExp('(?:^| )' + code + ' ' + dub + '(?: |$)|(?:^| )' + dub + ' ' + code + '(?: |$)').test(value)
  ).map(([, flag]) => flag);
  return found.length ? found.join(' • ') : 'Neuvedeno';
}

function makeStream(item, pageUrl, resolved) {
  const url = validCdnUrl(resolved && (resolved.video_url || resolved.videoUrl), 'mp4');
  if (!url) return null;
  const id = new URL(pageUrl).pathname.split('/').filter(Boolean).pop();
  const subtitles = (Array.isArray(resolved.subtitles) ? resolved.subtitles : [])
    .slice(0, 20).map((sub, index) => mapSubtitle(sub, id, index)).filter(Boolean);
  const releaseTitle = String(item.title || '').trim().slice(0, 180);
  const quality = releaseQuality(releaseTitle);
  const subtitleFlags = { ces: '🇨🇿 CZ', slk: '🇸🇰 SK', eng: '🇬🇧 EN' };
  const subtitleLanguages = [...new Set(subtitles.map(sub => sub.lang))]
    .map(lang => subtitleFlags[lang] || lang);
  return {
    name: 'Přehraj.to • ' + quality,
    // Stremio Core treats "title" as an alias for "description": NEVER send both.
    title: [
      '🎧 ' + releaseAudio(releaseTitle),
      '💬 ' + (subtitleLanguages.join(' • ') || 'Bez titulků'),
      '🎬 ' + quality,
      releaseTitle ? '🎞 ' + releaseTitle : null
    ].filter(Boolean).join('\n'),
    url,
    subtitles,
    behaviorHints: { notWebReady: false, filename: releaseTitle ? releaseTitle + '.mp4' : undefined }
  };
}

async function findPrehrajtoStreams({ meta, type, season, episode }, injected = {}) {
  if (!['movie', 'series'].includes(type)) return [];
  const titles = titlesFromMeta(meta);
  if (!titles.length) return [];
  const year = type === 'movie' ? yearFromMeta(meta) : '';
  const search = injected.search || searchApi;
  const resolve = injected.resolve || resolveApi;
  // Test-only override; production requests always have a 22s deadline.
  const budgetMs = Number.isInteger(injected.budgetMs) && injected.budgetMs > 0 &&
    injected.budgetMs <= LOOKUP_BUDGET_MS ? injected.budgetMs : LOOKUP_BUDGET_MS;
  const controller = new AbortController();
  const resolved = [];
  let timer;
  const deadline = new Promise(done => {
    timer = setTimeout(() => {
      controller.abort();
      done(resolved.filter(Boolean).slice(0, MAX_STREAMS));
    }, budgetMs);
  });

  async function lookup() {
    const queries = makeQueries(titles, type, year, season, episode);
    // Search all title variants concurrently without changing their priority.
    const groups = await Promise.all(queries.map(async query => {
      try { return await search(query, { signal: controller.signal }); }
      catch (error) {
        if (!controller.signal.aborted)
          console.warn('[prehrajto] search unavailable: ' + error.message);
        return [];
      }
    }));
    if (controller.signal.aborted) return [];

    const candidates = [];
    const visited = new Set();
    for (const movies of groups) {
      for (const item of Array.isArray(movies) ? movies : []) {
        const pageUrl = validDetailUrl(item && item.url);
        if (!pageUrl || visited.has(pageUrl) ||
            !acceptsCandidate(item.title, titles, type, year, season, episode)) continue;
        visited.add(pageUrl);
        candidates.push({ item, pageUrl });
        if (candidates.length >= MAX_RESOLVE_ATTEMPTS) break;
      }
      if (candidates.length >= MAX_RESOLVE_ATTEMPTS) break;
    }

    let next = 0;
    let found = 0;
    async function worker() {
      while (next < candidates.length && found < MAX_STREAMS && !controller.signal.aborted) {
        const index = next++;
        const { item, pageUrl } = candidates[index];
        try {
          const data = await resolve(pageUrl, { signal: controller.signal });
          if (controller.signal.aborted) return;
          const stream = makeStream(item, pageUrl, data);
          if (stream) {
            resolved[index] = stream;
            found++;
          }
        } catch (error) {
          if (!controller.signal.aborted)
            console.warn('[prehrajto] resolver unavailable: ' + error.message);
        }
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(RESOLVE_CONCURRENCY, candidates.length) },
      () => worker()
    ));
    return resolved.filter(Boolean).slice(0, MAX_STREAMS);
  }

  try {
    return await Promise.race([lookup(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  findPrehrajtoStreams, acceptsCandidate, episodeTokens, mapSubtitle, makeStream,
  validDetailUrl, validCdnUrl, titlesFromMeta, makeQueries
};
