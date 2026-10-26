'use strict';

const { createDecipheriv } = require('node:crypto');
const { isIP } = require('node:net');
const { boundedJson } = require('./bounded-json.js');

const API_ORIGIN = 'https://bysekoze.com';
const MEDIA_ORIGIN = 'https://n1mwq.org';

function byseEmbedId(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.port || url.username || url.password ||
        !['bysekoze.com', 'www.bysekoze.com', 'byse.sx', 'www.byse.sx'].includes(url.hostname.toLowerCase())) return null;
    return url.pathname.match(/^\/(?:e|v)\/([a-z0-9]{6,32})\/?$/i)?.[1] || null;
  } catch { return null; }
}

function publicHls(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
      host.includes('.') && isIP(host) === 0 &&
      !/\.(?:local|localhost|internal|test|invalid|example)$/.test(host) &&
      /\.m3u8$/i.test(url.pathname);
  } catch { return false; }
}

function decodePart(raw, maxLength = 512) {
  if (typeof raw !== 'string' || raw.length > maxLength || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) return null;
  const decoded = Buffer.from(raw, 'base64url');
  return decoded.length ? decoded : null;
}

function decryptBysePlayback(playback) {
  try {
    if (!playback || !Array.isArray(playback.key_parts) || playback.key_parts.length !== 30) return null;
    const version = Number(playback.version);
    if (!Number.isInteger(version) || version < 1 || version > 30) return null;
    // 1-based positions from the tested BYSE player: [version, 31-version].
    // The version changes between requests; never hard-code yesterday's value.
    const first = decodePart(playback.key_parts[version - 1]);
    const second = decodePart(playback.key_parts[30 - version]);
    const iv = decodePart(playback.iv);
    const payload = decodePart(playback.payload, 128 * 1024);
    if (!first || !second || !iv || iv.length !== 12 || !payload || payload.length <= 16) return null;
    const key = Buffer.concat([first, second]);
    const algorithm = String(playback.algorithm || '').toLowerCase();
    if (!['aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm'].includes(algorithm) ||
        key.length * 8 !== Number(algorithm.match(/\d+/)?.[0])) return null;
    const decipher = createDecipheriv(algorithm, key, iv);
    decipher.setAuthTag(payload.subarray(-16));
    const plain = Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]);
    const parsed = JSON.parse(plain.toString('utf8'));
    return parsed?.config?.sources ? parsed.config : parsed;
  } catch { return null; }
}

function byseSources(config) {
  if (!Array.isArray(config?.sources)) return [];
  return config.sources.slice(0, 20)
    .filter(source => typeof source?.url === 'string' && publicHls(source.url))
    .map(source => ({
      url: source.url, type: 'hls',
      quality: String(source.label || source.quality || (source.height ? `${source.height}p` : 'HLS')).slice(0, 20),
      height: Number(source.height) || 0,
      referer: `${MEDIA_ORIGIN}/`, origin: MEDIA_ORIGIN, ephemeral: true
    }))
    .sort((a, b) => b.height - a.height);
}

async function resolveByse(embed, { fetchImpl = fetch, onDiagnostic = () => {} } = {}) {
  const id = byseEmbedId(embed);
  if (!id) {
    onDiagnostic({ stage: 'context', result: 'failed', reason: 'unsupported-byse-embed', requestUrl: embed });
    return null;
  }
  const requestUrl = `${API_ORIGIN}/api/videos/${encodeURIComponent(id)}`;
  try {
    const response = await fetchImpl(requestUrl, {
      redirect: 'error', signal: AbortSignal.timeout(9000),
      headers: { Accept: 'application/json', Referer: `${API_ORIGIN}/`, Origin: API_ORIGIN }
    });
    if (response.status !== 200) {
      onDiagnostic({ stage: 'api', result: 'failed', reason: `http-${response.status}`, requestUrl });
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const metadata = await boundedJson(response);
    const config = decryptBysePlayback(metadata?.playback);
    if (!config) {
      onDiagnostic({ stage: 'decrypt', result: 'failed', reason: 'invalid-authenticated-payload', requestUrl });
      return null;
    }
    const sources = byseSources(config);
    if (!sources.length) {
      onDiagnostic({ stage: 'parse', result: 'failed', reason: 'no-public-hls', requestUrl });
      return null;
    }
    for (const direct of sources) {
      onDiagnostic({ stage: 'parse', result: 'found', requestUrl, mediaUrl: direct.url, quality: direct.quality });
    }
    return sources;
  } catch (error) {
    onDiagnostic({ stage: 'api', result: 'error', requestUrl,
      reason: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' :
        String(error?.cause?.code || error?.code || 'request-failed').toLowerCase().slice(0, 60) });
    return null;
  }
}

module.exports = { byseEmbedId, publicHls, decryptBysePlayback, byseSources, resolveByse };
