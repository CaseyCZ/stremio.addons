'use strict';

const { inspectHls } = require('../stream-quality.js');

const API = 'https://streamdata.vaplayer.ru/api.php';
const ORIGIN = 'https://nextgencloudfabric.com';
const MAX_BYTES = 256 * 1024;
// The upstream API now also returns HLS manifests from this CDN. Keep an
// exact hostname allowlist; never fetch arbitrary URLs supplied by the API.
const NEW_CDN_HOST = 'strategicgrowthpartners.site';

function vidapiId(value) {
  const imdb = /^tt\d{5,12}$/i.test(String(value || '')) ? String(value).toLowerCase() : '';
  return imdb || null;
}

function vidapiMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
      (url.hostname === NEW_CDN_HOST || url.hostname === 'highperformancebrands.site' ||
        url.hostname.endsWith('.highperformancebrands.site')) &&
      /\.m3u8$/i.test(url.pathname);
  } catch { return false; }
}

async function responseJson(response) {
  if (response.status !== 200 || Number(response.headers.get('content-length') || 0) > MAX_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  let bytes = 0;
  const parts = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) return null;
      parts.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { return null; }
}

async function resolveVidapi(context, { fetchImpl = fetch,
  onDiagnostic = () => {} } = {}) {
  const imdb = vidapiId(context?.imdbId);
  if (!imdb || context?.type !== 'movie') {
    onDiagnostic({ stage: 'context', result: 'failed', reason: 'missing-movie-imdb-id' });
    return null;
  }
  const url = `${API}?imdb=${encodeURIComponent(imdb)}&type=movie`;
  try {
    // The observed API contract was tested for movies. Do not guess TV query
    // arguments until an actual Bombuj episode response is verified.
    const response = await fetchImpl(url, {
      redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json', Origin: ORIGIN, Referer: `${ORIGIN}/` }
    });
    if (response.status !== 200) {
      onDiagnostic({ stage: 'api', result: 'failed', reason: `http-${response.status}`, requestUrl: url });
      await response.body?.cancel();
      return null;
    }
    const result = await responseJson(response);
    // VidAPI currently serializes status_code as the string "200". Accept
    // both representations without treating unrelated truthy values as OK.
    if (![200, '200'].includes(result?.status_code) || !Array.isArray(result?.data?.stream_urls)) {
      onDiagnostic({ stage: 'api', result: 'failed', reason: 'invalid-response', requestUrl: url });
      return null;
    }
    const sources = [...new Set(result.data.stream_urls.filter(vidapiMediaUrl))].slice(0, 3);
    if (!sources.length) onDiagnostic({ stage: 'parse', result: 'failed', reason: 'no-allowed-hls', requestUrl: url });
    let chosen = null;
    for (const candidate of sources) {
      const inspected = await inspectHls(candidate, {
        fetchImpl, headers: { Origin: ORIGIN, Referer: `${ORIGIN}/` }, timeoutMs: 5000
      }).catch(() => null);
      if (!inspected) onDiagnostic({ stage: 'hls', result: 'failed',
        reason: 'hls-unreadable', requestUrl: candidate });
      if (!inspected) continue;
      const height = Number.parseInt(inspected.quality || '0', 10) || 0;
      if (!chosen || height > chosen.height) {
        chosen = { url: candidate, height, quality: inspected.quality || undefined };
      }
    }
    return chosen ? { url: chosen.url, type: 'hls', quality: chosen.quality,
      referer: `${ORIGIN}/`, origin: ORIGIN, ephemeral: true } : null;
  } catch (error) {
    const code = String(error?.cause?.code || error?.code || '');
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout'
      : /^(?:EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED)$/.test(code)
        ? code.toLowerCase() : 'request-failed';
    onDiagnostic({ stage: 'api', result: 'error', reason, requestUrl: url });
    return null;
  }
}

module.exports = { vidapiId, vidapiMediaUrl, resolveVidapi };
