'use strict';

// Test-branch standalone HellSpy provider. This server fetches search and file
// metadata only. The Stremio player fetches video and VTTs from the CDN.
const { createHellspyClient } = require('./hellspy-experimental');
const { normalizeTitle } = require('./search-matching');

const client = createHellspyClient();
const MAX_STREAMS = 16;
const MAX_RESOLVERS = 4;

function titlesFromMeta(meta) {
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
  for (const value of [meta && meta.year, meta && meta.releaseInfo, meta && meta.released]) {
    const match = String(value || '').match(/\b(?:19|20)\d{2}\b/);
    if (match) return match[0];
  }
  return '';
}

function directVttUrl(raw) {
  try {
    const url = new URL(String(raw || ''));
    if (url.protocol !== 'https:' || url.username || url.password || !url.pathname.toLowerCase().endsWith('.vtt')) return null;
    if (url.hostname === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) return null;
    return url.toString();
  } catch (_) { return null; }
}

function subtitleLanguage(code) {
  // HellSpy variants such as eng1 and zho2 are distinct tracks but must use
  // the canonical 3-letter language code accepted by Stremio.
  const normalized = String(code || '').toLowerCase().replace(/\d+$/, '');
  const aliases = { cze: 'ces', slo: 'slk', cs: 'ces', sk: 'slk', en: 'eng' };
  const lang = aliases[normalized] || normalized;
  return /^[a-z]{3}$/.test(lang) ? lang : 'und';
}

function hellspySubtitles(subtitles, videoId) {
  if (!Array.isArray(subtitles)) return [];
  return subtitles.map((entry, index) => {
    const url = directVttUrl(entry && entry.url);
    if (!url) return null;
    const original = String(entry.language || entry.title || '').trim().slice(0, 30);
    const label = String(entry.title || original || 'Unknown').trim().slice(0, 40);
    return {
      id: `hellspy-${videoId}-${entry.id || index}-${index}`,
      lang: subtitleLanguage(original),
      label: 'HellSpy • ' + label.toUpperCase(),
      url
    };
  }).filter(Boolean);
}

function safeFilename(raw) {
  const filename = String(raw || '').split(/[\\/]/).pop().replace(/[\r\n\t]/g, '').slice(0, 180);
  return /\.(?:mp4|mkv|webm|mov|avi)$/i.test(filename) ? filename : undefined;
}

function releaseQuality(title) {
  if (/\b(?:2160p|4k|uhd)\b/i.test(title)) return '2160p';
  if (/\b1080p\b|full[ ._-]*hd/i.test(title)) return '1080p';
  if (/\b720p\b/i.test(title)) return '720p';
  return 'Direct';
}

function toStream(item, videoUrl, details) {
  const subtitles = hellspySubtitles(details && details.subtitles, item.id);
  const quality = releaseQuality(item.title);
  return {
    name: 'HellSpy • ' + quality,
    title: [
      '💬 ' + (subtitles.length ? `${subtitles.length} dostupných titulků` : 'Bez titulků'),
      '🎬 ' + quality,
      item.title ? '🎞 ' + item.title.slice(0, 180) : null
    ].filter(Boolean).join('\n'),
    url: videoUrl,
    subtitles,
    behaviorHints: { notWebReady: false, filename: safeFilename(details && details.filename) }
  };
}

async function findHellspyStreams({ meta, type, season, episode }, { api = client } = {}) {
  if (!['movie', 'series'].includes(type)) return [];
  if (type === 'series' && (!Number.isInteger(season) || season < 1 ||
      !Number.isInteger(episode) || episode < 1)) return [];
  const titles = titlesFromMeta(meta);
  if (!titles.length) return [];
  const year = type === 'movie' ? movieYear(meta) : '';
  const query = type === 'series'
    ? `${titles[0]} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : `${titles[0]} ${year}`.trim();

  // Searches are guarded by the shared client's cache and 429 cooldown.
  const candidates = (await api.search({ query, titles, type, year, season, episode }))
    .slice(0, MAX_STREAMS);
  const streams = new Array(candidates.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(MAX_RESOLVERS, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const index = cursor++;
      const candidate = candidates[index];
      try {
        // The original /download endpoint responds with Location. Never
        // follow it or load video bytes on this server.
        const [videoUrl, details] = await Promise.all([
          api.resolveOriginal(candidate), api.getVideoDetails(candidate)
        ]);
        if (videoUrl) streams[index] = toStream(candidate, videoUrl, details);
      } catch (error) {
        console.warn('[hellspy] metadata/redirect unavailable: ' + error.message);
      }
    }
  }));
  return streams.filter(Boolean);
}

module.exports = { findHellspyStreams, hellspySubtitles, subtitleLanguage, safeFilename };
