'use strict';

const { inspectHls } = require('../stream-quality.js');
const { languageCode } = require('../group-labels.js');

const EMBED_HOSTS = new Set(['vidara.to', 'vxcagb.com']);
const MAX_JSON_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 8000;

function vidaraEmbed(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !EMBED_HOSTS.has(url.hostname)) return null;
    const code = /^\/e\/([A-Za-z0-9]+)(?:-\d{10})?\/?$/.exec(url.pathname)?.[1];
    return code ? { url: url.href, origin: url.origin, filecode: code } : null;
  } catch {
    return null;
  }
}

function vidaraCdnUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      /(?:^|\.)(?:97bf1\.com|s1q2105\.com)$/i.test(url.hostname) &&
      /^\/hls\/[A-Za-z0-9_-]+\/master\.m3u8$/.test(url.pathname);
  } catch { return false; }
}

async function readJsonLimited(response) {
  if (response.status !== 200) {
    await response.body?.cancel();
    return null;
  }
  if (Number(response.headers?.get('content-length') || 0) > MAX_JSON_BYTES) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body?.getReader) return null;
  const reader = response.body.getReader();
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JSON_BYTES) return null;
      parts.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { return null; }
}

function subtitleEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  return entries.slice(0, 40).flatMap((track, index) => {
    const raw = track?.file || track?.url;
    if (typeof raw !== 'string') return [];
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
          !/\.(?:vtt|srt)(?:$|[?#])/i.test(url.href) || seen.has(url.href)) return [];
      seen.add(url.href);
      return [{ id: `bombuj-vidara-${index + 1}`, url: url.href,
        lang: languageCode(track.language || track.lang || track.label) }];
    } catch { return []; }
  });
}

async function resolveVidara(embedUrl, { fetchImpl = fetch } = {}) {
  const embed = vidaraEmbed(embedUrl);
  if (!embed) return null;
  const response = await fetchImpl(`${embed.origin}/api/stream`, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: embed.origin,
      Referer: embed.url
    },
    body: JSON.stringify({ filecode: embed.filecode, device: 'web' })
  });
  const data = await readJsonLimited(response);
  if (!vidaraCdnUrl(data?.streaming_url)) return null;

  // Probe the master playlist on the server, but never tunnel video through
  // Oracle. IP-bound signed URLs still require client-side playback tests.
  const hls = await inspectHls(data.streaming_url, {
    fetchImpl, headers: { Referer: embed.url, Origin: embed.origin },
    timeoutMs: 5000
  }).catch(() => null);
  if (!hls) return null;

  return { url: data.streaming_url, type: 'hls', quality: hls.quality || undefined,
    referer: embed.url, origin: embed.origin,
    subtitles: subtitleEntries(data.subtitles), ephemeral: true };
}

module.exports = { vidaraEmbed, vidaraCdnUrl, subtitleEntries, resolveVidara };
