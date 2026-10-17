const fs = require('fs');

function replaceOnce(source, oldText, newText, label) {
  if (!source.includes(oldText)) throw new Error(`Missing anchor: ${label}`);
  return source.replace(oldText, newText);
}

let s = fs.readFileSync('addon.js', 'utf8');

s = replaceOnce(
  s,
  "const { findOnlineStreams } = require('./api/sktonline');\n",
  "const { findOnlineStreams } = require('./api/sktonline');\nconst { SosacOverlay } = require('./api/sosac-overlay');\n",
  'SosacOverlay import'
);

s = replaceOnce(
  s,
  "const streamCache = new NodeCache({ stdTTL: 5 * 60, checkperiod: 60, maxKeys: 2000 });\n",
  "const streamCache = new NodeCache({ stdTTL: 5 * 60, checkperiod: 60, maxKeys: 2000 });\nconst subtitleCache = new NodeCache({ stdTTL: 10 * 60, checkperiod: 60, maxKeys: 2000 });\nconst subtitleProbeCache = new NodeCache({ stdTTL: 60 * 60, checkperiod: 5 * 60, maxKeys: 4000 });\n",
  'subtitle caches'
);

s = replaceOnce(
  s,
  "  const wantsTorrents = value.enableTorrents === true;\n  return {\n",
  "  const wantsTorrents = value.enableTorrents === true;\n  const sosacUsername = String(value.sosacUsername || '').trim().slice(0, 128);\n  const sosacPassword = String(value.sosacPassword || '').slice(0, 256);\n  return {\n",
  'Sosac config fields'
);

s = replaceOnce(
  s,
  "    sktUsername: wantsTorrents ? sktUsername : '',\n    sktPassword: wantsTorrents ? sktPassword : ''\n",
  "    sktUsername: wantsTorrents ? sktUsername : '',\n    sktPassword: wantsTorrents ? sktPassword : '',\n    sosacUsername: sosacUsername && sosacPassword ? sosacUsername : '',\n    sosacPassword: sosacUsername && sosacPassword ? sosacPassword : ''\n",
  'normalized Sosac config'
);

s = replaceOnce(
  s,
  "function configFingerprint(cfg) {\n  const material = cfg.enableTorrents\n    ? `p2p\\0${cfg.sktUsername}\\0${cfg.sktPassword}`\n    : 'direct-only';\n  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);\n}\n",
  "function configFingerprint(cfg) {\n  const material = JSON.stringify({\n    p2p: cfg.enableTorrents ? [cfg.sktUsername, cfg.sktPassword] : null,\n    sosac: cfg.sosacUsername && cfg.sosacPassword ? [cfg.sosacUsername, cfg.sosacPassword] : null\n  });\n  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);\n}\n",
  'config fingerprint'
);

s = replaceOnce(
  s,
  "    idPrefixes: ['tt'],\n    resources: ['stream'],\n",
  "    idPrefixes: ['tt', 'sosac_m_', 'sosac_s_', 'sosac_ep_'],\n    resources: ['stream', 'subtitles'],\n",
  'manifest compatibility'
);

const helpers = String.raw`
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

  const combinedKey = `combined-v13:${configFingerprint(cfg)}:${type}:${requestId}`;
  let directStreams = streamCache.get(combinedKey);

  if (!Array.isArray(directStreams)) {
    const meta = await cinemeta.getMeta(type, parsed.imdbId);
    const titles = titleCandidates(meta, type);
    if (!titles.length) {
      subtitleCache.set(lookupKey, [], 2 * 60);
      return [];
    }
    directStreams = await resolveWithin(findOnlineStreams({
      imdbId: parsed.imdbId,
      titles,
      type,
      season: parsed.season,
      episode: parsed.episode,
      sktUsername: cfg.enableTorrents ? cfg.sktUsername : '',
      sktPassword: cfg.enableTorrents ? cfg.sktPassword : ''
    }), 22000, 'subtitle-direct-detail');
  }

  const videoIds = extractSktOnlineVideoIds(directStreams).slice(0, 8);
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

`;

s = replaceOnce(
  s,
  "app.post('/api/config-token', async (req, res) => {\n",
  helpers + "app.post('/api/config-token', async (req, res) => {\n",
  'overlay helpers'
);

s = replaceOnce(
  s,
  "  const parsed = parseStremioId(req.params.id);\n  if (!parsed) return res.json({ streams: [], cacheMaxAge: 0 });\n",
  "  const parsed = await resolveIncomingStremioId(cfg, req.params.type, req.params.id);\n  if (!parsed) return res.json({ streams: [], cacheMaxAge: 0 });\n",
  'stream id resolver'
);

s = replaceOnce(
  s,
  "app.get('/version', (req, res) => {\n",
  "app.get('/:cfg/subtitles/:type/:id.json', handleSubtitles);\napp.get('/:cfg/subtitles/:type/:id/:extra.json', handleSubtitles);\n\napp.get('/version', (req, res) => {\n",
  'subtitle routes'
);

s = replaceOnce(
  s,
  "    providers: ['SKTOnline direct search', 'SKTOnline players from SKTorrent details', 'SledujTo', 'SKTorrent P2P'],\n    streamCacheKeys: streamCache.keys().length\n",
  "    providers: ['SKTOnline direct search', 'SKTOnline players from SKTorrent details', 'SledujTo', 'SKTorrent P2P', 'Sosac ID overlay'],\n    sosacOverlay: true,\n    streamCacheKeys: streamCache.keys().length,\n    subtitleCacheKeys: subtitleCache.keys().length,\n    subtitleProbeCacheKeys: subtitleProbeCache.keys().length\n",
  'health overlay'
);

fs.writeFileSync('addon.js', s);

let html = fs.readFileSync('public/configure.html', 'utf8');
html = replaceOnce(
  html,
  '<div class="source"><strong>SKTorrent P2P</strong><span>Addon vrátí Stremiu infoHash, správný soubor a trackery z původního .torrentu.</span></div>\n      </div>',
  '<div class="source"><strong>SKTorrent P2P</strong><span>Addon vrátí Stremiu infoHash, správný soubor a trackery z původního .torrentu.</span></div>\n        <div class="source"><strong>Sosáč overlay</strong><span>Položky katalogu Sosáče převede na IMDb/Cinemeta ID bez změny Sosáč addonu.</span></div>\n      </div>',
  'source card'
);

html = replaceOnce(
  html,
  '      <div class="note">Přehrávání zůstává mimo náš server: direct zdroje jdou přímo z jejich CDN a torrent jde přímo přes P2P. Server řeší jen vyhledání, přihlášení a metadata.</div>',
  `      <div class="auth">\n        <div class="field">\n          <label for="sosacUsername">Sosáč uživatelské jméno (volitelné)</label>\n          <input id="sosacUsername" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Stejné jako v Sosáč addonu">\n        </div>\n        <div class="field">\n          <label for="sosacPassword">Sosáč heslo (volitelné)</label>\n          <input id="sosacPassword" type="password" autocomplete="current-password" placeholder="Heslo">\n        </div>\n        <div class="note">Slouží jen pro naši vlastní překladovou vrstvu <code>sosac_* → IMDb/Cinemeta</code>. Sosáč repo ani addon se nijak nemění.</div>\n      </div>\n\n      <div class="note">Přehrávání zůstává mimo náš server: direct zdroje jdou přímo z jejich CDN a torrent jde přímo přes P2P. Server řeší jen vyhledání, přihlášení a metadata.</div>`,
  'Sosac auth UI'
);

html = replaceOnce(
  html,
  "const cfg={uiLanguage:document.getElementById('uiLanguage').value,enableOnline:true,enableTorrents:torrents,sktUsername:username,sktPassword:password};",
  "const cfg={uiLanguage:document.getElementById('uiLanguage').value,enableOnline:true,enableTorrents:torrents,sktUsername:username,sktPassword:password,sosacUsername:document.getElementById('sosacUsername').value.trim(),sosacPassword:document.getElementById('sosacPassword').value};",
  'Sosac UI payload'
);

fs.writeFileSync('public/configure.html', html);

let readme = fs.readFileSync('README.md', 'utf8');
if (!readme.includes('Sosáč katalogová ID')) {
  readme = readme.replace(
    '- SKTOnline přímé MP4 streamy\n',
    '- SKTOnline přímé MP4 streamy\n- SKTOnline VTT titulky (CZ/SK) přes Stremio `subtitles` resource\n- Sosáč katalogová ID (`sosac_m_*`, `sosac_s_*`, `sosac_ep_*`) umí vlastní overlay převést na IMDb/Cinemeta bez změny Sosáč addonu\n'
  );
}
if (!readme.includes('- `/:cfg/subtitles/:type/:id.json`')) {
  readme = readme.replace(
    '- `/:cfg/stream/:type/:id.json`\n',
    '- `/:cfg/stream/:type/:id.json`\n- `/:cfg/subtitles/:type/:id.json`\n'
  );
}
fs.writeFileSync('README.md', readme);
