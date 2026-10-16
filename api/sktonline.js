const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');

const BASE_URL = 'https://online.sktorrent.eu';
const cache = new NodeCache({ stdTTL: 5 * 60, checkperiod: 60, maxKeys: 1000 });
const http = axios.create({
  baseURL: BASE_URL,
  timeout: 10000,
  maxContentLength: 5 * 1024 * 1024,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36',
    'Accept-Encoding': 'identity',
    Accept: 'text/html,application/xhtml+xml'
  }
});

function dedupe(values) { return [...new Set(values.filter(Boolean))]; }
function stripDiacritics(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function shortTitle(value, words = 3) { return String(value || '').split(/\s+/).filter(Boolean).slice(0, words).join(' '); }

function buildQueries(titles, type, season, episode) {
  const queries = [];
  for (const raw of titles) {
    const base = String(raw || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (!base) continue;
    const variants = dedupe([base, stripDiacritics(base), shortTitle(stripDiacritics(base), 3), shortTitle(stripDiacritics(base), 1)]);
    if (type === 'series' && Number.isInteger(season) && Number.isInteger(episode)) {
      const sxxexx = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
      const x = `${season}x${String(episode).padStart(2, '0')}`;
      for (const variant of variants) queries.push(`${variant} ${sxxexx}`, `${variant} ${x}`);
    } else {
      queries.push(...variants.slice(0, 3));
    }
  }
  return dedupe(queries).slice(0, 8);
}

function languageFlags(text) {
  const flags = [];
  const pairs = [['CZ', '🇨🇿'], ['SK', '🇸🇰'], ['EN', '🇬🇧'], ['PL', '🇵🇱'], ['DE', '🇩🇪'], ['HU', '🇭🇺']];
  for (const [code, icon] of pairs) if (new RegExp(`\\b${code}\\b`, 'i').test(text)) flags.push(icon);
  return flags.join(' ');
}

function qualityLabel(label, src) {
  const text = `${label || ''} ${src || ''}`;
  const match = text.match(/\b(2160|1440|1080|720|480|360)p\b/i);
  if (match) return `${match[1]}p`;
  if (/\b4k\b/i.test(text)) return '2160p';
  if (/\bhd\b/i.test(text)) return '720p';
  return String(label || 'Direct').trim();
}

async function searchVideoIds(query) {
  const key = `search:${query.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const response = await http.get('/search/videos', { params: { search_query: query } });
    const $ = cheerio.load(response.data);
    const ids = [];
    $("a[href^='/video/']").each((_, el) => {
      const match = String($(el).attr('href') || '').match(/\/video\/(\d+)/);
      if (match) ids.push(match[1]);
    });
    const result = dedupe(ids).slice(0, 10);
    cache.set(key, result);
    return result;
  } catch (error) {
    console.warn(`[sktonline] search "${query}": ${error.message}`);
    return [];
  }
}

async function streamsForVideo(videoId) {
  const key = `video:${videoId}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const response = await http.get(`/video/${encodeURIComponent(videoId)}`);
    const $ = cheerio.load(response.data);
    const pageTitle = $('title').text().replace(/\s+/g, ' ').trim();
    const flags = languageFlags(pageTitle);
    const streams = [];
    $('video source').each((_, el) => {
      const raw = String($(el).attr('src') || '').trim();
      if (!raw) return;
      let url;
      try { url = new URL(raw, BASE_URL).toString(); } catch (_) { return; }
      if (!/\.mp4(?:$|[?#])/i.test(url)) return;
      const quality = qualityLabel($(el).attr('label'), url);
      streams.push({
        name: `SKTOnline • ${quality}`,
        title: `${pageTitle || 'SKTOnline'}${flags ? `\n${flags}` : ''}`,
        url,
        behaviorHints: { notWebReady: false }
      });
    });
    const seen = new Set();
    const result = streams.filter(item => !seen.has(item.url) && seen.add(item.url));
    cache.set(key, result);
    return result;
  } catch (error) {
    console.warn(`[sktonline] video ${videoId}: ${error.message}`);
    return [];
  }
}

async function findOnlineStreams({ titles, type, season, episode }) {
  const queries = buildQueries(titles, type, season, episode);
  for (const query of queries) {
    const ids = await searchVideoIds(query);
    if (!ids.length) continue;
    const batches = await Promise.all(ids.slice(0, 5).map(streamsForVideo));
    const all = batches.flat();
    if (all.length) {
      const seen = new Set();
      return all.filter(item => !seen.has(item.url) && seen.add(item.url)).slice(0, 15);
    }
  }
  return [];
}

module.exports = { findOnlineStreams };
