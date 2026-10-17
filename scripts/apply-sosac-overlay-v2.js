const fs = require('fs');

function replaceOnce(source, oldText, newText, label) {
  if (!source.includes(oldText)) throw new Error(`Missing anchor: ${label}`);
  return source.replace(oldText, newText);
}

let s = fs.readFileSync('addon.js', 'utf8');
const helpers = fs.readFileSync('scripts/sosac-overlay-addon-snippet.txt', 'utf8');

s = replaceOnce(s,
  "const { findOnlineStreams } = require('./api/sktonline');\n",
  "const { findOnlineStreams } = require('./api/sktonline');\nconst { SosacOverlay } = require('./api/sosac-overlay');\n",
  'overlay import');

s = replaceOnce(s,
  "const streamCache = new NodeCache({ stdTTL: 5 * 60, checkperiod: 60, maxKeys: 2000 });\n",
  "const streamCache = new NodeCache({ stdTTL: 5 * 60, checkperiod: 60, maxKeys: 2000 });\nconst subtitleCache = new NodeCache({ stdTTL: 10 * 60, checkperiod: 60, maxKeys: 2000 });\nconst subtitleProbeCache = new NodeCache({ stdTTL: 60 * 60, checkperiod: 5 * 60, maxKeys: 4000 });\n",
  'subtitle caches');

s = replaceOnce(s,
  "  const wantsTorrents = value.enableTorrents === true;\n  return {\n",
  "  const wantsTorrents = value.enableTorrents === true;\n  const sosacUsername = String(value.sosacUsername || '').trim().slice(0, 128);\n  const sosacPassword = String(value.sosacPassword || '').slice(0, 256);\n  return {\n",
  'overlay config fields');

s = replaceOnce(s,
  "    sktUsername: wantsTorrents ? sktUsername : '',\n    sktPassword: wantsTorrents ? sktPassword : ''\n",
  "    sktUsername: wantsTorrents ? sktUsername : '',\n    sktPassword: wantsTorrents ? sktPassword : '',\n    sosacUsername: sosacUsername && sosacPassword ? sosacUsername : '',\n    sosacPassword: sosacUsername && sosacPassword ? sosacPassword : ''\n",
  'normalized overlay config');

s = replaceOnce(s,
  "function configFingerprint(cfg) {\n  const material = cfg.enableTorrents\n    ? `p2p\\0${cfg.sktUsername}\\0${cfg.sktPassword}`\n    : 'direct-only';\n  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);\n}\n",
  "function configFingerprint(cfg) {\n  const material = JSON.stringify({\n    p2p: cfg.enableTorrents ? [cfg.sktUsername, cfg.sktPassword] : null,\n    sosac: cfg.sosacUsername && cfg.sosacPassword ? [cfg.sosacUsername, cfg.sosacPassword] : null\n  });\n  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16);\n}\n",
  'config fingerprint');

s = replaceOnce(s,
  "    idPrefixes: ['tt'],\n    resources: ['stream'],\n",
  "    idPrefixes: ['tt', 'sosac_m_', 'sosac_s_', 'sosac_ep_'],\n    resources: ['stream', 'subtitles'],\n",
  'manifest compatibility');

s = replaceOnce(s,
  "app.post('/api/config-token', async (req, res) => {\n",
  helpers + "app.post('/api/config-token', async (req, res) => {\n",
  'overlay helpers');

s = replaceOnce(s,
  "  const parsed = parseStremioId(req.params.id);\n  if (!parsed) return res.json({ streams: [], cacheMaxAge: 0 });\n",
  "  const parsed = await resolveIncomingStremioId(cfg, req.params.type, req.params.id);\n  if (!parsed) return res.json({ streams: [], cacheMaxAge: 0 });\n",
  'stream id resolver');

s = replaceOnce(s,
  "app.get('/version', (req, res) => {\n",
  "app.get('/:cfg/subtitles/:type/:id.json', handleSubtitles);\napp.get('/:cfg/subtitles/:type/:id/:extra.json', handleSubtitles);\n\napp.get('/version', (req, res) => {\n",
  'subtitle routes');

s = replaceOnce(s,
  "    providers: ['SKTOnline direct search', 'SKTOnline players from SKTorrent details', 'SledujTo', 'SKTorrent P2P'],\n    streamCacheKeys: streamCache.keys().length\n",
  "    providers: ['SKTOnline direct search', 'SKTOnline players from SKTorrent details', 'SledujTo', 'SKTorrent P2P', 'Sosac ID overlay'],\n    sosacOverlay: true,\n    streamCacheKeys: streamCache.keys().length,\n    subtitleCacheKeys: subtitleCache.keys().length,\n    subtitleProbeCacheKeys: subtitleProbeCache.keys().length\n",
  'health overlay');

fs.writeFileSync('addon.js', s);

let html = fs.readFileSync('public/configure.html', 'utf8');
html = replaceOnce(html,
  '<div class="source"><strong>SKTorrent P2P</strong><span>Addon vrátí Stremiu infoHash, správný soubor a trackery z původního .torrentu.</span></div>\n      </div>',
  '<div class="source"><strong>SKTorrent P2P</strong><span>Addon vrátí Stremiu infoHash, správný soubor a trackery z původního .torrentu.</span></div>\n        <div class="source"><strong>Sosáč overlay</strong><span>Položky katalogu Sosáče převede na IMDb/Cinemeta ID bez změny Sosáč addonu.</span></div>\n      </div>',
  'source card');

html = replaceOnce(html,
  '      <div class="note">Přehrávání zůstává mimo náš server: direct zdroje jdou přímo z jejich CDN a torrent jde přímo přes P2P. Server řeší jen vyhledání, přihlášení a metadata.</div>',
  '      <div class="auth">\n        <div class="field">\n          <label for="sosacUsername">Sosáč uživatelské jméno (volitelné)</label>\n          <input id="sosacUsername" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Stejné jako v Sosáč addonu">\n        </div>\n        <div class="field">\n          <label for="sosacPassword">Sosáč heslo (volitelné)</label>\n          <input id="sosacPassword" type="password" autocomplete="current-password" placeholder="Heslo">\n        </div>\n        <div class="note">Slouží jen pro naši vlastní překladovou vrstvu <code>sosac_* → IMDb/Cinemeta</code>. Sosáč repo ani addon se nijak nemění.</div>\n      </div>\n\n      <div class="note">Přehrávání zůstává mimo náš server: direct zdroje jdou přímo z jejich CDN a torrent jde přímo přes P2P. Server řeší jen vyhledání, přihlášení a metadata.</div>',
  'overlay auth UI');

html = replaceOnce(html,
  "const cfg={uiLanguage:document.getElementById('uiLanguage').value,enableOnline:true,enableTorrents:torrents,sktUsername:username,sktPassword:password};",
  "const cfg={uiLanguage:document.getElementById('uiLanguage').value,enableOnline:true,enableTorrents:torrents,sktUsername:username,sktPassword:password,sosacUsername:document.getElementById('sosacUsername').value.trim(),sosacPassword:document.getElementById('sosacPassword').value};",
  'overlay UI payload');

fs.writeFileSync('public/configure.html', html);

let readme = fs.readFileSync('README.md', 'utf8');
if (!readme.includes('Sosáč katalogová ID')) {
  readme = readme.replace('- SKTOnline přímé MP4 streamy\n', '- SKTOnline přímé MP4 streamy\n- SKTOnline VTT titulky (CZ/SK) přes Stremio `subtitles` resource\n- Sosáč katalogová ID (`sosac_m_*`, `sosac_s_*`, `sosac_ep_*`) umí vlastní overlay převést na IMDb/Cinemeta bez změny Sosáč addonu\n');
}
if (!readme.includes('- `/:cfg/subtitles/:type/:id.json`')) {
  readme = readme.replace('- `/:cfg/stream/:type/:id.json`\n', '- `/:cfg/stream/:type/:id.json`\n- `/:cfg/subtitles/:type/:id.json`\n');
}
fs.writeFileSync('README.md', readme);
