const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://sktorrent.eu';
const SEARCH_URL = `${BASE}/torrent/torrents_v2.php`;
const QUERY = 'Casino Royale 2006';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';

const http = axios.create({
  timeout: 12000,
  maxRedirects: 5,
  maxContentLength: 8 * 1024 * 1024,
  headers: {
    'User-Agent': UA,
    'Accept-Encoding': 'identity'
  },
  validateStatus: () => true
});

function clean(value) {
  return String(value || '')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .trim();
}

function absolute(value, base) {
  const raw = clean(value);
  if (!raw) return null;
  try { return new URL(raw, base).toString(); } catch { return null; }
}

function isMedia(url) {
  return /\.(?:mp4|m3u8|webm|m4v|mov|ts)(?:$|[?#])/i.test(String(url || ''));
}

function collectMedia(html, pageUrl) {
  const $ = cheerio.load(html);
  const out = [];
  const add = raw => {
    const url = absolute(raw, pageUrl);
    if (url && isMedia(url)) out.push(url);
  };

  $('video source[src], video[src], source[src], #player a[href], [data-file], [data-video]').each((_, el) => {
    add($(el).attr('src') || $(el).attr('href') || $(el).attr('data-file') || $(el).attr('data-video'));
  });

  for (const raw of clean(html).match(/https?:\/\/[^\s"'<>]+?\.(?:mp4|m3u8|webm|m4v|mov|ts)(?:\?[^\s"'<>]*)?/gi) || []) add(raw);
  return [...new Set(out)];
}

function collectOnlinePages(html, pageUrl) {
  const $ = cheerio.load(html);
  const out = [];
  const add = raw => {
    const url = absolute(raw, pageUrl);
    if (!url) return;
    try {
      if (new URL(url).hostname.toLowerCase() === 'online.sktorrent.eu' && !isMedia(url)) out.push(url);
    } catch {}
  };
  $('a[href], iframe[src], frame[src], [data-src], [data-url]').each((_, el) => {
    add($(el).attr('href') || $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-url'));
  });
  for (const raw of clean(html).match(/https?:\/\/online\.sktorrent\.eu\/[^\s"'<>\])}]+/gi) || []) add(raw);
  return [...new Set(out)];
}

function summary(url) {
  try {
    const u = new URL(url);
    const ext = (u.pathname.match(/\.([a-z0-9]+)$/i) || [,'?'])[1];
    return `${u.hostname} (*.${ext || '?'})`;
  } catch {
    return 'invalid-url';
  }
}

async function findDetail() {
  const search = await http.get('/torrent/torrents_v2.php', {
    baseURL: BASE,
    responseType: 'text',
    transformResponse: [v => v],
    params: { search: QUERY, category: 0, active: 0, order: 'data', by: 'DESC', page: 0 },
    headers: { Referer: SEARCH_URL }
  });
  console.log(`search status=${search.status} type=${search.headers['content-type'] || ''}`);
  if (search.status < 200 || search.status >= 400) return null;

  const $ = cheerio.load(String(search.data || ''));
  const candidates = [];
  const seen = new Set();
  $('a[href*="details.php"]').each((_, el) => {
    const link = $(el);
    const href = String(link.attr('href') || '');
    const id = (href.match(/[?&]id=([a-f0-9]{40})/i) || [])[1];
    if (!id || seen.has(id)) return;
    seen.add(id);
    const card = link.closest('td, tr, article, div');
    const name = String(link.attr('title') || link.find('img').attr('alt') || link.text() || card.text() || '').replace(/\s+/g, ' ').trim();
    const detailUrl = absolute(href, SEARCH_URL);
    if (detailUrl) candidates.push({ id, name, detailUrl });
  });
  console.log(`detail candidates=${candidates.length}`);
  candidates.slice(0, 8).forEach((item, i) => console.log(`candidate ${i + 1}: ${item.name.slice(0, 140)}`));

  return candidates.find(item => /casino[ ._-]*royale/i.test(item.name) && /2006|1080|720|bluray|web|bdrip/i.test(item.name))
    || candidates.find(item => /casino[ ._-]*royale/i.test(item.name))
    || candidates[0]
    || null;
}

async function rangeProbe(url, headers) {
  try {
    const response = await http.get(url, {
      responseType: 'stream',
      headers: {
        Accept: '*/*',
        Range: 'bytes=0-0',
        ...headers
      }
    });
    if (response.data && typeof response.data.destroy === 'function') response.data.destroy();
    let finalHost = '';
    try { finalHost = new URL(response.request?.res?.responseUrl || url).hostname; } catch {}
    return {
      status: response.status,
      type: String(response.headers['content-type'] || ''),
      cors: String(response.headers['access-control-allow-origin'] || ''),
      finalHost
    };
  } catch (error) {
    return { error: error.code || error.message };
  }
}

async function main() {
  const picked = await findDetail();
  if (!picked) {
    console.log('No SKTorrent detail candidate found.');
    return;
  }
  console.log(`picked: ${picked.name.slice(0, 160)}`);

  const detail = await http.get(picked.detailUrl, {
    responseType: 'text',
    transformResponse: [v => v],
    headers: { Referer: SEARCH_URL }
  });
  console.log(`detail status=${detail.status} type=${detail.headers['content-type'] || ''}`);
  if (detail.status < 200 || detail.status >= 400) return;

  const detailHtml = String(detail.data || '');
  const media = collectMedia(detailHtml, picked.detailUrl);
  const onlinePages = collectOnlinePages(detailHtml, picked.detailUrl).slice(0, 3);

  for (const pageUrl of onlinePages) {
    try {
      const page = await http.get(pageUrl, {
        responseType: 'text',
        transformResponse: [v => v],
        headers: { Referer: picked.detailUrl }
      });
      console.log(`online page ${new URL(pageUrl).pathname} status=${page.status}`);
      if (page.status >= 200 && page.status < 400) media.push(...collectMedia(String(page.data || ''), pageUrl));
    } catch (error) {
      console.log(`online page probe failed: ${error.code || error.message}`);
    }
  }

  const unique = [...new Set(media)].slice(0, 8);
  console.log(`media candidates=${unique.length}`);

  for (const [index, url] of unique.entries()) {
    console.log(`\n#${index + 1} ${summary(url)}`);
    const variants = [
      ['no-referrer', {}],
      ['stremio-web', { Referer: 'https://web.stremio.com/', Origin: 'https://web.stremio.com' }],
      ['skt-detail', { Referer: picked.detailUrl }],
      ['sktonline', { Referer: 'https://online.sktorrent.eu/' }]
    ];
    for (const [name, headers] of variants) {
      const result = await rangeProbe(url, headers);
      console.log(`${name}: ${JSON.stringify(result)}`);
    }
  }
}

main().catch(error => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
