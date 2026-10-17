const axios = require('axios');
const NodeCache = require('node-cache');

const cache = new NodeCache({ stdTTL: 24 * 60 * 60, checkperiod: 60 * 60, maxKeys: 2000 });
const WIKIDATA_SPARQL_URL = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'CaseyCZ-Stremio-SKTOnline/1.0';

function normalizeImdbId(value) {
  const imdbId = String(value || '').trim().toLowerCase();
  return /^tt\d{5,10}$/.test(imdbId) ? imdbId : null;
}

async function getCsfdUrl(imdbId) {
  const normalized = normalizeImdbId(imdbId);
  if (!normalized) return null;
  const key = `csfd:${normalized}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached || null;

  const query = `SELECT ?csfdId WHERE {
    ?item wdt:P345 "${normalized}".
    ?item wdt:P2529 ?csfdId.
  } LIMIT 5`;

  try {
    const response = await axios.get(WIKIDATA_SPARQL_URL, {
      params: { query, format: 'json' },
      timeout: 3000,
      headers: {
        Accept: 'application/sparql-results+json',
        'User-Agent': USER_AGENT,
        'Accept-Encoding': 'identity'
      }
    });
    const bindings = response.data?.results?.bindings || [];
    for (const row of bindings) {
      const id = String(row?.csfdId?.value || '').trim();
      if (!/^\d+$/.test(id)) continue;
      const url = `https://www.csfd.cz/film/${id}`;
      cache.set(key, url);
      return url;
    }
  } catch (error) {
    console.warn(`[csfd] Wikidata ${normalized}: ${error.message}`);
  }

  cache.set(key, false, 10 * 60);
  return null;
}

module.exports = { getCsfdUrl };
