'use strict';

const { validStreamtapeEmbed } = require('../streamtape-link.js');

const BASE = 'https://streamtape.com';
const MAX_HTML_BYTES = 512 * 1024;

function isStreamtapeGate(raw, expectedId) {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port &&
      ['streamtape.com', 'www.streamtape.com', 'streamtape.to', 'www.streamtape.to'].includes(parsed.hostname) &&
      parsed.pathname === '/get_video' && parsed.searchParams.get('id') === expectedId &&
      /^[\w-]{3,300}$/.test(parsed.searchParams.get('token') || '');
  } catch { return false; }
}

function isStreamtapeCdn(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'tapecontent.net' || url.hostname.endsWith('.tapecontent.net'));
  } catch { return false; }
}

async function boundedText(response) {
  if (response.status !== 200 || Number(response.headers.get('content-length') || 0) > MAX_HTML_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const parts = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_HTML_BYTES) return null;
      parts.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts).toString('utf8');
}

function staticStringExpression(expression) {
  // Only evaluate literal concatenation/substring, never execute upstream JS.
  const token = /\(?\s*(['"])([^'"\\]{0,1000})\1\s*\)?(?:\.substring\((\d{1,4})(?:\s*,\s*(\d{1,4}))?\))?/g;
  const matched = [...String(expression || '').matchAll(token)];
  if (!matched.length || matched.length > 20 ||
      expression.replace(token, '').replace(/[\s+()]/g, '') !== '') return null;
  return matched.map(piece => {
    const raw = piece[2];
    return piece[3] === undefined ? raw : raw.substring(Number(piece[3]),
      piece[4] === undefined ? undefined : Number(piece[4]));
  }).join('');
}

function extractGate(html, id) {
  const text = String(html || '').replace(/&amp;/g, '&').replace(/&#38;/g, '&');
  const assignment = text.match(/document\.getElementById\(['"]norobotlink['"]\)\.innerHTML\s*=\s*([^;]{1,3500});/i);
  const assembled = assignment ? staticStringExpression(assignment[1]) : null;
  if (assembled) {
    const candidate = assembled.startsWith('//') ? 'https:' + assembled : assembled;
    if (isStreamtapeGate(candidate, id)) return candidate;
  }
  // Some embeds place the stable ID prefix in a hidden div and the signed
  // token in a separate obfuscated player assignment.
  const div = text.match(/<div\b[^>]*\bid=['"]ideoooolink['"][^>]*>([^<]{1,2000})<\/div>/i)?.[1] || '';
  const prefix = div.match(/(?:https?:)?\/\/streamtape\.(?:com|to)\/get_video\?[^\s'"<>]+/i)?.[0];
  const token = assembled?.match(/[?&]token=([\w-]{3,300})/)?.[1] ||
    assignment?.[1]?.match(/token=([\w-]{3,300})/)?.[1];
  if (!prefix || !token) return null;
  try {
    const gate = new URL(prefix.startsWith('//') ? 'https:' + prefix : prefix);
    gate.searchParams.set('token', token);
    gate.searchParams.set('stream', '1');
    return isStreamtapeGate(gate.href, id) ? gate.href : null;
  } catch { return null; }
}

async function validMp4Range(url, pageUrl, fetchImpl) {
  const response = await fetchImpl(url, {
    redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { Range: 'bytes=0-31', Referer: pageUrl, 'User-Agent': 'Mozilla/5.0' }
  });
  if (![200, 206].includes(response.status)) {
    await response.body?.cancel();
    return false;
  }
  const reader = response.body?.getReader();
  if (!reader) return false;
  try {
    const { done, value } = await reader.read();
    const bytes = done ? Buffer.alloc(0) : Buffer.from(value.subarray(0, 64));
    return bytes.length >= 12 && bytes.toString('latin1', 4, 8) === 'ftyp';
  } finally { await reader.cancel().catch(() => {}); }
}

async function resolveStreamtape(embed, { fetchImpl = fetch } = {}) {
  const valid = validStreamtapeEmbed(embed);
  if (!valid) return null;
  const id = new URL(valid).pathname.split('/')[2];
  const pageUrl = `${BASE}/v/${id}`;
  try {
    const page = await fetchImpl(pageUrl, { redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: `${BASE}/` } });
    const html = await boundedText(page);
    const gate = extractGate(html, id);
    if (!gate) return null;
    const redirect = await fetchImpl(gate, { redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: { Referer: pageUrl, 'User-Agent': 'Mozilla/5.0' } });
    if (![301, 302, 303, 307, 308].includes(redirect.status)) {
      await redirect.body?.cancel();
      return null;
    }
    const rawLocation = redirect.headers.get('location');
    const cdn = rawLocation ? new URL(rawLocation, gate).href : null;
    await redirect.body?.cancel();
    if (!isStreamtapeCdn(cdn) || !(await validMp4Range(cdn, pageUrl, fetchImpl))) return null;
    return { url: cdn, type: 'mp4', referer: pageUrl, ephemeral: true };
  } catch { return null; }
}

module.exports = { isStreamtapeGate, isStreamtapeCdn, staticStringExpression,
  extractGate, resolveStreamtape };
