'use strict';

// Shared between the Cinemeta catalogue mapping and IMDb stream handler.
// Entries are only memorized if the URL is a valid page on the expected site.
const sourceByImdb = new Map();
const ID = /^tt\d{5,12}$/i;

function normalizeTitle(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'").replace(/&nbsp;/gi, ' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(?:19|20)\d{2}\s*$/g, '').trim();
}

function sourceUrl(type, item) {
  if (!['movie', 'series'].includes(type)) return null;
  try {
    const url = new URL(item?.detailUrl || '');
    if (url.protocol !== 'https:' || url.search || url.hash) return null;
    const host = type === 'movie' ? 'www.bombuj.si' : 'serialy.bombuj.si';
    const path = type === 'movie' ? /^\/online-film-[a-z0-9-]+\/?$/i
      : /^\/serial-[a-z0-9-]+\/?$/i;
    if (url.hostname.toLowerCase() !== host || !path.test(url.pathname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function rememberSource(type, imdbId, item) {
  const id = String(imdbId || '').toLowerCase();
  const detailUrl = sourceUrl(type, item);
  if (!ID.test(id) || !detailUrl) return false;
  const key = type + ':' + id;
  sourceByImdb.delete(key);
  sourceByImdb.set(key, { ...item, detailUrl });
  // Bound memory even when a server runs for months.
  if (sourceByImdb.size > 1500) sourceByImdb.delete(sourceByImdb.keys().next().value);
  return true;
}

function findSource(type, imdbId) {
  const id = String(imdbId || '').toLowerCase();
  return ID.test(id) ? sourceByImdb.get(type + ':' + id) || null : null;
}

function yearOf(value) {
  return Number(String(value || '').match(/\b(?:19|20)\d{2}\b/)?.[0] || 0);
}

function splitNames(value) {
  return String(value || '').split(/\s+[-–—]\s+/g)
    .map(name => normalizeTitle(name)).filter(name => name.length >= 4);
}

function detailTitles(html) {
  const titles = [];
  for (const match of String(html || '').matchAll(/<(?:h1|h2|title)\b[^>]*>([\s\S]*?)<\/(?:h1|h2|title)>/gi)) {
    titles.push(...splitNames(match[1]));
  }
  return titles;
}

// 2 = page's own IMDb ID, 1 = exact original/localized title with year
// within one year, 0 = unverified or conflicting identity.
function sourceIdentity(type, imdbId, meta, item, html, embeddedImdbId) {
  if (!sourceUrl(type, item) || !ID.test(imdbId || '')) return 0;
  const embedded = String(embeddedImdbId || '').toLowerCase();
  if (embedded && (!ID.test(embedded) || embedded !== imdbId.toLowerCase())) return 0;
  if (embedded === imdbId.toLowerCase()) return 2;

  const expected = [meta?.name, ...(Array.isArray(meta?.aliases) ? meta.aliases : [])]
    .flatMap(splitNames);
  const found = [
    ...[item?.title, ...(Array.isArray(item?.alternateTitles) ? item.alternateTitles : [])].flatMap(splitNames),
    ...detailTitles(html)
  ];
  if (!expected.some(name => found.includes(name))) return 0;

  const targetYear = yearOf(meta?.releaseInfo || meta?.year || meta?.released);
  const localYear = yearOf(item?.year) ||
    yearOf(String(html || '').match(/<(?:h2|h3)\b[^>]*>[^<]*\b(?:19|20)\d{2}\b[^<]*<\/(?:h2|h3)>/i)?.[0]);
  if (targetYear && localYear && Math.abs(targetYear - localYear) > 1) return 0;
  return 1;
}

module.exports = { normalizeTitle, rememberSource, findSource, sourceIdentity };
