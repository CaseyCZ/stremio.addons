'use strict';

const SOURCE = String(process.env.BOMBUJ_META_URL || 'http://127.0.0.1:7004').replace(/\/+$/, '');
const ID_PATTERN = /^(?:tt\d{5,12}(?::\d{1,3}:\d{1,4})?|bombuj-movie-[a-z0-9-]+|bombuj-series-[a-z0-9-]+(?::\d{1,3}:\d{1,4})?|bombuj-episode-[a-z0-9-]+-\d{1,3}x\d{1,4})$/i;
const CATALOG_PATTERN = /^bombuj-[a-z0-9-]{1,100}$/i;
const EXTRA_PATTERN = /^[^/\u0000-\u001f\u007f]{1,400}$/u;

function bombujRequestPath(resource, type, id, extra) {
  if (!['movie', 'series'].includes(type)) return null;
  if (resource === 'catalog') {
    if (!CATALOG_PATTERN.test(String(id))) return null;
    if (extra === undefined) return '/catalog/' + type + '/' + id + '.json';
    if (!EXTRA_PATTERN.test(String(extra))) return null;
    // Keep '=' unescaped so Bombuj's catalog parser can read Stremio extras.
    const params = new URLSearchParams(String(extra));
    if (![...params.keys()].every(key => ['search','skip','genre','audio','sort','dubbing'].includes(key))) return null;
    return '/catalog/' + type + '/' + id + '/' + params.toString() + '.json';
  }
  if (!['stream', 'meta', 'subtitles'].includes(resource) || !ID_PATTERN.test(String(id))) return null;
  // Colons delimit episodes; preserve them in URLs for Bombuj parsing.
  return '/' + resource + '/' + type + '/' + encodeURIComponent(id).replace(/%3A/gi, ':') + '.json';
}

async function getBombujJson(path, fetchImpl = fetch) {
  if (!String(path).startsWith('/') || String(path).startsWith('//')) throw Error('Invalid bridge path');
  const response = await fetchImpl(SOURCE + path, {
    headers: { Accept:'application/json' },
    signal: AbortSignal.timeout(path.includes('/catalog/') ? 105000 : 45000)
  });
  if (!response.ok) throw Error('Bombuj HTTP ' + response.status);
  return response.json();
}

function bombujManifest(source, sosacEnabled = false) {
  if (!source || !Array.isArray(source.resources) || !Array.isArray(source.catalogs)) {
    throw Error('Invalid Bombuj manifest');
  }
  const resources = source.resources.map(item => {
    if (!['stream', 'subtitles'].includes(item.name)) return item;
    const existing = Array.isArray(item.idPrefixes) ? item.idPrefixes : [];
    const overlay = sosacEnabled ? ['sosac_m_', 'sosac_s_', 'sosac_ep_'] : [];
    return { ...item, idPrefixes: [...new Set([...existing, ...overlay])] };
  });
  return {
    ...source,
    id: 'cz.caseycz.stremio.bombuj.unified',
    name: 'Bombuj',
    resources,
    behaviorHints: { ...(source.behaviorHints || {}), configurable: true, configurationRequired: false }
  };
}

module.exports = { bombujManifest, bombujRequestPath, getBombujJson };
