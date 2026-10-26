'use strict';

const http = require('http');
const { qualityLabel } = require('./stream-quality.js');
const { subtitleTracks, audioLabel, subtitleLabel, providerLabel } = require('./stream-display.js');
const { testUnblockAllowed, testDirectVoeAllowed } = require('./embed-test-policy.js');

const PUBLIC_PORT = Number(process.env.PORT || 7004);
const MIDDLE_PORT = Number(process.env.BOMBUJ_MIDDLE_PORT || (PUBLIC_PORT + 1));
const INTERNAL_PORT = Number(process.env.BOMBUJ_INTERNAL_PORT || (PUBLIC_PORT + 2));
const VERSION = require('./package.json').version;
const nativeFetch = global.fetch.bind(global);
const subtitleCache = new Map();

function rawUrlOf(input) {
  return typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || input);
}

function keepExternalFallback(input, init = {}) {
  try {
    const parsed = new URL(rawUrlOf(input));
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    if (/\.(?:mp4|m3u8|webm|m4v|mov|ts)$/.test(pathname)) return false;
    const provider = /(^|\.)voe(?:2)?\./i.test(host) || /mixdrop|miixdrop|miiiixdrop/i.test(host);
    if (!provider) return false;
    const accept = String(init?.headers?.Accept || init?.headers?.accept || '');
    return !accept || /text\/html|application\/xhtml/i.test(accept);
  } catch {
    return false;
  }
}

// VOE/Mixdrop HTML embeds often resolve to media URLs that iOS Stremio rejects.
// Let index.js fall back to the original external player instead. Real direct
// media URLs (.mp4/.m3u8/...) still pass through normally.
global.fetch = async function preferWebFallback(input, init = {}) {
  if (process.env.BOMBUJ_SHOW_ALL_SOURCES !== '1' &&
      keepExternalFallback(input, init) &&
      !testUnblockAllowed(rawUrlOf(input)) && !testDirectVoeAllowed(rawUrlOf(input))) {
    throw new Error('Keep original external player fallback');
  }
  return nativeFetch(input, init);
};

// Run the existing resilient Bombuj layer one port behind this public layer.
process.env.PORT = String(MIDDLE_PORT);
process.env.BOMBUJ_INTERNAL_PORT = String(INTERNAL_PORT);
require('./bootstrap.js');

function uniqueSubtitles(streams) {
  return subtitleTracks(streams);
}


function displayDirect(stream) {
  const quality = qualityLabel(stream);
  const provider = providerLabel(stream);
  return {
    ...stream,
    name: `Bombuj • ${quality}`,
    title: `🎧 ${audioLabel(stream)}\n💬 ${subtitleLabel(stream)}\n🎬 ${quality}`,
    description: undefined,
    externalUrl: undefined
  };
}

function streamKey(type, id) {
  return `${String(type || '')}:${String(id || '')}`;
}

function transformStreams(type, id, payload) {
  const discovered = Array.isArray(payload?.streams) ? payload.streams : [];
  const subtitles = uniqueSubtitles(discovered);
  subtitleCache.set(streamKey(type, id), { expiresAt: Date.now() + 20 * 60 * 1000, subtitles });

  const direct = discovered
    .filter((stream) => stream?.url && /^https?:\/\//i.test(String(stream.url)))
    .map(displayDirect);
  console.log(`[front] ${type}/${id}: direct=${direct.length} omitted-web=${discovered.length - direct.length} discovered=${discovered.length} subtitles=${subtitles.length}`);
  return { streams: direct };
}

function parseResource(pathname, resource) {
  const match = pathname.match(new RegExp(`^/${resource}/(movie|series)/(.+)\\.json$`, 'i'));
  return match ? { type: match[1].toLowerCase(), id: decodeURIComponent(match[2]) } : null;
}

async function fetchInternal(pathname) {
  const response = await nativeFetch(`http://127.0.0.1:${INTERNAL_PORT}${pathname}`, {
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { response, text, json };
}

function manifestPayload(payload) {
  const resources = Array.isArray(payload?.resources) ? [...payload.resources] : [];
  if (!resources.some((resource) => resource === 'subtitles' || resource?.name === 'subtitles')) {
    resources.push({ name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt'] });
  }
  return { ...payload, version: VERSION, resources };
}

async function subtitlesFor(type, id) {
  const key = streamKey(type, id);
  const cached = subtitleCache.get(key);
  if (cached && cached.expiresAt >= Date.now()) return cached.subtitles;
  const path = `/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
  const result = await fetchInternal(path).catch(() => null);
  if (!result?.json) return [];
  transformStreams(type, id, result.json);
  return subtitleCache.get(key)?.subtitles || [];
}

async function handle(req, res) {
  try {
    const incoming = new URL(req.url || '/', `http://127.0.0.1:${PUBLIC_PORT}`);
    const subtitleRequest = parseResource(incoming.pathname, 'subtitles');
    if (subtitleRequest) {
      const subtitles = await subtitlesFor(subtitleRequest.type, subtitleRequest.id);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store'
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(JSON.stringify({ subtitles }));
    }

    const internal = await fetchInternal(`${incoming.pathname}${incoming.search}`);
    let body = internal.text;
    const contentType = internal.response.headers.get('content-type') || 'application/json; charset=utf-8';

    if (incoming.pathname === '/manifest.json' && internal.json) {
      body = JSON.stringify(manifestPayload(internal.json));
    } else {
      const streamRequest = parseResource(incoming.pathname, 'stream');
      if (streamRequest && internal.json) {
        body = JSON.stringify(transformStreams(streamRequest.type, streamRequest.id, internal.json));
      }
    }

    res.writeHead(internal.response.status, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') return res.end();
    res.end(body);
  } catch (error) {
    console.error('[front]', error?.stack || error);
    res.writeHead(502, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ error: 'Bombuj addon unavailable' }));
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS'
    });
    return res.end();
  }
  handle(req, res);
});

server.listen(PUBLIC_PORT, '127.0.0.1', () => {
  console.log(`[front] Bombuj public endpoint on 127.0.0.1:${PUBLIC_PORT}; raw addon ${INTERNAL_PORT}`);
});
