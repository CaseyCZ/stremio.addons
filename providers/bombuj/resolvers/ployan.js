'use strict';

const crypto = require('node:crypto');
const { inspectHls } = require('../stream-quality.js');
const { languageCode } = require('../group-labels.js');
const { resolveVidara, vidaraEmbed } = require('./vidara.js');

const PLOYAN = 'https://ployan.me';
const SEARCH = 'https://ww8.123moviesfree.net';
const JSON_LIMIT = 256 * 1024;
const TIMEOUT_MS = 8000;

function normalizeTitle(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function verifiedContext(raw) {
  const type = raw?.type;
  const title = String(raw?.title || '').trim();
  if (!['movie', 'series'].includes(type) || !title || title.length > 150 ||
      normalizeTitle(title).length < 3) return null;
  if (type === 'movie') {
    const year = Number(raw.year);
    return Number.isInteger(year) && year >= 1900 && year <= 2100 ? { type, title, year, episode: 1 } : null;
  }
  const season = Number(raw.season), episode = Number(raw.episode);
  return Number.isInteger(season) && season >= 1 && season <= 99 &&
    Number.isInteger(episode) && episode >= 1 && episode <= 999 ?
      { type, title, season, episode } : null;
}

function selectSearchItem(items, context) {
  const target = verifiedContext(context);
  if (!target) return null;
  const title = normalizeTitle(target.type === 'series' ?
    `${target.title} Season ${target.season}` : target.title);
  const matches = (Array.isArray(items) ? items : []).filter(item => {
    if (item?.d !== (target.type === 'series' ? 's' : 'm') ||
        normalizeTitle(item.t) !== title) return false;
    if (target.type === 'series') return Number(item.n) === target.season;
    // Identical names often represent remakes; require exact release year.
    return Number.isInteger(Number(item.y)) && Number(item.y) === target.year;
  });
  if (matches.length !== 1) return null;
  const match = /-(\d{1,13})$/.exec(String(matches[0].s || ''));
  return match ? { id: match[1] } : null;
}

function makeToken(id, episode, server, now = Date.now(), randomBytes = crypto.randomBytes) {
  if (!/^\d{1,13}$/.test(String(id)) || !Number.isInteger(episode) ||
      episode < 1 || episode > 999 || ![1, 3].includes(server)) throw Error('Invalid Ployan input');
  const salt = randomBytes(8), iv = randomBytes(12);
  const key = crypto.pbkdf2Sync('player', salt, 1000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(`${id}+${episode}+${server}+${Math.floor(now / 1000)}`, 'utf8'),
    cipher.final(), cipher.getAuthTag()
  ]);
  return [salt, iv, encrypted].map(part => part.toString('hex')).join('-');
}

function decryptInfo(info) {
  const chunks = String(info || '').split('-');
  if (chunks.length !== 3 || !/^[\da-f]{16}$/i.test(chunks[0]) ||
      !/^[\da-f]{24}$/i.test(chunks[1]) ||
      !/^[\da-f]{34,}$/i.test(chunks[2]) || chunks[2].length % 2) return null;
  try {
    const salt = Buffer.from(chunks[0], 'hex'), iv = Buffer.from(chunks[1], 'hex');
    const encrypted = Buffer.from(chunks[2], 'hex');
    const key = crypto.pbkdf2Sync('player', salt, 1000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(encrypted.subarray(-16));
    return Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString('utf8');
  } catch { return null; }
}

async function limitedJson(url, options, fetchImpl) {
  const response = await fetchImpl(url, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (response.status !== 200 || Number(response.headers.get('content-length') || 0) > JSON_LIMIT) {
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
      if (length > JSON_LIMIT) return null;
      parts.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { return null; }
}

function subtitleIndexUrl(id, episode) {
  const xor = [...Buffer.from('player')].reduce((acc, value) => acc ^ value, 0);
  const token = Buffer.from(`${id}-${episode}`).map(byte => byte ^ xor).toString('hex');
  return `${PLOYAN}/sub/${token}/index.json`;
}

async function ployanSubtitles(id, episode, fetchImpl) {
  try {
    const entries = await limitedJson(subtitleIndexUrl(id, episode), {
      headers: { Referer: `${PLOYAN}/watch/`, Accept: 'application/json' }
    }, fetchImpl);
    if (!Array.isArray(entries)) return [];
    const seen = new Set();
    return entries.slice(0, 40).flatMap((track, index) => {
      try {
        if (!track?.file) return [];
        const url = new URL(track.file, PLOYAN);
        if (url.protocol !== 'https:' || url.hostname !== 'ployan.me' || url.port ||
            url.username || url.password || !url.pathname.startsWith('/sub/') ||
            !url.pathname.endsWith('.vtt') || seen.has(url.href)) return [];
        seen.add(url.href);
        return [{ id: `bombuj-ployan-${index + 1}`, lang: languageCode(track.lang), url: url.href }];
      } catch { return []; }
    });
  } catch { return []; }
}

function isPloyanMaster(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'ployan.me' &&
      !url.port && !url.username && !url.password &&
      /^\/hls\/[\w.-]{1,500}\/master\.m3u8$/.test(url.pathname);
  } catch { return false; }
}

async function resolvePloyanSource(id, episode, server, fetchImpl, vidaraResolver) {
  const token = makeToken(id, episode, server);
  const data = await limitedJson(`${PLOYAN}/get/${token}`, {
    headers: { Referer: `${PLOYAN}/watch/`, Accept: 'application/json' }
  }, fetchImpl);
  if (data?.code !== 200 || !data.info) return null;
  if (server === 1 && data.mode === 'direct' && /^[\w.-]{1,500}$/.test(data.info)) {
    const url = `${PLOYAN}/hls/${data.info}/master.m3u8`;
    if (!isPloyanMaster(url)) return null;
    const hls = await inspectHls(url, {
      fetchImpl, headers: { Referer: `${PLOYAN}/watch/` }, timeoutMs: 5000
    }).catch(() => null);
    return hls ? { url, type: 'hls', quality: hls.quality || undefined,
      referer: `${PLOYAN}/watch/`, ephemeral: true } : null;
  }
  if (server === 3 && data.mode === 'embed') {
    const link = decryptInfo(data.info);
    if (!vidaraEmbed(link)) return null;
    return vidaraResolver(link, { fetchImpl });
  }
  return null;
}

async function resolvePrimewireViaPloyan(context, {
  fetchImpl = fetch, vidaraResolver = resolveVidara
} = {}) {
  const target = verifiedContext(context);
  if (!target) return null;
  const query = target.type === 'series' ? `${target.title} Season ${target.season}` : target.title;
  try {
    const url = `${SEARCH}/searching?q=${encodeURIComponent(query)}&limit=30&offset=0`;
    const results = await limitedJson(url, { headers: { Accept: 'application/json' } }, fetchImpl);
    const source = selectSearchItem(results?.data, target);
    if (!source) return null;

    // Direct server 1 first. Some series exist only on server 3 (Vidara).
    let media = null;
    for (const server of [1, 3]) {
      media = await resolvePloyanSource(source.id, target.episode, server, fetchImpl, vidaraResolver)
        .catch(() => null);
      if (media?.url) break;
    }
    if (!media?.url) return null;
    const subtitles = await ployanSubtitles(source.id, target.episode, fetchImpl);
    return { ...media, subtitles: [...(media.subtitles || []), ...subtitles], ephemeral: true };
  } catch { return null; }
}

module.exports = { verifiedContext, normalizeTitle, selectSearchItem, makeToken,
  decryptInfo, subtitleIndexUrl, isPloyanMaster, resolvePrimewireViaPloyan };
