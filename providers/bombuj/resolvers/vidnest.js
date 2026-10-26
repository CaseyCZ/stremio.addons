'use strict';

const { inspectHls } = require('../stream-quality.js');

const PLAYER = 'https://vidnest.fun';
const API = 'https://new.vidnest.fun';
const ALPHABET = 'RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/=';
const BACKENDS = ['moviesapi', 'allmovies', 'vidlink', 'videasy'];
const MAX_JSON_BYTES = 256 * 1024;

function vidnestId(value) {
  if (/^\d{1,12}$/.test(String(value || ''))) return String(value);
  return null;
}

function vidnestMediaUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
      url.hostname === 'pwcloud.animanga.fun' && /\.m3u8$/i.test(url.pathname);
  } catch { return false; }
}

function decodeAlphabet(encoded) {
  if (typeof encoded !== 'string' || encoded.length > MAX_JSON_BYTES ||
      !encoded.length || !/^[A-Za-z0-9+/=]+$/.test(encoded)) return null;
  const lookup = new Map([...ALPHABET].map((char, index) => [char, index]));
  const bytes = [];
  for (let i = 0; i < encoded.length; i += 4) {
    const part = encoded.slice(i, i + 4).padEnd(4, '=');
    const vals = [...part].map(char => lookup.get(char));
    if (vals.some(value => value === undefined) || vals[0] === 64 || vals[1] === 64) return null;
    bytes.push((vals[0] << 2) | (vals[1] >> 4));
    if (vals[2] !== 64) bytes.push(((vals[1] & 15) << 4) | (vals[2] >> 2));
    if (vals[3] !== 64) bytes.push(((vals[2] & 3) << 6) | vals[3]);
  }
  try { return JSON.parse(Buffer.from(bytes).toString('utf8')); }
  catch { return null; }
}

function streamCandidates(data) {
  if (typeof data === 'string') {
    try { return streamCandidates(JSON.parse(data)); }
    catch { return []; }
  }
  if (!data || typeof data !== 'object') return [];
  const found = [];
  for (const group of [data.sources, data.streams, data?.data?.downloads]) {
    if (!Array.isArray(group)) continue;
    for (const item of group.slice(0, 30)) {
      if (typeof item?.url === 'string') found.push(item.url);
    }
  }
  if (typeof data.url === 'string') found.push(data.url);
  return [...new Set(found)].filter(vidnestMediaUrl);
}

async function limitedJson(url, fetchImpl, onDiagnostic, backend) {
  const response = await fetchImpl(url, {
    redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { Accept: 'application/json, */*', Origin: PLAYER, Referer: `${PLAYER}/` }
  });
  if (response.status !== 200) {
    onDiagnostic({ stage: 'api', backend, result: 'failed',
      reason: `http-${response.status}`, requestUrl: url });
    await response.body?.cancel();
    return null;
  }
  if (Number(response.headers.get('content-length') || 0) > MAX_JSON_BYTES) {
    onDiagnostic({ stage: 'api', backend, result: 'failed', reason: 'response-too-large', requestUrl: url });
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) {
    onDiagnostic({ stage: 'api', backend, result: 'failed', reason: 'response-empty', requestUrl: url });
    return null;
  }
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_JSON_BYTES) {
        onDiagnostic({ stage: 'api', backend, result: 'failed', reason: 'response-too-large', requestUrl: url });
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch {
    onDiagnostic({ stage: 'api', backend, result: 'failed', reason: 'invalid-json', requestUrl: url });
    return null;
  }
}

async function resolveVidnest(context, { fetchImpl = fetch, backends = BACKENDS,
  onDiagnostic = () => {} } = {}) {
  const id = vidnestId(context?.tmdbId);
  if (!id || !['movie', 'series'].includes(context?.type)) {
    onDiagnostic({ stage: 'context', result: 'failed', reason: 'missing-tmdb-id' });
    return null;
  }
  const season = Number(context.season), episode = Number(context.episode);
  if (context.type === 'series' && !(Number.isInteger(season) && season > 0 &&
      season < 100 && Number.isInteger(episode) && episode > 0 && episode < 1000)) return null;
  const path = context.type === 'movie' ? `movie/${id}` : `tv/${id}/${season}/${episode}`;

  // Each request is bounded. Fail closed on TLS errors: never disable SSL
  // verification even if third-party resolver examples do so.
  for (const backend of backends.filter(name => BACKENDS.includes(name)).slice(0, BACKENDS.length)) {
    const requestUrl = `${API}/${backend}/${path}`;
    try {
      const result = await limitedJson(requestUrl, fetchImpl, onDiagnostic, backend);
      if (!result) continue;
      const payload = result.encrypted ? decodeAlphabet(result.data) : result;
      const candidates = streamCandidates(payload).slice(0, 3);
      if (!candidates.length) onDiagnostic({ stage: 'parse', backend,
        result: 'failed', reason: 'no-allowed-hls', requestUrl });
      for (const url of candidates) {
        const hls = await inspectHls(url, {
          fetchImpl, headers: { Referer: `${PLAYER}/`, Origin: PLAYER }, timeoutMs: 5000
        }).catch(() => null);
        if (!hls) onDiagnostic({ stage: 'hls', backend, result: 'failed',
          reason: 'hls-unreadable', requestUrl: url });
        if (hls) return { url, type: 'hls', quality: hls.quality || undefined,
          referer: `${PLAYER}/`, origin: PLAYER, ephemeral: true };
      }
    } catch (error) {
      const code = String(error?.cause?.code || error?.code || '');
      const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout'
        : /^(?:EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED)$/.test(code)
          ? code.toLowerCase() : 'request-failed';
      onDiagnostic({ stage: 'api', backend, result: 'error', reason, requestUrl });
      // Another backend can still supply a working source.
    }
  }
  return null;
}

module.exports = { vidnestId, vidnestMediaUrl, decodeAlphabet, streamCandidates, resolveVidnest };
