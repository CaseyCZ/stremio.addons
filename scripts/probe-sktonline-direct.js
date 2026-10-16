const axios = require('axios');
const cheerio = require('cheerio');

const DETAIL_URL = 'https://sktorrent.eu/torrent/details.php?name=Casino-Royale-3137322e3232352e34302e3131392d31&id=436597e1af1612dacae85462e472c060d88e910c';
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
  const detail = await http.get(DETAIL_URL, {
    responseType: 'text',
    transformResponse: [v => v],
    headers: { Referer: 'https://sktorrent.eu/torrent/torrents_v2.php' }
  });
  console.log(`detail status=${detail.status} type=${detail.headers['content-type'] || ''}`);
  if (detail.status < 200 || detail.status >= 400) return;

  const detailHtml = String(detail.data || '');
  const media = collectMedia(detailHtml, DETAIL_URL);
  const onlinePages = collectOnlinePages(detailHtml, DETAIL_URL).slice(0, 3);

  for (const pageUrl of onlinePages) {
    try {
      const page = await http.get(pageUrl, {
        responseType: 'text',
        transformResponse: [v => v],
        headers: { Referer: DETAIL_URL }
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
      ['skt-detail', { Referer: DETAIL_URL }],
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
