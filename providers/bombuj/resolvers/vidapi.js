'use strict';

const { inspectHls } = require('../stream-quality.js');

const API = 'https://streamdata.vaplayer.ru/api.php';
const ORIGIN = 'https://nextgencloudfabric.com';
const MAX_BYTES = 256 * 1024;

function vidapiId(value) {
  const imdb = /^tt\d{5,12}$/i.test(String(value || '')) ? String(value).toLowerCase() : '';
  return imdb || null;
}

function vidapiMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
      /(?:^|\.)highperformancebrands\.site$/i.test(url.hostname) &&
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

async function resolveVidapi(context, { fetchImpl = fetch } = {}) {
  const imdb = vidapiId(context?.imdbId);
  if (!imdb || context?.type !== 'movie') return null;
  try {
    // The observed API contract was tested for movies. Do not guess TV query
    // arguments until an actual Bombuj episode response is verified.
    const url = `${API}?imdb=${encodeURIComponent(imdb)}&type=movie`;
    const response = await fetchImpl(url, {
      redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json', Origin: ORIGIN, Referer: `${ORIGIN}/` }
    });
    const result = await responseJson(response);
    if (result?.status_code !== 200 || !Array.isArray(result?.data?.stream_urls)) return null;
    const sources = [...new Set(result.data.stream_urls.filter(vidapiMediaUrl))].slice(0, 3);
    let chosen = null;
    for (const candidate of sources) {
      const inspected = await inspectHls(candidate, {
        fetchImpl, headers: { Origin: ORIGIN, Referer: `${ORIGIN}/` }, timeoutMs: 5000
      }).catch(() => null);
      if (!inspected) continue;
      const height = Number.parseInt(inspected.quality || '0', 10) || 0;
      if (!chosen || height > chosen.height) {
        chosen = { url: candidate, height, quality: inspected.quality || undefined };
      }
    }
    return chosen ? { url: chosen.url, type: 'hls', quality: chosen.quality,
      referer: `${ORIGIN}/`, origin: ORIGIN, ephemeral: true } : null;
  } catch { return null; }
}

module.exports = { vidapiId, vidapiMediaUrl, resolveVidapi };
