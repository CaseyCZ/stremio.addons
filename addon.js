const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const NodeCache = require('node-cache');
const { CinemetaApi, uniqueStrings } = require('./api/cinemeta');
const { findOnlineStreams } = require('./api/sktonline');
const { getClient, findTorrentStreams, activeClientCount } = require('./api/sktorrent');

const app = express();
const PORT = Number(process.env.PORT || 7002);
const VERSION = require('./package.json').version;
const CONFIG_KEY_FILE = process.env.CONFIG_ENCRYPTION_KEY_FILE || path.join(os.homedir(), '.stremio-sktonline-config-key');
const CONFIG_TOKEN_AAD = Buffer.from('stremio-sktonline:enc1', 'utf8');
const streamCache = new NodeCache({ stdTTL: 5 * 60, checkperiod: 60, maxKeys: 1500 });
const cinemeta = new CinemetaApi();

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
  const cfg = {
    uiLanguage: ['cs', 'sk', 'en'].includes(value.uiLanguage) ? value.uiLanguage : 'cs',
    sktUser: String(value.sktUser || '').trim(),
    sktPass: String(value.sktPass || ''),
    enableOnline: value.enableOnline !== false,
    enableTorrents: value.enableTorrents !== false
  };
  if (!cfg.enableOnline && !cfg.enableTorrents) return null;
  if (cfg.enableTorrents && (!cfg.sktUser || !cfg.sktPass)) return null;
  if (cfg.sktUser.length > 128 || cfg.sktPass.length > 512) return null;
  if ([cfg.sktUser, cfg.sktPass].some(item => /[\0\r\n]/.test(item))) return null;
  return cfg;
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
    cs: { name: 'SKTOnline + SKTorrent', description: 'Přímé SKTOnline streamy a SKTorrent zdroje s automatickým obnovením přihlášení.' },
    sk: { name: 'SKTOnline + SKTorrent', description: 'Priame SKTOnline streamy a SKTorrent zdroje s automatickým obnovením prihlásenia.' },
    en: { name: 'SKTOnline + SKTorrent', description: 'Direct SKTOnline streams and SKTorrent sources with automatic login renewal.' }
  }[language] || null;
}

function buildManifest(cfg) {
  const copy = labels(cfg.uiLanguage) || labels('cs');
  return {
    id: 'cz.caseycz.stremio.sktonline',
    version: VERSION,
    name: copy.name,
    description: copy.description,
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    resources: ['stream'],
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

function titleCandidates(meta) {
  return uniqueStrings([
    meta && meta.name,
    meta && meta.originalName,
    ...(Array.isArray(meta && meta.nameTranslations) ? meta.nameTranslations : [])
  ]).slice(0, 5);
}

app.post('/api/config-token', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const cfg = normalizeConfig(req.body);
  if (!cfg) return res.status(400).json({ error: 'Invalid configuration' });

  if (cfg.enableTorrents) {
    try {
      await getClient(cfg.sktUser, cfg.sktPass).login(true);
    } catch (error) {
      console.warn(`[config] SKTorrent login failed: ${error.message}`);
      return res.status(401).json({ error: 'SKTorrent login failed', message: 'SKTorrent odmítl přihlášení. Zkontroluj jméno a heslo.' });
    }
  }

  try {
    return res.json({ format: 'enc1', token: encryptConfig(cfg), loginVerified: cfg.enableTorrents });
  } catch (error) {
    if (error.code === 'CONFIG_KEY_MISSING') return res.status(503).json({ error: 'Encrypted configuration is not available' });
    console.error(`[config] ${error.message}`);
    return res.status(500).json({ error: 'Unable to create encrypted configuration' });
  }
});

app.get('/', (req, res) => res.redirect('/configure'));
app.get('/configure', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

app.get('/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    id: 'cz.caseycz.stremio.sktonline.configure',
    version: VERSION,
    name: 'SKTOnline + SKTorrent',
    description: `Configure at ${getHost(req)}/configure`,
    types: [], resources: [], catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: true }
  });
});

app.get('/:cfg/manifest.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const cfg = normalizeConfig(decryptConfig(req.params.cfg));
  if (!cfg) return res.status(400).json({ error: 'Invalid configuration' });
  return res.json(buildManifest(cfg));
});

app.get('/:cfg/stream/:type/:id.json', async (req, res) => {
  const cfg = normalizeConfig(decryptConfig(req.params.cfg));
  if (!cfg) return res.status(400).json({ error: 'Invalid configuration' });
  if (!['movie', 'series'].includes(req.params.type)) return res.json({ streams: [] });
  const parsed = parseStremioId(req.params.id);
  if (!parsed) return res.json({ streams: [] });

  const configFingerprint = crypto.createHash('sha1').update(`${cfg.sktUser}\0${cfg.enableOnline}\0${cfg.enableTorrents}`).digest('hex').slice(0, 12);
  const cacheKey = `${configFingerprint}:${req.params.type}:${req.params.id}`;
  const cached = streamCache.get(cacheKey);
  if (cached !== undefined) return res.json({ streams: cached });

  try {
    const meta = await cinemeta.getMeta(req.params.type, parsed.imdbId);
    const titles = titleCandidates(meta);
    if (!titles.length) return res.json({ streams: [] });

    const jobs = [];
    if (cfg.enableOnline) jobs.push(findOnlineStreams({ titles, type: req.params.type, season: parsed.season, episode: parsed.episode }));
    else jobs.push(Promise.resolve([]));
    if (cfg.enableTorrents) jobs.push(findTorrentStreams({
      username: cfg.sktUser,
      password: cfg.sktPass,
      titles,
      type: req.params.type,
      season: parsed.season,
      episode: parsed.episode,
      limit: 8
    }));
    else jobs.push(Promise.resolve([]));

    const [online, torrents] = await Promise.all(jobs);
    const streams = [...online, ...torrents];
    streamCache.set(cacheKey, streams, streams.length ? 5 * 60 : 90);
    return res.json({ streams });
  } catch (error) {
    console.error(`[stream] ${req.params.type}/${req.params.id}: ${error.message}`);
    return res.json({ streams: [] });
  }
});

app.get('/version', (req, res) => res.json({ version: VERSION }));
app.get('/health', (req, res) => res.json({
  ok: true,
  version: VERSION,
  encryption: Boolean(CONFIG_ENCRYPTION_KEY),
  activeSktorrentClients: activeClientCount(),
  streamCacheKeys: streamCache.keys().length
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`stremio-sktonline v${VERSION} listening on :${PORT}`);
  if (!CONFIG_ENCRYPTION_KEY) console.warn(`[config] Missing encryption key: ${CONFIG_KEY_FILE}`);
});
