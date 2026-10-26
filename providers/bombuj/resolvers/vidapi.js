'use strict';

const { inspectHls } = require('../stream-quality.js');
const { isIP } = require('node:net');

const API = 'https://streamdata.vaplayer.ru/api.php';
const ORIGIN = 'https://nextgencloudfabric.com';
const MAX_BYTES = 256 * 1024;
// These CDNs were tested for server-side HLS quality inspection. Other public
// CDN links received from VidAPI are still returned directly to Stremio, but
// we never fetch an unknown host from our Oracle server.
const NEW_CDN_HOST = 'strategicgrowthpartners.site';

function vidapiId(value) {
  const imdb = /^tt\d{5,12}$/i.test(String(value || '')) ? String(value).toLowerCase() : '';
  return imdb || null;
}

function vidapiMediaUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password ||
        !/\.(?:m3u8|mp4)$/i.test(url.pathname)) return false;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!host.includes('.') || host === 'localhost' ||
        /\.(?:localhost|local|internal|test|invalid|example)$/.test(host)) return false;
    // Avoid passing private/loopback IP targets to a client as playable media.
    if (isIP(host) !== 0) return false;
    return true;
  } catch { return false; }
}

function vidapiInspectedCdn(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === NEW_CDN_HOST || host === 'highperformancebrands.site' ||
      host.endsWith('.highperformancebrands.site');
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
    // The source decides its CDN hostname. Do not silently discard a new CDN
    // merely because it has not appeared in a previous resolver test.
    const sources = [...new Set(result.data.stream_urls.filter(vidapiMediaUrl))].slice(0, 16);
    if (!sources.length) onDiagnostic({ stage: 'parse', result: 'failed', reason: 'no-public-media-url', requestUrl: url });
    let chosen = null;
    for (const candidate of sources) {
      const type = /\.mp4$/i.test(new URL(candidate).pathname) ? 'mp4' : 'hls';
      // Even a known CDN's inspection may fail transiently. The link is not
      // removed: the player can try it and the original embed stays available.
      if (!chosen) chosen = { url: candidate, type, height: 0 };
      // An unknown CDN can be handed to Stremio, but MUST NOT be probed from
      // the server (untrusted upstream URLs can point to internal networks).
      if (!vidapiInspectedCdn(candidate) || type === 'mp4') {
        onDiagnostic({ stage: 'media', result: 'direct-unverified', mediaUrl: candidate,
          reason: 'cdn-not-probed-from-server' });
        continue;
      }
      const inspected = await inspectHls(candidate, {
        fetchImpl, headers: { Origin: ORIGIN, Referer: `${ORIGIN}/` }, timeoutMs: 5000
      }).catch(() => null);
      if (!inspected) onDiagnostic({ stage: 'hls', result: 'failed',
        reason: 'hls-unreadable', requestUrl: candidate });
      if (!inspected) continue;
      const height = Number.parseInt(inspected.quality || '0', 10) || 0;
      if (!chosen || height > chosen.height) {
        chosen = { url: candidate, type, height, quality: inspected.quality || undefined };
      }
    }
    return chosen ? { url: chosen.url, type: chosen.type, quality: chosen.quality,
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
