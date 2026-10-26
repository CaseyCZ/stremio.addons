'use strict';

const { isIP } = require('node:net');
const { boundedJson } = require('./bounded-json.js');

const TOKEN_API = 'https://enc-dec.app/api/enc-vidlink';
const VIDEO_API = 'https://vidlink.pro/api/b/movie';
const PLAYER_ORIGIN = 'https://vidlink.pro';

function vidlinkId(value) {
  return /^\d{1,12}$/.test(String(value || '')) ? String(value) : null;
}

function publicMediaUrl(value, extension) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return url.protocol === 'https:' && !url.port && !url.username && !url.password &&
      host.includes('.') && isIP(host) === 0 &&
      !/\.(?:local|localhost|internal|test|invalid|example)$/.test(host) &&
      url.pathname.toLowerCase().endsWith(`.${extension}`);
  } catch { return false; }
}

function vidlinkStreams(metadata) {
  const qualities = metadata?.stream?.qualities;
  if (!qualities || typeof qualities !== 'object' || Array.isArray(qualities)) return [];
  const captions = Array.isArray(metadata?.stream?.captions) ? metadata.stream.captions.slice(0, 40) : [];
  const subtitles = captions.filter(item => publicMediaUrl(item?.url, 'vtt'))
    .map((item, index) => ({
      id: `vidlink-sub-${String(item.id || index + 1).replace(/[^a-z0-9_-]/gi, '').slice(0, 48)}`,
      url: item.url, lang: item.language || 'und'
    }));
  const seen = new Set();
  return Object.entries(qualities).slice(0, 16)
    .filter(([label, item]) => /^\d{3,4}$/.test(label) &&
      String(item?.type || '').toLowerCase() === 'mp4' && publicMediaUrl(item.url, 'mp4'))
    .sort(([a], [b]) => Number(b) - Number(a))
    .flatMap(([label, item]) => {
      if (seen.has(item.url)) return [];
      seen.add(item.url);
      return [{ url: item.url, type: 'mp4', quality: `${label}p`,
        referer: `${PLAYER_ORIGIN}/`, origin: PLAYER_ORIGIN, ephemeral: true,
        ...(subtitles.length ? { subtitles } : {}) }];
    });
}

async function resolveVidlink(context, { fetchImpl = fetch, onDiagnostic = () => {} } = {}) {
  const id = vidlinkId(context?.tmdbId);
  if (!id || context?.type !== 'movie') {
    onDiagnostic({ stage: 'context', result: 'failed',
      reason: context?.type === 'series' ? 'series-route-not-tested' : 'missing-movie-tmdb-id' });
    return null;
  }
  const tokenUrl = `${TOKEN_API}?text=${encodeURIComponent(id)}`;
  try {
    const tokenResponse = await fetchImpl(tokenUrl, {
      redirect: 'error', signal: AbortSignal.timeout(9000), headers: { Accept: 'application/json' }
    });
    if (tokenResponse.status !== 200) {
      onDiagnostic({ stage: 'token', result: 'failed', reason: `http-${tokenResponse.status}`, requestUrl: tokenUrl });
      await tokenResponse.body?.cancel().catch(() => {});
      return null;
    }
    const encrypted = await boundedJson(tokenResponse);
    const token = typeof encrypted?.result === 'string' ? encrypted.result :
      typeof encrypted?.data === 'string' ? encrypted.data : encrypted?.token;
    if (typeof token !== 'string' || token.length < 10 || token.length > 4096 || /[\r\n]/.test(token)) {
      onDiagnostic({ stage: 'token', result: 'failed', reason: 'invalid-token-response', requestUrl: tokenUrl });
      return null;
    }
    const requestUrl = `${VIDEO_API}/${encodeURIComponent(token)}`;
    const response = await fetchImpl(requestUrl, {
      redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Accept: 'application/json', Origin: PLAYER_ORIGIN, Referer: `${PLAYER_ORIGIN}/` }
    });
    if (response.status !== 200) {
      onDiagnostic({ stage: 'api', result: 'failed', reason: `http-${response.status}`, requestUrl });
      await response.body?.cancel().catch(() => {});
      return null;
    }
    const result = await boundedJson(response);
    const streams = vidlinkStreams(result);
    if (!streams.length) {
      onDiagnostic({ stage: 'parse', result: 'failed', reason: 'no-public-mp4', requestUrl });
      return null;
    }
    for (const item of streams) {
      onDiagnostic({ stage: 'parse', result: 'found', requestUrl,
        mediaUrl: item.url, quality: item.quality });
    }
    return streams;
  } catch (error) {
    onDiagnostic({ stage: 'api', result: 'error', requestUrl: tokenUrl,
      reason: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' :
        String(error?.cause?.code || error?.code || 'request-failed').toLowerCase().slice(0, 60) });
    return null;
  }
}

module.exports = { vidlinkId, publicMediaUrl, vidlinkStreams, resolveVidlink };
