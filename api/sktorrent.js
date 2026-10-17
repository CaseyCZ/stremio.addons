const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const bencode = require('bncode');
const crypto = require('crypto');
const { getCsfdUrl } = require('./csfd');

const BASE_URL = 'https://sktorrent.eu';
const LOGIN_URL = `${BASE_URL}/torrent/login.php`;
const SEARCH_URL = `${BASE_URL}/torrent/torrents_v2.php`;
const INDEX_URL = `${BASE_URL}/torrent/index.php`;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';

const searchCache = new NodeCache({ stdTTL: 10 * 60, checkperiod: 60, maxKeys: 1600 });
const torrentCache = new NodeCache({ stdTTL: 24 * 60 * 60, checkperiod: 10 * 60, maxKeys: 4000 });
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
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function yearsInText(value) {
  return [...new Set(String(value || '').match(/\b(?:19|20)\d{2}\b/g) || [])];
}

function candidateYearMatches(candidate, wantedTitles) {
  const wantedYears = [...new Set((wantedTitles || []).flatMap(yearsInText))];
  if (!wantedYears.length) return true;
  const candidateYears = yearsInText(candidate);
  // SKTorrent release names often omit the year entirely. Missing year is
  // not a mismatch; only an explicit conflicting year should reject it.
  if (!candidateYears.length) return true;
  return candidateYears.some(year => wantedYears.includes(year));
}

function candidateHasConflictingYears(candidate, wantedTitles) {
  const wantedYears = [...new Set((wantedTitles || []).flatMap(yearsInText))];
  if (wantedYears.length !== 1) return false;
  const candidateYears = yearsInText(candidate);
  return candidateYears.some(year => year !== wantedYears[0]);
}

function titleMatchScore(candidate, wantedTitles) {
  const source = normalize(candidate);
  if (!source) return 0;
  let best = 0;
  for (const wanted of wantedTitles || []) {
    const target = normalize(wanted);
    if (!target) continue;
    if (source === target) best = Math.max(best, 1);
    else if (source.includes(target)) best = Math.max(best, 0.98);
    else if (target.includes(source) && source.length >= 4) best = Math.max(best, 0.85);
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
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i += 1; }
  return `${size >= 10 || i === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[i]}`;
}

function qualityFromText(value) {
  const text = String(value || '');
  if (/\b(2160p|4k|uhd)\b/i.test(text)) return '2160p';
  if (/\b1080p\b/i.test(text)) return '1080p';
  if (/\b720p\b/i.test(text)) return '720p';
  if (/\b480p\b/i.test(text)) return '480p';
  if (/\b360p\b/i.test(text)) return '360p';
  return 'Torrent';
}

function codecTags(value) {
  const text = String(value || '');
  const tags = [];
  if (/\b(hevc|h\.?265|x265)\b/i.test(text)) tags.push('HEVC');
  else if (/\b(h\.?264|x264|avc)\b/i.test(text)) tags.push('H264');
  if (/\b(dolby[ ._-]?vision|dolbyvision|dv)\b/i.test(text)) tags.push('DV');
  else if (/\bhdr10\+?\b|\bhdr\b/i.test(text)) tags.push('HDR');
  return tags;
}

function languageLabel(value) {
  const text = String(value || '');
  const langs = [];
  if (/\b(CZ|CS|CZE|CES)\b/i.test(text)) langs.push('🇨🇿 CZ');
  if (/\b(SK|SLK|SLO)\b/i.test(text)) langs.push('🇸🇰 SK');
  if (/\b(EN|ENG)\b/i.test(text)) langs.push('🇬🇧 EN');
  if (/\b(PL|POL)\b/i.test(text)) langs.push('🇵🇱 PL');
  if (/\b(DE|GER|DEU)\b/i.test(text)) langs.push('🇩🇪 DE');
  if (/\b(HU|HUN)\b/i.test(text)) langs.push('🇭🇺 HU');
  return [...new Set(langs)].join(' • ');
}

class SktorrentClient {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.clientKey = crypto.createHash('sha256').update(`${username}\0${password}`).digest('hex');
    this.cookies = null;
    this.loginPromise = null;
    this.http = axios.create({
      timeout: 12000,
      maxContentLength: 8 * 1024 * 1024,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Encoding': 'identity',
        Accept: 'text/html,application/xhtml+xml,*/*'
      }
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
      headers: {
        ...(options.headers || {}),
        Cookie: this.cookieHeader(),
        Referer: BASE_URL
      }
    });

    let response = await request();
    if (options.responseType === 'arraybuffer') {
      const prefix = Buffer.from(response.data).subarray(0, 200).toString('utf8').toLowerCase();
      if (!prefix.includes('<html') && !prefix.includes('<!doctype')) return response;
    } else {
      const $ = cheerio.load(response.data);
      const finalUrl = String(response.request?.res?.responseUrl || '');
      if ($('a[href^="usercp.php"]').length || !finalUrl.includes('login.php')) return response;
    }

    await this.login(true);
    return request();
  }
}

function getClient(username, password) {
  const user = String(username || '').trim();
  const pass = String(password || '');
  if (!user || !pass) throw new Error('Chybí SKTorrent uživatelské jméno nebo heslo.');
  const key = crypto.createHash('sha256').update(`${user}\0${pass}`).digest('hex');
  let client = clients.get(key);
  if (!client) {
    client = new SktorrentClient(user, pass);
    clients.set(key, client);
    if (clients.size > 100) clients.delete(clients.keys().next().value);
  }
  return client;
}

async function searchTorrents(query, wantedTitles, maxPages = 1, trustedReference = false) {
  const wantedKey = (wantedTitles || []).map(normalize).sort().join('|');
  const cacheKey = `${normalize(query)}:${maxPages}:${trustedReference ? 'trusted' : 'normal'}:${wantedKey}`;
  const cached = searchCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const results = [];
  const seen = new Set();
  for (let page = 0; page < maxPages; page += 1) {
    try {
      const response = await axios.get(SEARCH_URL, {
        timeout: 10000,
        maxContentLength: 5 * 1024 * 1024,
        headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity', Accept: 'text/html' },
        params: { search: query, category: 0, active: 0, order: 'data', by: 'DESC', page }
      });
      const $ = cheerio.load(response.data);
      let found = 0;

      $('a[href^="details.php"] img, a[href*="details.php"] img').each((_, img) => {
        const link = $(img).closest('a');
        const cell = link.closest('td');
        const href = String(link.attr('href') || '');
        const idMatch = href.match(/[?&]id=([^&]+)/i);
        const id = idMatch ? idMatch[1] : href.split('id=').pop();
        if (!id || seen.has(id)) return;

        const name = String(link.attr('title') || link.find('img').attr('alt') || link.text() || '').replace(/\s+/g, ' ').trim();
        const score = titleMatchScore(name, wantedTitles);
        if (!name || candidateHasConflictingYears(name, wantedTitles)) return;
        if (!trustedReference && (!candidateYearMatches(name, wantedTitles) || score < 0.55)) return;

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
          score,
          downloadUrl: `${BASE_URL}/torrent/download.php?id=${encodeURIComponent(id)}`
        });
        found += 1;
      });

      if (found < 10) break;
    } catch (error) {
      console.warn(`[sktorrent] search "${query}" page ${page}: ${error.message}`);
      break;
    }
  }

  results.sort((a, b) => (b.score - a.score) || (b.seeds - a.seeds));
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
    if (/^(?:https?|udp|wss?):\/\//i.test(tracker)) trackers.push(tracker);
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

  return {
    infoHash,
    trackers: [...new Set(trackers)],
    files,
    private: Number(torrent.info.private || 0) === 1
  };
}

async function downloadTorrentData(client, candidate) {
  const cacheKey = `${client.clientKey}:${candidate.downloadUrl}`;
  const cached = torrentCache.get(cacheKey);
  if (cached !== undefined) return cached || null;

  try {
    let response = await client.authenticatedGet(candidate.downloadUrl, {
      responseType: 'arraybuffer',
      maxContentLength: 4 * 1024 * 1024
    });
    let buffer = Buffer.from(response.data);
    let prefix = buffer.subarray(0, 200).toString('utf8').toLowerCase();

    if (prefix.includes('<html') || prefix.includes('<!doctype')) {
      await client.login(true);
      response = await client.authenticatedGet(candidate.downloadUrl, {
        responseType: 'arraybuffer',
        maxContentLength: 4 * 1024 * 1024
      });
      buffer = Buffer.from(response.data);
      prefix = buffer.subarray(0, 200).toString('utf8').toLowerCase();
      if (prefix.includes('<html') || prefix.includes('<!doctype')) throw new Error('SKTorrent vrátil HTML místo .torrent souboru.');
    }

    const parsed = parseTorrent(buffer);
    torrentCache.set(cacheKey, parsed);
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

function searchTextVariants(value) {
  const base = String(value || '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/TV (Mini )?Series/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return [];
  const noDia = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const noPunct = noDia.replace(/[\':]/g, '').replace(/\s+/g, ' ').trim();
  const withoutYear = noPunct.replace(/\b(?:19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim();
  const short = withoutYear.split(/\s+/).slice(0, 3).join(' ');
  const dotted = withoutYear.replace(/\s+/g, '.');
  return [...new Set([base, noDia, noPunct, withoutYear, short, dotted].filter(value => value && value.length >= 2))];
}

function queryVariants(titles, type, season, episode) {
  const out = [];
  for (const title of titles || []) {
    const variants = searchTextVariants(title);
    for (const variant of variants) {
      if (type === 'series' && Number.isInteger(season) && Number.isInteger(episode)) {
        const s = String(season).padStart(2, '0');
        const e = String(episode).padStart(2, '0');
        out.push(`${variant} S${s}E${e}`);
        out.push(`${variant} ${season}x${e}`);
        out.push(`${variant} S${s}`);
        out.push(`${variant} ${season}. série`);
        out.push(variant);
      } else {
        out.push(variant);
      }
    }
  }
  return [...new Set(out)].slice(0, 16);
}

async function findTorrentStreams({ username, password, imdbId, titles, type, season, episode, limit = 8 }) {
  const client = getClient(username, password);
  const queries = queryVariants(titles, type, season, episode);
  const csfdUrl = await getCsfdUrl(imdbId);
  const found = new Map();

  // Exact CSFD reference is the highest-confidence path. One page is normally
  // enough and avoids spending most of the Stremio timeout walking pagination.
  if (csfdUrl) {
    const exact = await searchTorrents(csfdUrl, titles, 1, true);
    for (const item of exact) if (!found.has(item.id)) found.set(item.id, item);
  }

  // Fill any remaining slots from broader text variants in small parallel batches.
  for (let offset = 0; offset < queries.length && found.size < limit * 2; offset += 4) {
    const batch = queries.slice(offset, offset + 4);
    const batches = await Promise.all(batch.map(query => searchTorrents(query, titles, 1, false)));
    for (const results of batches) {
      for (const item of results) if (!found.has(item.id)) found.set(item.id, item);
    }
  }

  const candidates = [...found.values()]
    .sort((a, b) => (b.score - a.score) || (b.seeds - a.seeds))
    .slice(0, Math.min(limit * 2, 12));

  const resolved = await Promise.all(candidates.map(async candidate => {
    const torrent = await downloadTorrentData(client, candidate);
    if (!torrent) return null;
    const file = chooseVideoFile(torrent.files, type, season, episode);
    if (!file) return null;

    const combined = `${candidate.name} ${file.path}`;
    const quality = qualityFromText(combined);
    const tags = codecTags(combined);
    const language = languageLabel(combined);
    const size = candidate.size !== '?' ? candidate.size : humanBytes(file.length);
    const details = [`👥 ${candidate.seeds} seed`, `📦 ${size}`, ...tags].filter(Boolean).join(' • ');
    const titleLines = [
      language ? `🎧 ${language}` : null,
      `🗂️ ${candidate.name}`,
      details
    ].filter(Boolean);

    return {
      name: `SKTorrent • ${quality}`,
      title: titleLines.join('\n'),
      infoHash: torrent.infoHash,
      fileIdx: file.index,
      fileName: String(file.path || '').split('/').pop(),
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
