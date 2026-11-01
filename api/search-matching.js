'use strict';

// Shared, dependency-free matching helpers for the individual providers.
// Matching complete words prevents short titles (Ted, It, Up) and sequels from
// inheriting a high score merely because their names are substrings.
function normalizeTitle(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&amp;/g, ' and ').replace(/[^a-z0-9]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
}

const RELEASE_WORDS = new Set([
  '4k', 'uhd', 'fhd', 'hd', 'sd', 'web', 'dl', 'webdl', 'webrip', 'webcap',
  'bluray', 'blu', 'ray', 'bdrip', 'brrip', 'remux', 'rip', 'dvdrip', 'dvd',
  'hdtv', 'hdrip', 'hdr', 'hdr10', 'hdr10plus', 'dv', 'dovi', 'sdr',
  'hevc', 'avc', 'av1', 'x264', 'x265', 'h264', 'h265', 'xvid', 'divx',
  'mp4', 'mkv', 'avi', 'aac', 'ac3', 'eac3', 'dd', 'ddp', 'dts', 'truehd',
  'atmos', 'flac', 'mp3', 'cz', 'cs', 'cze', 'ces', 'sk', 'slk', 'slo',
  'en', 'eng', 'czech', 'slovak', 'english', 'cesky', 'slovensky',
  'dab', 'dabing', 'dub', 'dubbed', 'sub', 'subs', 'subtitles',
  'titulky', 'tit', 'cztit', 'cztitulky', 'czdab', 'czdabing',
  'sktit', 'sktitulky', 'skdab', 'skdabing', 'srt', 'vtt',
  'dual', 'multi', 'audio', 'original',
  'extended', 'uncut', 'proper', 'repack', 'internal', 'remastered',
  'imax', 'theatrical', 'directors', 'director', 'cut', 'complete',
  'komplet', 'serie', 'series', 'season', 'episode', 'epizoda', 'dil'
]);

function releaseWord(word) {
  return RELEASE_WORDS.has(word) || /^(?:(?:19|20)\d{2}|\d{3,4}p|\d{1,2}bit|s\d{1,2}(?:e\d{1,3})?|e\d{1,3}|\d{1,2}x\d{1,3})$/.test(word);
}

function titleMatchScore(candidate, wantedTitles) {
  const raw = String(candidate || '');
  const sourceWords = normalizeTitle(raw).split(' ').filter(Boolean);
  if (!sourceWords.length) return 0;
  const hasReleaseMarker = sourceWords.some(word => /^(?:\d{3,4}p|4k|uhd|webdl|webrip|bluray|bdrip|remux|x264|x265|h264|h265|s\d{1,2}e\d{1,3})$/.test(word));
  // A release-group suffix is not part of the film title. Remove it only if
  // a real encode/quality marker appears in the filename beforehand.
  const trailingGroup = hasReleaseMarker && /[-–—][a-z][a-z0-9]{1,20}\s*$/i.test(raw);
  const effectiveWords = trailingGroup ? sourceWords.slice(0, -1) : sourceWords;
  let best = 0;
  for (const wanted of wantedTitles || []) {
    const targetWords = normalizeTitle(wanted).split(' ').filter(Boolean);
    if (!targetWords.length || targetWords.length > effectiveWords.length) continue;
    for (let at = 0; at <= effectiveWords.length - targetWords.length; at++) {
      if (!targetWords.every((word, i) => effectiveWords[at + i] === word)) continue;
      const before = effectiveWords.slice(0, at);
      const after = effectiveWords.slice(at + targetWords.length);
      if (!before.every(releaseWord)) continue;
      if (after.every(releaseWord)) {
        best = Math.max(best, before.length || after.length ? 0.98 : 1);
      } else if (hasReleaseMarker && after.length >= 3 &&
          after.slice(0, -1).every(releaseWord) && !releaseWord(after[after.length - 1])) {
        // Some uploads append a single uploader name after the release tags.
        // Keep these as weaker candidates; arbitrary sequel words before a
        // genuine release marker never reach this fallback.
        best = Math.max(best, 0.75);
      }
    }
  }
  return best;
}

function episodeTokens(text) {
  const source = String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const tokens = [];
  const patterns = [
    /(?:^|[^a-z0-9])s0*(\d{1,2})[\s._-]*e0*(\d{1,3})(?=$|[^a-z0-9])/g,
    /(?:^|[^a-z0-9])0*(\d{1,2})\s*[x×]\s*0*(\d{1,3})(?=$|[^a-z0-9])/g,
    /(?:^|[^a-z0-9])(?:serie|series|season|rada)\s*0*(\d{1,2})\s*[-–—:., ]+\s*(?:epizoda|episode|ep|dil)\s*0*(\d{1,3})(?=$|[^a-z0-9])/g,
    /(?:^|[^a-z0-9])0*(\d{1,2})\s*\.?\s*(?:serie|series|season|rada)\s*[-–—:., ]+\s*0*(\d{1,3})\s*\.?\s*(?:epizoda|episode|ep|dil)(?=$|[^a-z0-9])/g
  ];
  for (const re of patterns) {
    for (const match of source.matchAll(re)) {
      const offset = match[0].length - match[0].trimStart().length;
      tokens.push({ season: Number(match[1]), episode: Number(match[2]), pos: match.index + offset, end: match.index + match[0].length });
    }
  }
  return tokens.sort((a, b) => a.pos - b.pos);
}

module.exports = { normalizeTitle, titleMatchScore, episodeTokens };
