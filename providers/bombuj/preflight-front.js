'use strict';

const http = require('http');
const { confirmedStremioEmbedFailure } = require('./provider-compat.js');
const { validStreamtapeEmbed } = require('./streamtape-link.js');

const PUBLIC_PORT = Number(process.env.PORT || 7004);
const INNER_PORT = Number(process.env.BOMBUJ_PREFLIGHT_INNER_PORT || (PUBLIC_PORT + 1));
const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1';
const PREFLIGHT_TIMEOUT_MS = 5000;
const PREFLIGHT_TTL_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 192 * 1024;
const nativeFetch = global.fetch.bind(global);
const preflightCache = new Map();

function parseStreamPath(pathname) {
  const match = String(pathname || '').match(/^\/stream\/(movie|series)\/(.+)\.json$/i);
  return match ? { type: match[1].toLowerCase(), id: decodeURIComponent(match[2]) } : null;
}

function providerName(stream) {
  const named = String(stream?.name || '').replace(/^Bombuj\s*•\s*/i, '').trim();
  if (named) return named;
  try {
    return new URL(String(stream?.externalUrl || stream?.url || '')).hostname.toLowerCase();
  } catch {
    return stream?.url ? 'direct' : 'unknown';
  }
}

function cachedPreflight(url) {
  const item = preflightCache.get(url);
  if (!item || item.expiresAt < Date.now()) {
    preflightCache.delete(url);
    return null;
  }
  return item.value;
}

function savePreflight(url, value) {
  preflightCache.set(url, { value, expiresAt: Date.now() + PREFLIGHT_TTL_MS });
  return value;
}

async function readBodyPrefix(response, maxBytes = MAX_BODY_BYTES) {
  if (!response.body?.getReader) {
    const text = await response.text().catch(() => '');
    return text.slice(0, maxBytes);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (out.length >= maxBytes) break;
    }
    out += decoder.decode();
  } finally {
    reader.cancel().catch(() => {});
  }
  return out.slice(0, maxBytes);
}

function normalizeBody(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#0?39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

function explicitFailureReason(bodyText) {
  const text = normalizeBody(bodyText);
  if (!text) return null;

  const patterns = [
    [/we couldn'?t find (?:this )?content|could not find (?:this )?content/, 'content-not-found'],
    [/content (?:was )?not found|content unavailable/, 'content-not-found'],
    [/video (?:was )?not found|video nenalezeno|video nebylo nalezeno/, 'video-not-found'],
    [/file (?:was )?(?:deleted|removed|not found)|this file (?:was )?(?:deleted|removed)/, 'file-not-found'],
    [/embed is domain protected|domain protected/, 'domain-protected'],
    [/domain (?:is )?not authorized|unauthorized domain|not authorized (?:for|on) this domain/, 'domain-not-authorized'],
    [/embedding from (?:web\.stremio\.com|this domain) is not allowed|vkládání je na tomto webu zablokováno/, 'embedding-domain-not-authorized'],
    [/this video is unavailable|video is unavailable|video unavailable/, 'video-unavailable'],
    [/dostupn[ýy] len pre vip|available only for vip|vip gate/, 'vip-gate'],
    [/player (?:is )?unavailable|playback unavailable/, 'player-unavailable']
  ];

  for (const [pattern, reason] of patterns) {
    if (pattern.test(text)) return reason;
  }
  return null;
}

function frameRestriction(response) {
  const xfo = String(response.headers.get('x-frame-options') || '').trim().toLowerCase();
  const csp = String(response.headers.get('content-security-policy') || '').toLowerCase();
  if (xfo === 'deny' || xfo === 'sameorigin') return `x-frame-options:${xfo}`;
  if (/frame-ancestors\s+['"]?none['"]?/i.test(csp)) return 'csp:frame-ancestors-none';
  return null;
}

async function preflightExternal(url, neutralReferrer = false) {
  // Referrer-sensitive players must be checked using the same referrer
  // policy that will be used when the viewer follows the redirect.
  const cacheKey = (neutralReferrer ? 'neutral:' : 'standard:') + url;
  const cached = cachedPreflight(cacheKey);
  if (cached) return cached;

  try {
    const response = await nativeFetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'cs-CZ,cs;q=0.9,en;q=0.8',
        ...(neutralReferrer ? {} : { Referer: 'https://web.stremio.com/' })
      }
    });

    const status = response.status;
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const finalUrl = response.url || url;

    if (status === 404 || status === 410 || status === 451) {
      return savePreflight(cacheKey, { state: 'failed', reason: `http-${status}`, status, finalUrl });
    }

    if (status >= 500) {
      return savePreflight(cacheKey, { state: 'unknown', reason: `http-${status}`, status, finalUrl });
    }

    if (/^(?:video|audio)\//i.test(contentType) || /application\/(?:vnd\.apple\.mpegurl|x-mpegurl)/i.test(contentType)) {
      return savePreflight(cacheKey, { state: 'ok', reason: 'media-response', status, finalUrl });
    }

    const body = await readBodyPrefix(response);
    const failure = explicitFailureReason(body);
    if (failure) {
      return savePreflight(cacheKey, { state: 'failed', reason: failure, status, finalUrl });
    }

    const framing = frameRestriction(response);
    if (framing) {
      // Header restrictions alone are advisory here: some Stremio clients open
      // externalUrl in a top-level webview instead of an iframe. Keep the source,
      // but log the restriction so we can correlate it with real-device tests.
      return savePreflight(cacheKey, { state: 'unknown', reason: framing, status, finalUrl });
    }

    if (!response.ok) {
      return savePreflight(cacheKey, { state: 'unknown', reason: `http-${status}`, status, finalUrl });
    }

    if (contentType.includes('text/html') || body) {
      return savePreflight(cacheKey, { state: 'unknown', reason: 'html-reachable-playback-unverified', status, finalUrl });
    }

    return savePreflight(cacheKey, { state: 'unknown', reason: 'empty-response', status, finalUrl });
  } catch (error) {
    const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError'
      ? 'timeout'
      : `fetch-error:${String(error?.message || error).slice(0, 120)}`;
    return savePreflight(cacheKey, { state: 'unknown', reason, status: 0, finalUrl: url });
  }
}

async function preflightStreams(payload, type, id) {
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  const results = await Promise.all(streams.map(async (stream) => {
    if (stream?.url && /^https?:\/\//i.test(String(stream.url))) {
      return { stream, state: 'ok', reason: 'direct-media', provider: providerName(stream) };
    }
    if (!stream?.externalUrl || !/^https?:\/\//i.test(String(stream.externalUrl))) {
      return { stream, state: 'unknown', reason: 'no-http-url', provider: providerName(stream) };
    }
    // Byse's owner explicitly rejects web.stremio.com. A server-side HTTP
    // 200 cannot validate an iframe/player that the browser is forbidden to load.
    const incompatibility = confirmedStremioEmbedFailure(stream.externalUrl);
    if (incompatibility) {
      return { stream, state: 'failed', reason: incompatibility, provider: providerName(stream) };
    }
    const originalUrl = String(stream.externalUrl);
    if (validStreamtapeEmbed(originalUrl)) {
      // A plain Stremio Referer produces a false HTTP 404 for this
      // Streamtape embed; a neutral request does not. Only use the
      // neutral check to avoid a false negative. Always return the
      // provider's ORIGINAL URL. Never proxy or redirect playback.
      const check = await preflightExternal(originalUrl, true);
      return {
        stream,
        provider: providerName(stream),
        ...check,
        // HTTP reachability is not proof of Stremio iOS playback.
        state: check.state === 'ok' ? 'unknown' : check.state,
        reason: 'direct-streamtape-referrer-uncertain:' + check.reason
      };
    }
    const check = await preflightExternal(originalUrl);
    return { stream, provider: providerName(stream), ...check };
  }));

  const kept = results.filter((item) => item.state !== 'failed').map((item) => item.stream);
  for (const item of results) {
    console.log(`[preflight] ${type}/${id} provider=${JSON.stringify(item.provider)} state=${item.state} reason=${item.reason}${item.status ? ` status=${item.status}` : ''}`);
  }
  console.log(`[preflight] ${type}/${id}: kept=${kept.length} removed=${streams.length - kept.length} discovered=${streams.length}`);
  return { ...payload, streams: kept };
}

async function fetchInner(pathname) {
  const response = await nativeFetch(`http://127.0.0.1:${INNER_PORT}${pathname}`, {
    signal: AbortSignal.timeout(105000)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { response, text, json };
}

async function handle(req, res) {
  try {
    const incoming = new URL(req.url || '/', `http://127.0.0.1:${PUBLIC_PORT}`);
    const inner = await fetchInner(`${incoming.pathname}${incoming.search}`);
    let body = inner.text;
    const streamRequest = parseStreamPath(incoming.pathname);
    if (streamRequest && inner.json) {
      body = JSON.stringify(await preflightStreams(inner.json, streamRequest.type, streamRequest.id));
    }

    res.writeHead(inner.response.status, {
      'Content-Type': inner.response.headers.get('content-type') || 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    if (req.method === 'HEAD') return res.end();
    res.end(body);
  } catch (error) {
    console.error('[preflight]', error?.stack || error);
    res.writeHead(502, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({ error: 'Bombuj preflight endpoint unavailable' }));
  }
}

// Run the dynamic Bombuj layer one port behind this final preflight layer.
process.env.PORT = String(INNER_PORT);
require('./filtered-front.js');

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
  console.log(`[preflight] Bombuj final endpoint on 127.0.0.1:${PUBLIC_PORT} -> dynamic ${INNER_PORT}`);
});
