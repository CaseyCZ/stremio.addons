const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const bencode = require('bncode');
const crypto = require('crypto');

const BASE_URL = 'https://sktorrent.eu';
const LOGIN_URL = `${BASE_URL}/torrent/login.php`;
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;
const INDEX_URL = `${BASE_URL}/torrent/index.php`;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';

const searchCache = new NodeCache({ stdTTL: 10 * 60, checkperiod: 60, maxKeys: 1200 });
const torrentCache = new NodeCache({ stdTTL: 24 * 60 * 60, checkperiod: 10 * 60, maxKeys: 3000 });
const clients = new Map();

function parseSetCookies(values) {
  const out = {};
  for (const raw of Array.isArray(values) ? values : values ? [values] : []) {
    const pair = String(raw).split(';', 1)[0];
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    out[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return out;
}

function normalize(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleMatchScore(candidate, wantedTitles) {
  const source = normalize(candidate);
  if (!source) return 0;
  let best = 0;
  for (const wanted of wantedTitles) {
    const target = normalize(wanted);
    if (!target) continue;
    if (source === target) best = Math.max(best, 1);
    else if (source.includes(target)) best = Math.max(best, 0.95);
    else {
      const words = target.split(' ').filter(word => word.length > 1);
      if (!words.length) continue;
      const common = words.filter(word => source.includes(word)).length;
      best = Math.max(best, common / words.length);
    }
  }
  return best;
}

function humanBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size >= 10 || i === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[i]}`;
}

function qualityFromText(value) {
  const text = String(value || '');
  if (/\b(2160p|4k|uhd)\b/i.test(text)) return '2160p';
  if (/\b1080p\b/i.test(text)) return '1080p';
  if (/\b720p\b/i.test(text)) return '720p';
  if (/\b480p\b/i.test(text)) return '480p';
  return 'Torrent';
}

function codecTags(value) {
  const text = String(value || '');
  const tags = [];
  if (/\b(hevc|h\.?265|x265)\b/i.test(text)) tags.push('HEVC');
  else if (/\b(h\.?264|x264|avc)\b/i.test(text)) tags.push('H264');
  if (/\b(dolby[ ._-]?vision|dv)\b/i.test(text)) tags.push('DV');
  else if (/\bhdr10\+?\b|\bhdr\b/i.test(text)) tags.push('HDR');
  return tags;
}

class SktorrentClient {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.cookies = null;
    this.loginPromise = null;
    this.http = axios.create({
      timeout: 12000,
      maxContentLength: 8 * 1024 * 1024,
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,*/*' }
    });
  }

  cookieHeader() {
    if (!this.cookies) return '';
    return `uid=${this.cookies.uid}; pass=${this.cookies.pass}`;
  }

  async login(force = false) {
    if (this.cookies && !force) return true;
    if (this.loginPromise) return this.loginPromise;

    this.loginPromise = (async () => {
      try {
        const loginPage = await this.http.get(LOGIN_URL, { maxRedirects: 3 });
        const $ = cheerio.load(loginPage.data);
        const action = $('form[action^="login.php?returnto=index.php"]').first().attr('action') || 'login.php?returnto=index.php';
        const target = new URL(action, LOGIN_URL).toString();
        const body = new URLSearchParams({ uid: this.username, pwd: this.password }).toString();
        const response = await this.http.post(target, body, {
          maxRedirects: 0,
          validateStatus: status => status >= 200 && status < 400,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: LOGIN_URL,
            Origin: BASE_URL
          }
        });
        const parsed = parseSetCookies(response.headers['set-cookie']);
        if (!parsed.uid || !parsed.pass) throw new Error('SKTorrent nevrátil přihlašovací cookies uid/pass.');
        this.cookies = { uid: parsed.uid, pass: parsed.pass };
        if (!await this.isAuthenticated()) {
          this.cookies = null;
          throw new Error('SKTorrent odmítl uživatelské jméno nebo heslo.');
        }
        return true;
      } catch (error) {
        this.cookies = null;
        throw error;
      } finally {
        this.loginPromise = null;
      }
    })();

    return this.loginPromise;
  }

  async isAuthenticated() {
    if (!this.cookies) return false;
    try {
      const response = await this.http.get(INDEX_URL, {
        headers: { Cookie: this.cookieHeader(), Referer: BASE_URL },
        maxRedirects: 2
      });
      const $ = cheerio.load(response.data);
      return $('a[href^="usercp.php"]').length > 0;
    } catch (_) {
      return false;
    }
  }

  async authenticatedGet(url, options = {}) {
    await this.login(false);
    const request = () => this.http.get(url, {
      ...options,
      headers: { ...(options.headers || {}), Cookie: this.cookieHeader(), Referer: BASE_URL }
    });

    let response = await request();
    if (options.responseType === 'arraybuffer') {
      const prefix = Buffer.from(response.data).subarray(0, 200).toString('utf8').toLowerCase();
      if (!prefix.includes('<html') && !prefix.includes('<!doctype')) return response;
    } else {
      const $ = cheerio.load(response.data);
      if ($('a[href^="usercp.php"]').length || !String(response.request?.res?.responseUrl || '').includes('login.php')) return response;
    }

    await this.login(true);
    response = await request();
    return response;
  }
}

function getClient(username, password) {
  const key = crypto.createHash('sha256').update(`${username}\0${password}`).digest('hex');
  let client = clients.get(key);
  if (!client) {
    client = new SktorrentClient(username, password);
    clients.set(key, client);
    if (clients.size > 100) clients.delete(clients.keys().next().value);
  }
  return client;
}

async function searchTorrents(query, wantedTitles, maxPages = 1) {
  const cacheKey = `${query.toLowerCase()}:${maxPages}`;
  const cached = searchCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const results = [];
  const seen = new Set();
  for (let page = 0; page < maxPages; page++) {
    try {
      const response = await axios.get(SEARCH_URL, {
        timeout: 10000,
        maxContentLength: 5 * 1024 * 1024,
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
        params: { search: query, category: 0, active: 0, order: 'data', by: 'DESC', page }
      });
      const $ = cheerio.load(response.data);
      let found = 0;
      $('a[href^="details.php"] img').each((_, img) => {
        const link = $(img).closest('a');
        const cell = link.closest('td');
        const href = String(link.attr('href') || '');
        const idMatch = href.match(/[?&]id=([^&]+)/i);
        const id = idMatch ? idMatch[1] : href.split('id=').pop();
        if (!id || seen.has(id)) return;
        const name = String(link.attr('title') || link.text() || '').trim();
        if (!name || titleMatchScore(name, wantedTitles) < 0.55) return;
        const text = cell.text().replace(/\s+/g, ' ').trim();
        const category = cell.find('b').first().text().trim();
        if (category && !/(film|seri|dokum|tv)/i.test(category)) return;
        const sizeMatch = text.match(/Velkost\s*([^|]+)/i);
        const seedMatch = text.match(/Odosielaju\s*:\s*(\d+)/i);
        seen.add(id);
        results.push({
          id,
          name,
          category,
          size: sizeMatch ? sizeMatch[1].trim() : '?',
          seeds: seedMatch ? Number(seedMatch[1]) : 0,
          downloadUrl: `${BASE_URL}/torrent/download.php?id=${encodeURIComponent(id)}`
        });
        found++;
      });
      if (found < 10) break;
    } catch (error) {
      console.warn(`[sktorrent] search "${query}" page ${page}: ${error.message}`);
      break;
    }
  }

  results.sort((a, b) => b.seeds - a.seeds);
  searchCache.set(cacheKey, results);
  return results;
}

function stringValue(value) {
  if (Buffer.isBuffer(value)) return value.toString();
  if (value == null) return '';
  return String(value);
}

function parseTorrent(buffer) {
  const torrent = bencode.decode(buffer);
  if (!torrent || !torrent.info) throw new Error('Neplatný .torrent soubor.');
  const infoHash = crypto.createHash('sha1').update(bencode.encode(torrent.info)).digest('hex');
  const trackers = [];
  const addTracker = value => {
    const tracker = stringValue(value).trim();
    if (/^https?:\/\//i.test(tracker)) trackers.push(tracker);
  };
  addTracker(torrent.announce);
  if (Array.isArray(torrent['announce-list'])) torrent['announce-list'].flat(Infinity).forEach(addTracker);

  let files;
  if (Array.isArray(torrent.info.files)) {
    files = torrent.info.files.map((file, index) => ({
      index,
      path: (file['path.utf-8'] || file.path || []).map(stringValue).join('/'),
      length: Number(file.length || 0)
    }));
  } else {
    files = [{
      index: 0,
      path: stringValue(torrent.info['name.utf-8'] || torrent.info.name),
      length: Number(torrent.info.length || 0)
    }];
  }
  return { infoHash, trackers: [...new Set(trackers)], files };
}

async function downloadTorrentData(client, candidate) {
  const cached = torrentCache.get(candidate.downloadUrl);
  if (cached !== undefined) return cached || null;
  try {
    let response = await client.authenticatedGet(candidate.downloadUrl, { responseType: 'arraybuffer', maxContentLength: 4 * 1024 * 1024 });
    let buffer = Buffer.from(response.data);
    let prefix = buffer.subarray(0, 200).toString('utf8').toLowerCase();
    if (prefix.includes('<html') || prefix.includes('<!doctype')) {
      await client.login(true);
      response = await client.authenticatedGet(candidate.downloadUrl, { responseType: 'arraybuffer', maxContentLength: 4 * 1024 * 1024 });
      buffer = Buffer.from(response.data);
      prefix = buffer.subarray(0, 200).toString('utf8').toLowerCase();
      if (prefix.includes('<html') || prefix.includes('<!doctype')) throw new Error('SKTorrent vrátil HTML místo .torrent souboru.');
    }
    const parsed = parseTorrent(buffer);
    torrentCache.set(candidate.downloadUrl, parsed);
    return parsed;
  } catch (error) {
    console.warn(`[sktorrent] torrent ${candidate.id}: ${error.message}`);
    return null;
  }
}

const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|mov|ts|webm)$/i;
function chooseVideoFile(files, type, season, episode) {
  const videos = (files || []).filter(file => VIDEO_EXT.test(file.path));
  if (!videos.length) return null;
  if (type === 'series' && Number.isInteger(season) && Number.isInteger(episode)) {
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    const patterns = [
      new RegExp(`(?:^|[^a-z0-9])s0?${season}[^a-z0-9]*e0?${episode}(?:[^0-9]|$)`, 'i'),
      new RegExp(`(?:^|[^0-9])0?${season}x0?${episode}(?:[^0-9]|$)`, 'i'),
      new RegExp(`(?:^|[^a-z0-9])${s}${e}(?:[^0-9]|$)`, 'i')
    ];
    const matched = videos.filter(file => patterns.some(pattern => pattern.test(file.path)));
    if (matched.length) return matched.sort((a, b) => b.length - a.length)[0];
    return null;
  }
  return videos.sort((a, b) => b.length - a.length)[0];
}

function queryVariants(titles, type, season, episode) {
  const out = [];
  for (const title of titles) {
    const base = String(title || '').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (!base) continue;
    if (type === 'series' && Number.isInteger(season) && Number.isInteger(episode)) {
      out.push(`${base} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`);
      out.push(`${base} ${season}x${String(episode).padStart(2, '0')}`);
      out.push(base);
    } else {
      out.push(base);
    }
  }
  return [...new Set(out)].slice(0, 5);
}

async function findTorrentStreams({ username, password, titles, type, season, episode, limit = 8 }) {
  const client = getClient(username, password);
  const queries = queryVariants(titles, type, season, episode);
  const found = new Map();
  for (const query of queries) {
    const results = await searchTorrents(query, titles, 1);
    for (const item of results) if (!found.has(item.id)) found.set(item.id, item);
    if (found.size >= limit * 2) break;
  }
  const candidates = [...found.values()].sort((a, b) => b.seeds - a.seeds).slice(0, limit * 2);
  const resolved = await Promise.all(candidates.map(async candidate => {
    const torrent = await downloadTorrentData(client, candidate);
    if (!torrent) return null;
    const file = chooseVideoFile(torrent.files, type, season, episode);
    if (!file) return null;
    const quality = qualityFromText(`${candidate.name} ${file.path}`);
    const tags = codecTags(`${candidate.name} ${file.path}`);
    const size = candidate.size !== '?' ? candidate.size : humanBytes(file.length);
    const detail = [size, `${candidate.seeds} seed`, ...tags].filter(Boolean).join(' • ');
    return {
      name: `SKTorrent • ${quality}`,
      title: `${candidate.name}\n${detail}`,
      infoHash: torrent.infoHash,
      fileIdx: file.index,
      sources: torrent.trackers.map(tracker => `tracker:${tracker}`),
      behaviorHints: { bingeGroup: `caseycz-skt:${torrent.infoHash}` }
    };
  }));
  return resolved.filter(Boolean).slice(0, limit);
}

module.exports = {
  getClient,
  findTorrentStreams,
  activeClientCount: () => clients.size
};
