const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const NodeCache = require('node-cache');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { CinemetaApi, uniqueStrings } = require('./api/cinemeta');
const { findOnlineStreams, findOnlineSourceBundle } = require('./api/sktonline');
const { SosacOverlay } = require('./api/sosac-overlay');
const { getClient, findTorrentStreams, activeClientCount } = require('./api/sktorrent');

const app = express();
const PORT = Number(process.env.PORT || 7002);
const VERSION = require('./package.json').version;
const CONFIG_KEY_FILE = process.env.CONFIG_ENCRYPTION_KEY_FILE || path.join(os.homedir(), '.stremio-sktonline-config-key');
const CONFIG_TOKEN_AAD = Buffer.from('stremio-sktonline:enc1', 'utf8');
const streamCache = new NodeCache({ stdTTL: 5 * 60, checkperiod: 60, maxKeys: 2000 });
const subtitleCache = new NodeCache({ stdTTL: 10 * 60, checkperiod: 60, maxKeys: 2000 });
const subtitleProbeCache = new NodeCache({ stdTTL: 60 * 60, checkperiod: 5 * 60, maxKeys: 4000 });
const sourceIdentityCache = new NodeCache({ stdTTL: 10 * 60, checkperiod: 60, maxKeys: 2000 });
const cinemeta = new CinemetaApi();
const SKTONLINE_PROXY_URL = String(process.env.SKTONLINE_PROXY_URL || '').trim();
const sktOnlineSubtitleProxyAgent = SKTONLINE_PROXY_URL ? new SocksProxyAgent(SKTONLINE_PROXY_URL) : null;

function subtitleProxyConfig() {
  return sktOnlineSubtitleProxyAgent
    ? { httpAgent: sktOnlineSubtitleProxyAgent, httpsAgent: sktOnlineSubtitleProxyAgent, proxy: false }
    : {};
}

function readConfigEncryptionKey() {
  const candidates = [String(process.env.CONFIG_ENCRYPTION_KEY || '').trim()];
  try { candidates.push(fs.readFileSync(CONFIG_KEY_FILE, 'utf8').trim()); } catch (_) {}
  for (const raw of candidates) if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  return null;
}
const CONFIG_ENCRYPTION_KEY = readConfigEncryptionKey();

app.disable('etag');
app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.path.endsWith('.json')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
  next();
});

function noCache(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
}

function encryptConfig(cfg) {
  if (!CONFIG_ENCRYPTION_KEY) {
    const error = new Error('Configuration encryption key is not available');
    error.code = 'CONFIG_KEY_MISSING';
    throw error;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', CONFIG_ENCRYPTION_KEY, iv);
  cipher.setAAD(CONFIG_TOKEN_AAD);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(cfg), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['enc1', iv.toString('base64url'), encrypted.toString('base64url'), tag.toString('base64url')].join('.');
}

function decryptConfig(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'enc1' || !CONFIG_ENCRYPTION_KEY) return null;
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const encrypted = Buffer.from(parts[2], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || !encrypted.length) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', CONFIG_ENCRYPTION_KEY, iv);
    decipher.setAAD(CONFIG_TOKEN_AAD);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    const value = JSON.parse(plain);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (_) {
    return null;
  }
}

function normalizeConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sktUsername = String(value.sktUsername || value.username || '').trim().slice(0, 128);
  const sktPassword = String(value.sktPassword || value.password || '').slice(0, 256);
  const wantsTorrents = value.enableTorrents === true;
  const sosacUsername = String(value.sosacUsername || '').trim().slice(0, 128);
  const sosacPassword = String(value.sosacPassword || '').slice(0, 256);
  return {
    uiLanguage: ['cs', 'sk', 'en'].includes(value.uiLanguage) ? value.uiLanguage : 'cs',
    enableOnline: value.enableOnline !== false,
    enableTorrents: wantsTorrents && Boolean(sktUsername && sktPassword),
    sktUsername: wantsTorrents ? sktUsername : '',
    sktPassword: wantsTorrents ? sktPassword : '',
    sosacUsername: sosacUsername && sosacPassword ? sosacUsername : '',
    sosacPassword: sosacUsername && sosacPassword ? sosacPassword : ''
  };
}

function configFingerprint(cfg) {
  const material = JSON.stringify({
    p2p: cfg.enableTorrents ? [cfg.sktUsername, cfg.sktPassword] : null,
    sosac: cfg.sosacUsername && cfg.sosacPassword ? [cfg.sosacUsername, cfg.sosacPassword] : null
  });
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);
}

function getHost(req) {
  const proto = String(req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http')).split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`).split(',')[0].trim();
  const prefixRaw = String(req.headers['x-forwarded-prefix'] || '').split(',')[0].trim();
  const prefix = prefixRaw && prefixRaw !== '/' ? `/${prefixRaw.replace(/^\/+|\/+$/g, '')}` : '';
  return `${proto}://${host}${prefix}`;
}

function labels(language) {
  return {
    cs: { name: 'SKTOnline + SledujTo + SKTorrent', description: 'Přímé streamy ze SKTOnline a SledujTo plus volitelné SKTorrent P2P torrenty.' },
    sk: { name: 'SKTOnline + SledujTo + SKTorrent', description: 'Priame streamy zo SKTOnline a SledujTo plus voliteľné SKTorrent P2P torrenty.' },
    en: { name: 'SKTOnline + SledujTo + SKTorrent', description: 'Direct SKTOnline and SledujTo streams plus optional SKTorrent P2P torrents.' }
  }[language] || null;
}

function buildManifest(cfg) {
  const copy = labels(cfg.uiLanguage) || labels('cs');
  return {
    id: 'cz.caseycz.stremio.sktonline.direct',
    version: VERSION,
    name: copy.name,
    description: copy.description,
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'sosac_m_', 'sosac_s_', 'sosac_ep_'],
    resources: ['stream', 'subtitles'],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: false }
  };
}

function parseStremioId(id) {
  const parts = String(id || '').split(':');
  const imdbId = parts[0];
  if (!/^tt\d{5,10}$/i.test(imdbId)) return null;
  const season = parts.length > 1 && /^\d+$/.test(parts[1]) ? Number(parts[1]) : null;
  const episode = parts.length > 2 && /^\d+$/.test(parts[2]) ? Number(parts[2]) : null;
  return { imdbId: imdbId.toLowerCase(), season, episode };
}

function metaYear(meta) {
  for (const value of [meta && meta.year, meta && meta.releaseInfo, meta && meta.released]) {
    const match = String(value || '').match(/\b(19|20)\d{2}\b/);
    if (match) return match[0];
  }
  return null;
}

function titleCandidates(meta, type) {
  const titles = uniqueStrings([
    meta && meta.name,
    meta && meta.originalName,
    ...(Array.isArray(meta && meta.nameTranslations) ? meta.nameTranslations : [])
  ]).slice(0, 5);
  const year = type === 'movie' ? metaYear(meta) : null;
  return year
    ? uniqueStrings([...titles, ...titles.map(title => `${title} ${year}`)]).slice(0, 10)
    : titles;
}

function resolveWithin(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => {
      console.warn(`[stream] ${label} lookup timed out after ${timeoutMs}ms`);
      resolve([]);
    }, timeoutMs);
  });
  return Promise.race([
    Promise.resolve(promise).catch(error => {
      console.warn(`[stream] ${label} lookup failed: ${error.message}`);
      return [];
    }),
    timeout
  ]).finally(() => clearTimeout(timer));
}

function normalizePlaybackStreams(streams) {
  if (!Array.isArray(streams)) return [];
  return streams.map(stream => {
    if (!stream || !String(stream.name || '').startsWith('SKTOnline • ')) return stream;
    try {
      const url = new URL(String(stream.url || ''));
      const host = url.hostname.toLowerCase();
      const isSktCdn = host === 'sktorrent.eu' || host.endsWith('.sktorrent.eu');
      if (url.protocol !== 'https:' || !isSktCdn || !/\.mp4$/i.test(url.pathname)) return stream;
    } catch (_) {
      return stream;
    }

    const behaviorHints = { ...(stream.behaviorHints || {}) };
    delete behaviorHints.proxyHeaders;
    behaviorHints.notWebReady = false;
    return { ...stream, behaviorHints };
  });
}

function sktVideoIdFromStream(stream) {
  if (!stream || !String(stream.name || '').startsWith('SKTOnline • ')) return null;
  try {
    const url = new URL(String(stream.url || ''));
    const match = decodeURIComponent(url.pathname || '').match(/\/h264\/(\d+)_((?:2160|1440|1080|720|480|360|240)p)\.mp4$/i);
    return match ? match[1] : null;
  } catch (_) {
    return null;
  }
}

function replaceStreamSubtitleLine(title, value) {
  const lines = String(title || '').split('\n');
  const text = `💬 ${value || 'Bez titulků'}`;
  const index = lines.findIndex(line => /^💬\s/.test(line));
  if (index >= 0) lines[index] = text;
  else if (lines.length > 1) lines.splice(1, 0, text);
  else lines.push(text);
  return lines.join('\n');
}

async function decorateSktOnlineSubtitleLabels(streams) {
  if (!Array.isArray(streams) || !streams.length) return streams || [];
  const videoIds = uniqueStrings(streams.map(sktVideoIdFromStream).filter(Boolean));
  if (!videoIds.length) return streams;

  const availability = new Map(await Promise.all(videoIds.map(async videoId => {
    const [hasCz, hasSk] = await Promise.all([
      subtitleUrlExists(`https://online.sktorrent.eu/media/videos/vtt/${videoId}/cze.vtt`),
      subtitleUrlExists(`https://online.sktorrent.eu/media/videos/vtt/${videoId}/slo.vtt`)
    ]);
    return [videoId, Boolean(hasCz || hasSk)];
  })));

  return streams.map(stream => {
    const videoId = sktVideoIdFromStream(stream);
    if (!videoId) return stream;
    const hasSubtitles = availability.get(videoId) === true;
    return {
      ...stream,
      title: replaceStreamSubtitleLine(stream.title, hasSubtitles ? 'Titulky' : 'Bez titulků')
    };
  });
}

function combinedStreamIdentity(stream) {
  if (!stream) return '';
  if (stream.infoHash) {
    return `torrent:${String(stream.infoHash).toLowerCase()}:${Number(stream.fileIdx || 0)}`;
  }
  if (stream.url) {
    const raw = String(stream.url).trim();
    try {
      const parsed = new URL(raw);
      const path = decodeURIComponent(parsed.pathname || '');
      const skt = path.match(/\/h264\/(\d+)_((?:2160|1440|1080|720|480|360|240)p)\.mp4$/i);
      if (skt) return `sktvideo:${skt[1]}:${skt[2].toLowerCase()}`;
      return `url:${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${parsed.pathname}${parsed.search}`;
    } catch (_) {
      return `url:${raw}`;
    }
  }
  return `other:${stream.name || ''}:${stream.title || ''}`;
}

function dedupeCombinedStreams(streams) {
  const seen = new Set();
  return (streams || []).filter(stream => {
    const key = combinedStreamIdentity(stream);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function makeSosacOverlay(cfg) {
  return new SosacOverlay({ username: cfg.sosacUsername, password: cfg.sosacPassword });
}

async function resolveIncomingStremioId(cfg, type, id) {
  const direct = parseStremioId(id);
  if (direct) return direct;
  if (!/^sosac_(?:m|s|ep)_\d+$/i.test(String(id || ''))) return null;
  if (!cfg.sosacUsername || !cfg.sosacPassword) return null;

  try {
    const resolved = await makeSosacOverlay(cfg).resolve(type, id);
    if (!resolved) return null;
    console.log(`[sosac-overlay] ${type}/${id} -> ${resolved.id}`);
    return {
      imdbId: resolved.imdbId,
      season: resolved.season,
      episode: resolved.episode,
      canonicalId: resolved.id,
      sourceId: id
    };
  } catch (error) {
    console.warn(`[sosac-overlay] ${type}/${id}: ${error.message}`);
    return null;
  }
}

function extractSktOnlineVideoIds(streams) {
  const ids = [];
  const seen = new Set();
  for (const stream of Array.isArray(streams) ? streams : []) {
    if (!stream || !String(stream.name || '').startsWith('SKTOnline • ')) continue;
    try {
      const url = new URL(String(stream.url || ''));
      const host = url.hostname.toLowerCase();
      if (!(host === 'sktorrent.eu' || host.endsWith('.sktorrent.eu'))) continue;
      const match = decodeURIComponent(url.pathname || '').match(/\/h264\/(\d+)_((?:2160|1440|1080|720|480|360|240)p)\.mp4$/i);
      if (!match || seen.has(match[1])) continue;
      seen.add(match[1]);
      ids.push(match[1]);
    } catch (_) {}
  }
  return ids;
}

async function subtitleUrlExists(url) {
  const cached = subtitleProbeCache.get(url);
  if (cached !== undefined) return cached === true;
  try {
    const response = await require('axios').get(url, {
      timeout: 7000,
      ...subtitleProxyConfig(),
      responseType: 'text',
      transformResponse: [data => data],
      maxContentLength: 2 * 1024 * 1024,
      validateStatus: status => status >= 200 && status < 400,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143 Safari/537.36',
        Accept: 'text/vtt,text/plain,*/*',
        Referer: 'https://online.sktorrent.eu/'
      }
    });
    const body = String(response.data || '').replace(/^\uFEFF/, '').trimStart();
    const contentType = String(response.headers && response.headers['content-type'] || '');
    const ok = /^WEBVTT(?:\s|$)/i.test(body) || /text\/vtt/i.test(contentType);
    subtitleProbeCache.set(url, ok, ok ? 60 * 60 : 5 * 60);
    return ok;
  } catch (_) {
    subtitleProbeCache.set(url, false, 5 * 60);
    return false;
  }
}

async function resolveSktOnlineSubtitles(cfg, type, requestId, parsed) {
  const lookupKey = `sub-v2:${configFingerprint(cfg)}:${type}:${requestId}`;
  const cached = subtitleCache.get(lookupKey);
  if (cached !== undefined) return cached;
  if (!cfg.enableOnline) return [];

  const fingerprint = configFingerprint(cfg);
  const combinedKey = `combined-v16:${fingerprint}:${type}:${requestId}`;
  const sourceKey = `source-videoids-v1:${fingerprint}:${type}:${requestId}`;
  let videoIds = sourceIdentityCache.get(sourceKey);

  // Backward-compatible fallback for a stream response cached before the
  // source-identity resolver ran. Normally subtitles reuse sourceKey directly.
  if (!Array.isArray(videoIds) || !videoIds.length) {
    const combinedStreams = streamCache.get(combinedKey);
    if (Array.isArray(combinedStreams)) {
      videoIds = extractSktOnlineVideoIds(combinedStreams);
    }
  }

  if (!Array.isArray(videoIds) || !videoIds.length) {
    const meta = await cinemeta.getMeta(type, parsed.imdbId);
    const titles = titleCandidates(meta, type);
    if (!titles.length) {
      subtitleCache.set(lookupKey, [], 2 * 60);
      return [];
    }
    const bundleRaw = await resolveWithin(findOnlineSourceBundle({
      imdbId: parsed.imdbId,
      titles,
      type,
      season: parsed.season,
      episode: parsed.episode,
      sktUsername: cfg.enableTorrents ? cfg.sktUsername : '',
      sktPassword: cfg.enableTorrents ? cfg.sktPassword : ''
    }), 22000, 'subtitle-direct-source');
    const bundle = bundleRaw && !Array.isArray(bundleRaw) ? bundleRaw : { streams: [], videoIds: [] };
    videoIds = Array.isArray(bundle.videoIds) ? bundle.videoIds : [];
    if (videoIds.length) sourceIdentityCache.set(sourceKey, videoIds, 10 * 60);
  }

  videoIds = uniqueStrings(videoIds).slice(0, 8);
  const candidates = [];
  for (const videoId of videoIds) {
    candidates.push(
      { id: `sktonline-${videoId}-cze`, lang: 'cze', url: `https://online.sktorrent.eu/media/videos/vtt/${videoId}/cze.vtt` },
      { id: `sktonline-${videoId}-slo`, lang: 'slk', url: `https://online.sktorrent.eu/media/videos/vtt/${videoId}/slo.vtt` }
    );
  }

  const checked = await Promise.all(candidates.map(async item => await subtitleUrlExists(item.url) ? item : null));
  const subtitles = checked.filter(Boolean);
  subtitleCache.set(lookupKey, subtitles, subtitles.length ? 10 * 60 : 2 * 60);
  console.log(`[subtitle] ${type}/${requestId}: videoIds=${videoIds.join(',') || '-'} tracks=${subtitles.length}`);
  return subtitles;
}

async function handleSubtitles(req, res) {
  noCache(res);
  const cfg = normalizeConfig(decryptConfig(req.params.cfg));
  if (!cfg) return res.status(400).json({ error: 'Invalid configuration' });
  if (!['movie', 'series'].includes(req.params.type)) return res.json({ subtitles: [] });

  const id = String(req.params.id || '').replace(/\.json$/, '');
  const parsed = await resolveIncomingStremioId(cfg, req.params.type, id);
  if (!parsed) return res.json({ subtitles: [] });

  try {
    const subtitles = await resolveSktOnlineSubtitles(cfg, req.params.type, id, parsed);
    return res.json({ subtitles });
  } catch (error) {
    console.error(`[subtitle] ${req.params.type}/${id}: ${error.message}`);
    return res.json({ subtitles: [] });
  }
}

app.post('/api/config-token', async (req, res) => {
  noCache(res);
  const body = req.body || {};
  const cfg = normalizeConfig(body);
  if (!cfg) return res.status(400).json({ error: 'Invalid configuration' });
  if (body.enableTorrents === true && !cfg.enableTorrents) {
    return res.status(400).json({ error: 'Pro torrenty vyplň uživatelské jméno a heslo SKTorrent.' });
  }

  try {
    let loginVerified = false;
    if (cfg.enableTorrents) {
      await getClient(cfg.sktUsername, cfg.sktPassword).login(false);
      loginVerified = true;
    }
    return res.json({
      format: 'enc1',
      token: encryptConfig(cfg),
      loginVerified,
      directOnly: !cfg.enableTorrents,
      torrentsEnabled: cfg.enableTorrents
    });
  } catch (error) {
    if (error.code === 'CONFIG_KEY_MISSING') return res.status(503).json({ error: 'Encrypted configuration is not available' });
    console.warn(`[config] ${error.message}`);
    return res.status(400).json({ error: error.message || 'SKTorrent login failed' });
  }
});

app.get('/', (req, res) => res.redirect('/configure'));
app.get('/configure', (req, res) => {
  noCache(res);
  res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Stremio opens /<encrypted-config>/configure for an installed configured addon.
// Keep the existing token private and serve the setup UI at this path.
app.get('/:cfg/configure', (req, res) => {
  noCache(res);
  if (!decryptConfig(req.params.cfg)) return res.status(404).send('Configuration not found');
  return res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

app.get('/manifest.json', (req, res) => {
  noCache(res);
  res.json({
    id: 'cz.caseycz.stremio.sktonline.direct.configure',
    version: VERSION,
    name: 'SKTOnline + SledujTo + SKTorrent',
    description: `Configure at ${getHost(req)}/configure`,
    types: [], resources: [], catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: true }
  });
});

app.get('/:cfg/manifest.json', (req, res) => {
  noCache(res);
  const cfg = normalizeConfig(decryptConfig(req.params.cfg));
  if (!cfg) return res.status(400).json({ error: 'Invalid configuration' });
  return res.json(buildManifest(cfg));
});

app.get('/:cfg/stream/:type/:id.json', async (req, res) => {
  noCache(res);
  const cfg = normalizeConfig(decryptConfig(req.params.cfg));
  if (!cfg) return res.status(400).json({ error: 'Invalid configuration' });
  if (!['movie', 'series'].includes(req.params.type)) return res.json({ streams: [], cacheMaxAge: 0 });
  const parsed = await resolveIncomingStremioId(cfg, req.params.type, req.params.id);
  if (!parsed) return res.json({ streams: [], cacheMaxAge: 0 });

  const cacheKey = `combined-v16:${configFingerprint(cfg)}:${req.params.type}:${req.params.id}`;
  const cached = streamCache.get(cacheKey);
  if (cached !== undefined) return res.json({ streams: cached, cacheMaxAge: 0, staleRevalidate: 0, staleError: 0 });

  try {
    const meta = await cinemeta.getMeta(req.params.type, parsed.imdbId);
    const titles = titleCandidates(meta, req.params.type);
    if (!titles.length) return res.json({ streams: [], cacheMaxAge: 0 });

    const directPromise = cfg.enableOnline
      ? resolveWithin(findOnlineSourceBundle({
          imdbId: parsed.imdbId,
          titles,
          type: req.params.type,
          season: parsed.season,
          episode: parsed.episode,
          sktUsername: cfg.enableTorrents ? cfg.sktUsername : '',
          sktPassword: cfg.enableTorrents ? cfg.sktPassword : ''
        }), 22000, 'direct-source')
      : Promise.resolve({ streams: [], videoIds: [] });

    const torrentPromise = cfg.enableTorrents
      ? resolveWithin(findTorrentStreams({
          username: cfg.sktUsername,
          password: cfg.sktPassword,
          imdbId: parsed.imdbId,
          titles,
          type: req.params.type,
          season: parsed.season,
          episode: parsed.episode,
          limit: 10
        }), 22000, 'sktorrent-p2p')
      : Promise.resolve([]);

    const [directRaw, torrents] = await Promise.all([directPromise, torrentPromise]);
    const directBundle = directRaw && !Array.isArray(directRaw)
      ? directRaw
      : { streams: Array.isArray(directRaw) ? directRaw : [], videoIds: [] };
    const direct = await decorateSktOnlineSubtitleLabels(normalizePlaybackStreams(Array.isArray(directBundle.streams) ? directBundle.streams : []));
    const videoIds = uniqueStrings(Array.isArray(directBundle.videoIds) ? directBundle.videoIds : []);
    const streams = dedupeCombinedStreams([...direct, ...torrents]);

    if (videoIds.length) {
      const sourceKey = `source-videoids-v1:${configFingerprint(cfg)}:${req.params.type}:${req.params.id}`;
      sourceIdentityCache.set(sourceKey, videoIds, 10 * 60);
      console.log(`[source] ${req.params.type}/${req.params.id}: videoIds=${videoIds.join(',')}`);
    }
    streamCache.set(cacheKey, streams, streams.length ? 5 * 60 : 60);
    return res.json({ streams, cacheMaxAge: 0, staleRevalidate: 0, staleError: 0 });
  } catch (error) {
    console.error(`[stream] ${req.params.type}/${req.params.id}: ${error.message}`);
    return res.json({ streams: [], cacheMaxAge: 0 });
  }
});

app.get('/:cfg/subtitles/:type/:id.json', handleSubtitles);
app.get('/:cfg/subtitles/:type/:id/:extra.json', handleSubtitles);

app.get('/version', (req, res) => {
  noCache(res);
  res.json({ version: VERSION });
});

app.get('/health', (req, res) => {
  noCache(res);
  res.json({
    ok: true,
    version: VERSION,
    addonId: 'cz.caseycz.stremio.sktonline.direct',
    encryption: Boolean(CONFIG_ENCRYPTION_KEY),
    mode: 'direct-plus-p2p',
    torrentsEnabled: true,
    torrentClients: activeClientCount(),
    resolverConfigured: Boolean(process.env.SKTONLINE_RESOLVER_URL),
    sktonlineProxyConfigured: Boolean(String(process.env.SKTONLINE_PROXY_URL || '').trim()),
    providers: ['SKTOnline direct search', 'SKTOnline players from SKTorrent details', 'SledujTo', 'SKTorrent P2P', 'Sosac ID overlay'],
    sosacOverlay: true,
    streamCacheKeys: streamCache.keys().length,
    subtitleCacheKeys: subtitleCache.keys().length,
    subtitleProbeCacheKeys: subtitleProbeCache.keys().length,
    sourceIdentityCacheKeys: sourceIdentityCache.keys().length
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`stremio-sktonline v${VERSION} listening on :${PORT} (direct + SKTorrent P2P)`);
  if (!CONFIG_ENCRYPTION_KEY) console.warn(`[config] Missing encryption key: ${CONFIG_KEY_FILE}`);
});
