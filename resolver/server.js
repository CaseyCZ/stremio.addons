const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 7010);
const TOKEN = String(process.env.SKTONLINE_RESOLVER_TOKEN || '').trim();
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
const ONLINE_BASE_URL = 'https://online.sktorrent.eu';

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

const http = axios.create({
  timeout: 12000,
  maxRedirects: 4,
  maxContentLength: 8 * 1024 * 1024,
  headers: {
    'User-Agent': USER_AGENT,
    'Accept-Encoding': 'identity',
    Accept: 'text/html,application/xhtml+xml,*/*'
  }
});

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}

function authorized(req) {
  if (!TOKEN) return false;
  const auth = String(req.headers.authorization || '');
  return auth.startsWith('Bearer ') && safeEqual(auth.slice(7), TOKEN);
}

function allowedOnlineUrl(value) {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:') return null;
    if (host === 'online.sktorrent.eu' || /^online\d+\.sktorrent\.eu$/.test(host)) return url;
    return null;
  } catch (_) {
    return null;
  }
}

function absoluteUrl(value, base) {
  try { return new URL(String(value || ''), base).toString(); } catch (_) { return null; }
}

function playable(url) {
  return /\.(?:mp4|m3u8|webm|m4v|mov|ts)(?:$|[?#])/i.test(String(url || ''));
}

function extractSources(html, pageUrl) {
  const $ = cheerio.load(html);
  const out = [];
  const add = (raw, label = '') => {
    const url = absoluteUrl(raw, pageUrl);
    if (!url || !playable(url)) return;
    const parsed = allowedOnlineUrl(url);
    if (!parsed) return;
    out.push({ url: parsed.toString(), label: String(label || '').trim() });
  };

  $('video source[src], video[src], source[src], #player a[href], [data-file], [data-video]').each((_, el) => {
    add(
      $(el).attr('src') || $(el).attr('href') || $(el).attr('data-file') || $(el).attr('data-video'),
      $(el).attr('label') || $(el).attr('res') || $(el).attr('data-res') || $(el).attr('title') || ''
    );
  });

  const raw = String(html || '').replace(/\\\//g, '/').replace(/\\u0026/gi, '&').replace(/&amp;/gi, '&');
  for (const match of raw.match(/https?:\/\/[^\s"'<>]+?\.(?:mp4|m3u8|webm|m4v|mov|ts)(?:\?[^\s"'<>]*)?/gi) || []) add(match);

  const seen = new Set();
  return out.filter(item => !seen.has(item.url) && seen.add(item.url));
}

async function fetchOnlinePage(url, referer) {
  const target = allowedOnlineUrl(url);
  if (!target) throw new Error('URL is not an allowed SKTOnline page');
  const response = await http.get(target.toString(), {
    headers: { Referer: referer || `${ONLINE_BASE_URL}/` }
  });
  const finalUrl = allowedOnlineUrl(response.request?.res?.responseUrl || target.toString());
  const pageUrl = finalUrl ? finalUrl.toString() : target.toString();
  const $ = cheerio.load(response.data);
  return {
    pageUrl,
    title: $('title').text().replace(/\s+/g, ' ').trim(),
    sources: extractSources(response.data, pageUrl)
  };
}

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'sktonline-home-resolver', tokenConfigured: Boolean(TOKEN) });
});

app.use((req, res, next) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

app.post('/v1/search', async (req, res) => {
  const query = String(req.body?.query || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  if (!query) return res.status(400).json({ error: 'Missing query' });
  try {
    const response = await http.get(`${ONLINE_BASE_URL}/search/videos`, {
      params: { search_query: query },
      headers: { Referer: `${ONLINE_BASE_URL}/` }
    });
    const $ = cheerio.load(response.data);
    const seen = new Set();
    const items = [];
    $("a[href^='/video/'], a[href*='online.sktorrent.eu/video/']").each((_, el) => {
      const link = $(el);
      const href = String(link.attr('href') || '');
      const match = href.match(/\/video\/(\d+)/i);
      if (!match || seen.has(match[1])) return;
      seen.add(match[1]);
      const title = String(
        link.attr('title') ||
        link.find('img').attr('alt') ||
        link.text() ||
        link.closest('article,li,div,tr,td').text() || ''
      ).replace(/\s+/g, ' ').trim();
      items.push({ id: match[1], title, url: `${ONLINE_BASE_URL}/video/${match[1]}` });
    });
    return res.json({ query, items: items.slice(0, 40) });
  } catch (error) {
    console.error(`[resolver] search ${query}: ${error.message}`);
    return res.status(502).json({ error: 'SKTOnline search failed' });
  }
});

app.post('/v1/resolve', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  const referer = String(req.body?.referer || '').trim().slice(0, 500);
  if (!allowedOnlineUrl(url)) return res.status(400).json({ error: 'Invalid URL' });
  try {
    return res.json(await fetchOnlinePage(url, referer));
  } catch (error) {
    console.error(`[resolver] resolve ${url}: ${error.message}`);
    return res.status(502).json({ error: 'SKTOnline resolve failed' });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`SKTOnline home resolver listening on 127.0.0.1:${PORT}`);
  if (!TOKEN) console.warn('SKTONLINE_RESOLVER_TOKEN is not configured; protected endpoints will reject requests.');
});
