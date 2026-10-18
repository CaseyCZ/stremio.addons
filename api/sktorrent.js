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
  else if (/\b(h\.?264|x264|avc)\b/i.test(text)) tags.push('H.264');
  if (/\b(dolby[ ._-]?vision|dolbyvision|dv)\b/i.test(text)) tags.push('DV');
  else if (/\bhdr10\+?\b|\bhdr\b/i.test(text)) tags.push('HDR');
  return tags;
}

const LANGUAGE_DISPLAY = {
  CZ: '🇨🇿 CZ',
  SK: '🇸🇰 SK',
  EN: '🇬🇧 EN',
  PL: '🇵🇱 PL',
  DE: '🇩🇪 DE',
  HU: '🇭🇺 HU',
  FR: '🇫🇷 FR',
  ES: '🇪🇸 ES',
  IT: '🇮🇹 IT',
  RU: '🇷🇺 RU',
  UA: '🇺🇦 UA'
};

function languageCodesFromText(value) {
  const text = String(value || '');
  const codes = [];
  if (/\b(CZ|CS|CZE|CES)\b/i.test(text)) codes.push('CZ');
  if (/\b(SK|SLK|SLO)\b/i.test(text)) codes.push('SK');
  if (/\b(EN|ENG)\b/i.test(text)) codes.push('EN');
  if (/\b(PL|POL)\b/i.test(text)) codes.push('PL');
  if (/\b(DE|GER|DEU)\b/i.test(text)) codes.push('DE');
  if (/\b(HU|HUN)\b/i.test(text)) codes.push('HU');
  if (/\b(FR|FRE|FRA)\b/i.test(text)) codes.push('FR');
  if (/\b(ES|SPA)\b/i.test(text)) codes.push('ES');
  if (/\b(IT|ITA)\b/i.test(text)) codes.push('IT');
  if (/\b(RU|RUS)\b/i.test(text)) codes.push('RU');
  if (/\b(UA|UKR)\b/i.test(text)) codes.push('UA');
  return [...new Set(codes)];
}

function formatLanguageCodes(codes) {
  return [...new Set((codes || []).filter(Boolean))]
    .map(code => LANGUAGE_DISPLAY[code] || `🌐 ${code}`)
    .join(' • ');
}

function languageLabel(value) {
  return formatLanguageCodes(languageCodesFromText(value));
}

function flagLanguageCode(src) {
  const match = String(src || '').match(/\/flag\/([a-z]{2,3})\.png(?:$|[?#])/i);
  if (!match) return null;
  return ({
    cz: 'CZ', cs: 'CZ', cze: 'CZ',
    sk: 'SK', slk: 'SK', slo: 'SK',
    gb: 'EN', en: 'EN', eng: 'EN', us: 'EN',
    pl: 'PL', pol: 'PL',
    de: 'DE', deu: 'DE', ger: 'DE',
    hu: 'HU', hun: 'HU',
    fr: 'FR', fra: 'FR', fre: 'FR',
    es: 'ES', spa: 'ES',
    it: 'IT', ita: 'IT',
    ru: 'RU', rus: 'RU',
    ua: 'UA', ukr: 'UA'
  })[match[1].toLowerCase()] || null;
}

function subtitleHintFromCategory(category) {
  const text = String(category || '');
  if (/bez\s+titulk/i.test(text)) return 'Bez titulků';
  if (/s\s+titulk/i.test(text)) return 'Titulky';
  return '';
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

    const isLoginResponse = response => {
      if (options.responseType === 'arraybuffer') {
        const prefix = Buffer.from(response.data).subarray(0, 200).toString('utf8').toLowerCase();
        return prefix.includes('<html') || prefix.includes('<!doctype');
      }
      const $ = cheerio.load(response.data);
      const finalUrl = String(response.request?.res?.responseUrl || '');
      const loggedIn = $('a[href^="usercp.php"]').length > 0;
      const loginForm = $('form[action*="login.php"]').length > 0;
      return !loggedIn && (loginForm || /\/login\.php(?:[?#]|$)/i.test(finalUrl));
    };

    let response = await request();
    if (!isLoginResponse(response)) return response;

    // A request may return the login form with HTTP 200 and NO redirect.
    // Refresh credentials once rather than caching an empty search result.
    await this.login(true);
    response = await request();
    if (isLoginResponse(response)) throw new Error('SKTorrent vyžaduje nové přihlášení.');
    return response;
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

async function searchTorrents(client, query, wantedTitles, maxPages = 1, trustedReference = false) {
  const wantedKey = (wantedTitles || []).map(normalize).sort().join('|');
  const cacheKey = `${client.clientKey}:${normalize(query)}:${maxPages}:${trustedReference ? 'trusted' : 'normal'}:${wantedKey}`;
  const cached = searchCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const results = [];
  const seen = new Set();
  let hadError = false;
  for (let page = 0; page < maxPages; page += 1) {
    try {
      const response = await client.authenticatedGet(SEARCH_URL, {
        timeout: 10000,
        maxContentLength: 5 * 1024 * 1024,
        headers: { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity', Accept: 'text/html' },
        params: { search: query, category: 0, active: 0, order: 'data', by: 'DESC', page }
      });
      const $ = cheerio.load(response.data);
      if ($('form[action*="login.php"]').length && !$('a[href^="usercp.php"]').length) {
        throw new Error('SKTorrent returned a login page instead of search results');
      }
      let found = 0;
      let rawCount = 0;

      $('a[href^="details.php"] img, a[href*="details.php"] img').each((_, img) => {
        rawCount += 1;
        const link = $(img).closest('a');
        const cell = link.closest('td');
        const href = String(link.attr('href') || '');
        const idMatch = href.match(/[?&]id=([^&]+)/i);
        const id = idMatch ? idMatch[1] : href.split('id=').pop();
        if (!id || seen.has(id)) return;

        // Image links often contain whitespace text nodes; the real release
        // name is stored in the title attribute. Trim BEFORE choosing it.
        const name = [link.attr('title'), link.text(), link.find('img').attr('alt')]
          .map(value => String(value || '').replace(/\s+/g, ' ').trim())
          .find(Boolean) || '';
        const score = titleMatchScore(name, wantedTitles);
        if (!name || candidateHasConflictingYears(name, wantedTitles)) return;
        if (!trustedReference && (!candidateYearMatches(name, wantedTitles) || score < 0.55)) return;

        const text = cell.text().replace(/\s+/g, ' ').trim();
        const category = cell.find('b').first().text().trim();
        if (category && !/(film|seri|dokum|tv)/i.test(category)) return;
        const flagLanguages = [...new Set(cell.find('img[src*="/flag/"]').map((_, flag) =>
          flagLanguageCode($(flag).attr('src'))
        ).get().filter(Boolean))];
        const sizeMatch = text.match(/Velkost\s*([^|]+)/i);
        const seedMatch = text.match(/Odosielaju\s*:\s*(\d+)/i);

        seen.add(id);
        results.push({
          id,
          name,
          category,
          flagLanguages,
          size: sizeMatch ? sizeMatch[1].trim() : '?',
          seeds: seedMatch ? Number(seedMatch[1]) : 0,
          score,
          downloadUrl: `${BASE_URL}/torrent/download.php?id=${encodeURIComponent(id)}`
        });
        found += 1;
      });

      if (rawCount < 10) break;
    } catch (error) {
      console.warn(`[sktorrent] search "${query}" page ${page}: ${error.message}`);
      hadError = true;
      break;
    }
  }

  results.sort((a, b) => (b.score - a.score) || (b.seeds - a.seeds));
  if (!hadError) searchCache.set(cacheKey, results, results.length ? 10 * 60 : 60);
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
const EXTRA_VIDEO_HINT = /(?:^|[ ._\-/])(sample|trailer|teaser|bonus|extras?|making[ ._-]*of|ukazka)(?:[ ._\-/]|$)/i;

function episodeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\\/g, '/');
}

function explicitEpisodePairs(value) {
  const text = episodeText(value);
  const pairs = [];
  const patterns = [
    /(?:^|[^a-z0-9])s(?:eason)?\s*0?(\d{1,2})\s*[ ._-]*e(?:p(?:isode)?)?\s*0?(\d{1,3})(?=[^0-9]|$)/gi,
    /(?:^|[^0-9])0?(\d{1,2})\s*x\s*0?(\d{1,3})(?=[^0-9]|$)/gi,
    /(?:season|serie|series|seria|sezona)\s*0?(\d{1,2})[^0-9]{0,14}(?:episode|epizoda|episoda|dil|cast|ep)\s*0?(\d{1,3})(?=[^0-9]|$)/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) pairs.push([Number(match[1]), Number(match[2])]);
  }
  return pairs;
}

function seasonMarkers(value) {
  const text = episodeText(value);
  const seasons = [];
  const patterns = [
    /(?:^|[^a-z0-9])s(?:eason)?\s*0?(\d{1,2})(?=[^0-9]|$)/gi,
    /(?:season|serie|series|seria|sezona)\s*0?(\d{1,2})(?=[^0-9]|$)/gi
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) seasons.push(Number(match[1]));
  }
  return [...new Set(seasons)];
}

function episodeMarkers(value) {
  const text = episodeText(value);
  const episodes = [];
  const pattern = /(?:^|[^a-z0-9])(?:e(?:p(?:isode)?)?|episode|epizoda|episoda|dil|cast)\s*0?(\d{1,3})(?=[^0-9]|$)/gi;
  for (const match of text.matchAll(pattern)) episodes.push(Number(match[1]));
  return [...new Set(episodes)];
}

function leadingEpisodeNumber(value) {
  const stem = episodeText(value).replace(/\.[a-z0-9]{2,5}$/i, '');
  const match = stem.match(/^\s*[\[(]?\s*0*(\d{1,3})\s*(?:[\])]|[ ._-]|$)/);
  return match ? Number(match[1]) : null;
}

function hasCompactEpisodeCode(value, season, episode) {
  const text = episodeText(value);
  const s = String(season).padStart(2, '0');
  const e = String(episode).padStart(2, '0');
  const codes = [...new Set([`${season}${e}`, `${s}${e}`])]
    .filter(code => !['2160', '1440', '1080', '720', '480', '360'].includes(code));
  return codes.some(code => new RegExp(`(?:^|[^0-9])${code}(?:[^0-9]|$)`).test(text));
}

function parentPath(filePath) {
  const parts = String(filePath || '').replace(/\\/g, '/').split('/');
  parts.pop();
  return parts.join('/');
}

function episodeFileScore(file, season, episode) {
  const fullPath = String(file.path || '');
  const normalized = episodeText(fullPath);
  const parts = normalized.split('/');
  const fileName = parts.pop() || '';
  const parent = parts.join('/');

  const pairs = explicitEpisodePairs(normalized);
  if (pairs.length) {
    return pairs.some(([s, e]) => s === season && e === episode) ? 140 : Number.NEGATIVE_INFINITY;
  }

  const parentSeasons = seasonMarkers(parent);
  if (parentSeasons.length && !parentSeasons.includes(season)) return Number.NEGATIVE_INFINITY;
  const seasonContext = parentSeasons.includes(season);
  let score = seasonContext ? 35 : 0;

  const markedEpisodes = episodeMarkers(fileName);
  if (markedEpisodes.length) {
    if (!markedEpisodes.includes(episode)) return Number.NEGATIVE_INFINITY;
    score += 90;
  }

  if (hasCompactEpisodeCode(fileName, season, episode)) score += 100;

  const leading = leadingEpisodeNumber(fileName);
  if (seasonContext && leading === episode) score += 75;

  if (EXTRA_VIDEO_HINT.test(normalized)) score -= 80;
  return score;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function chooseBySeasonStructure(videos, season, episode) {
  const groups = new Map();
  for (const file of videos) {
    const parent = parentPath(file.path);
    const seasons = seasonMarkers(parent);
    if (!seasons.includes(season) || EXTRA_VIDEO_HINT.test(episodeText(file.path))) continue;
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent).push(file);
  }

  const rankedGroups = [...groups.values()]
    .map(group => {
      const lengths = group.map(file => Number(file.length || 0)).filter(length => length > 0);
      const typical = median(lengths);
      const threshold = typical > 0 ? Math.max(50 * 1024 * 1024, typical * 0.35) : 0;
      const main = group
        .filter(file => !threshold || Number(file.length || 0) >= threshold)
        .sort((a, b) => a.index - b.index);
      return { main, typical };
    })
    .filter(group => group.main.length >= episode && group.main.length <= 40)
    .sort((a, b) => (b.main.length - a.main.length) || (b.typical - a.typical));

  if (!rankedGroups.length) return null;
  return rankedGroups[0].main[episode - 1] || null;
}

function chooseVideoFile(files, type, season, episode) {
  const videos = (files || []).filter(file => VIDEO_EXT.test(file.path));
  if (!videos.length) return null;

  if (type === 'series' && Number.isInteger(season) && Number.isInteger(episode)) {
    const scored = videos
      .map(file => ({ file, score: episodeFileScore(file, season, episode) }))
      .filter(item => Number.isFinite(item.score) && item.score >= 75)
      .sort((a, b) => (b.score - a.score) || (b.file.length - a.file.length));
    if (scored.length) return scored[0].file;

    // Last-resort structural inference for packs where filenames contain only
    // titles or simple numbering: identify the requested season folder, remove
    // obvious extras/samples and select the Nth main video in torrent order.
    return chooseBySeasonStructure(videos, season, episode);
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

function episodeReleasePriority(name, season, episode) {
  if (!Number.isInteger(season) || !Number.isInteger(episode)) return 0;
  const text = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const exactPatterns = [
    new RegExp(`(?:^|[^a-z0-9])s0?${season}[^a-z0-9]*e0?${episode}(?:[^0-9]|$)`, 'i'),
    new RegExp(`(?:^|[^0-9])0?${season}x0?${episode}(?:[^0-9]|$)`, 'i')
  ];
  if (exactPatterns.some(pattern => pattern.test(text))) return 0;

  const explicitEpisodes = [];
  for (const match of text.matchAll(/s0?(\d{1,2})[^a-z0-9]*e0?(\d{1,3})/gi)) {
    explicitEpisodes.push([Number(match[1]), Number(match[2])]);
  }
  for (const match of text.matchAll(/(?:^|[^0-9])0?(\d{1,2})x0?(\d{1,3})(?:[^0-9]|$)/gi)) {
    explicitEpisodes.push([Number(match[1]), Number(match[2])]);
  }
  if (explicitEpisodes.length) return 9;

  const ranges = [];
  const rangePatterns = [
    /s0?(\d{1,2})\s*[-–—]\s*s?0?(\d{1,2})/gi,
    /(?:^|[^0-9])(\d{1,2})\s*\.?\s*[-–—]\s*(\d{1,2})\s*\.?\s*(?:serie|series|season)/gi
  ];
  for (const pattern of rangePatterns) {
    for (const match of text.matchAll(pattern)) ranges.push([Number(match[1]), Number(match[2])]);
  }
  if (ranges.length) {
    for (const [a, b] of ranges) {
      const low = Math.min(a, b);
      const high = Math.max(a, b);
      if (low <= season && season <= high && low !== high) return 5;
    }
    return 9;
  }

  const seasonPatterns = [
    new RegExp(`(?:^|[^a-z0-9])s0?${season}(?:[^0-9]|$)`, 'i'),
    new RegExp(`(?:^|[^0-9])0?${season}\\s*\\.?\\s*(?:serie|series|season)(?:[^a-z]|$)`, 'i')
  ];
  if (seasonPatterns.some(pattern => pattern.test(text))) return 1;
  if (/\b(komplet|complete|all seasons?)\b/i.test(text)) return 6;
  return 2;
}

async function findTorrentStreams({ username, password, imdbId, titles, type, season, episode, limit = 8 }) {
  const client = getClient(username, password);
  const isEpisode = type === 'series' && Number.isInteger(season) && Number.isInteger(episode);
  const found = new Map();

  if (isEpisode) {
    const allQueries = queryVariants(titles, type, season, episode);
    const s = String(season).padStart(2, '0');
    const e = String(episode).padStart(2, '0');
    const exactNeedles = [new RegExp(`S${s}E${e}`, 'i'), new RegExp(`${season}x${e}`, 'i')];
    const exactQueries = allQueries.filter(query => exactNeedles.some(pattern => pattern.test(query))).slice(0, 8);
    const fallbackQueries = allQueries.filter(query => !exactQueries.includes(query)).slice(0, 8);

    for (let offset = 0; offset < exactQueries.length && found.size < limit * 2; offset += 4) {
      const batch = exactQueries.slice(offset, offset + 4);
      const groups = await Promise.all(batch.map(query => searchTorrents(client, query, titles, 1, false)));
      for (const results of groups) {
        for (const item of results) if (!found.has(item.id)) found.set(item.id, item);
      }
    }

    if (found.size < Math.max(4, limit)) {
      for (let offset = 0; offset < fallbackQueries.length && found.size < limit * 2; offset += 4) {
        const batch = fallbackQueries.slice(offset, offset + 4);
        const groups = await Promise.all(batch.map(query => searchTorrents(client, query, titles, 1, false)));
        for (const results of groups) {
          for (const item of results) if (!found.has(item.id)) found.set(item.id, item);
        }
      }
    }
  } else {
    // Keep the proven movie/non-episode search unchanged.
    const plainTitles = [...new Set((titles || [])
      .map(title => String(title || '').replace(/\b(?:19|20)\d{2}\b/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean))];
    const query = plainTitles.sort((a, b) => a.length - b.length)[0] || '';
    if (!query) return [];
    const results = await searchTorrents(client, query, titles, 3, false);
    for (const item of results) if (!found.has(item.id)) found.set(item.id, item);
  }

  const candidates = [...found.values()]
    .map(candidate => ({
      ...candidate,
      episodePriority: isEpisode ? episodeReleasePriority(candidate.name, season, episode) : 0
    }))
    .filter(candidate => candidate.episodePriority < 9)
    .sort((a, b) =>
      (a.episodePriority - b.episodePriority) ||
      (b.score - a.score) ||
      (b.seeds - a.seeds)
    )
    .slice(0, Math.min(limit * 3, 18));

  const resolved = await Promise.all(candidates.map(async candidate => {
    const torrent = await downloadTorrentData(client, candidate);
    if (!torrent) return null;
    const file = chooseVideoFile(torrent.files, type, season, episode);
    if (!file) return null;

    const combined = `${candidate.name} ${file.path}`;
    const quality = qualityFromText(combined);
    const tags = codecTags(combined);
    const language = formatLanguageCodes(candidate.flagLanguages) || languageLabel(combined);
    const subtitleHint = subtitleHintFromCategory(candidate.category);
    const size = candidate.size !== '?' ? candidate.size : humanBytes(file.length);
    const fileName = String(file.path || '').split('/').pop();
    const releaseName = fileName
      .replace(/\.(?:mkv|mp4|avi|m4v|mov|ts|webm)$/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const details = [`👥 ${candidate.seeds} seed`, `📦 ${size}`, ...tags].filter(Boolean).join(' • ');
    const titleLines = [
      language ? `🎧 ${language}` : null,
      subtitleHint ? `💬 ${subtitleHint}` : null,
      releaseName ? `🎞 ${releaseName}` : null,
      details
    ].filter(Boolean);

    return {
      episodePriority: candidate.episodePriority,
      stream: {
        name: `SKTorrent • ${quality}`,
        title: titleLines.join('\n'),
        infoHash: torrent.infoHash,
        fileIdx: file.index,
        fileName,
        sources: torrent.trackers.map(tracker => `tracker:${tracker}`),
        behaviorHints: { bingeGroup: `caseycz-skt:${torrent.infoHash}` }
      }
    };
  }));

  const usable = resolved.filter(Boolean);
  if (!isEpisode) return usable.map(item => item.stream).slice(0, limit);

  const hasEpisodeOrSeasonRelease = usable.some(item => item.episodePriority <= 1);
  const preferred = hasEpisodeOrSeasonRelease
    ? usable.filter(item => item.episodePriority <= 1)
    : usable;
  return preferred
    .sort((a, b) => a.episodePriority - b.episodePriority)
    .map(item => item.stream)
    .slice(0, limit);
}

module.exports = {
  getClient,
  findTorrentStreams,
  searchTorrents,
  activeClientCount: () => clients.size
};
