from pathlib import Path

path = Path('api/sktonline.js')
text = path.read_text()

# Match the current public SKTOnline site more closely. Recent working forks
# keep a homepage session cookie and use the full search query parameters.
text = text.replace(
    "const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';",
    "const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';",
    1
)

marker = "const resolverHttp = RESOLVER_BASE_URL ? makeHttp(RESOLVER_BASE_URL, 12000) : null;\n"
if marker not in text:
    raise SystemExit('resolverHttp marker not found')

session_code = r'''
let onlineCookieHeader = '';
let onlinePrimePromise = null;

function normalizeOnlineSetCookies(values) {
  return (Array.isArray(values) ? values : values ? [values] : [])
    .map(value => String(value || '').split(';', 1)[0].trim())
    .filter(Boolean)
    .join('; ');
}

function captureOnlineCookies(response) {
  const value = normalizeOnlineSetCookies(response && response.headers && response.headers['set-cookie']);
  if (value) onlineCookieHeader = value;
}

async function primeOnlineSession(force = false) {
  if (onlineCookieHeader && !force) return;
  if (onlinePrimePromise) return onlinePrimePromise;
  onlinePrimePromise = (async () => {
    try {
      const response = await onlineHttp.get('/', {
        headers: { Referer: ONLINE_BASE_URL },
        validateStatus: status => status >= 200 && status < 400
      });
      captureOnlineCookies(response);
    } finally {
      onlinePrimePromise = null;
    }
  })();
  return onlinePrimePromise;
}

async function onlineGet(url, options = {}) {
  if (!onlineCookieHeader) {
    try { await primeOnlineSession(false); } catch (_) {}
  }

  const request = () => onlineHttp.get(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Referer: (options.headers && options.headers.Referer) || ONLINE_BASE_URL,
      ...(onlineCookieHeader ? { Cookie: onlineCookieHeader } : {})
    }
  });

  try {
    const response = await request();
    captureOnlineCookies(response);
    return response;
  } catch (error) {
    const status = Number(error && error.response && error.response.status || 0);
    if (status !== 401 && status !== 403) throw error;
    onlineCookieHeader = '';
    await primeOnlineSession(true);
    const response = await request();
    captureOnlineCookies(response);
    return response;
  }
}
'''

if 'let onlineCookieHeader' not in text:
    text = text.replace(marker, marker + session_code, 1)

# All SKTOnline page loads, including embedded pages discovered from SKTorrent,
# need to reuse the same browser-like session.
text = text.replace(
    "const response = await onlineHttp.get(pageUrl, { headers: { Referer: referer || `${SKTORRENT_BASE_URL}/` } });",
    "const response = await onlineGet(pageUrl, { headers: { Referer: referer || `${SKTORRENT_BASE_URL}/` } });",
    1
)

start = text.find('async function searchDirectOnlineVideos(query, wantedTitles) {')
end = text.find('async function streamsFromSledujSearch(', start)
if start < 0 or end < 0:
    raise SystemExit('direct online block not found')

replacement = r'''function onlineSearchItemsFromHtml($, wantedTitles) {
  let cards = $('div.well.well-sm').toArray();
  if (!cards.length) cards = $('div.well-sm').toArray();
  if (!cards.length) cards = $('div.well').toArray();
  if (!cards.length) cards = $('article, .post, .item, .card').toArray();

  const items = [];
  const seen = new Set();
  const collect = (link, contextNode) => {
    const href = String(link.attr('href') || '').trim();
    const pageUrl = absoluteUrl(href, ONLINE_BASE_URL);
    if (!pageUrl || seen.has(pageUrl)) return;

    let parsed;
    try { parsed = new URL(pageUrl); } catch (_) { return; }
    if (parsed.hostname.toLowerCase() !== 'online.sktorrent.eu') return;
    const pathname = parsed.pathname || '/';
    if (/^\/(?:search|login|register|users?|categories?)(?:\/|$)/i.test(pathname)) return;
    if (pathname === '/' || pathname === '/videos') return;

    const title = String(
      link.attr('title') ||
      link.find('img').attr('alt') ||
      contextNode.find('span').first().text() ||
      contextNode.find('h1,h2,h3,h4').first().text() ||
      link.text() ||
      contextNode.text() || ''
    ).replace(/\s+/g, ' ').trim();

    // Do not hard-reject cards here: current SKTOnline cards can contain dates,
    // metadata and localized titles. The search itself already narrows results.
    const score = title ? titleMatchScore(title, wantedTitles) : 0;
    seen.add(pageUrl);
    items.push({ href: pageUrl, title, score });
  };

  if (cards.length) {
    for (const card of cards) {
      const node = $(card);
      const link = node.find('a[href]').first();
      if (link.length) collect(link, node);
    }
  } else {
    $('a[href]').each((_, element) => {
      const link = $(element);
      collect(link, link.closest('article,li,div,tr,td'));
    });
  }

  return items
    .sort((a, b) => (b.score - a.score))
    .slice(0, 20);
}

async function searchDirectOnlineVideos(query, wantedTitles) {
  const key = `online-title-search-v4:${normalize(query)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  if (resolverHttp) {
    try {
      const payload = await resolverPost('/v1/search', { query });
      const items = (Array.isArray(payload.items) ? payload.items : [])
        .filter(item => item && /^\d+$/.test(String(item.id || '')))
        .map(item => ({
          id: String(item.id),
          href: `${ONLINE_BASE_URL}/video/${encodeURIComponent(String(item.id))}`,
          title: String(item.title || '').replace(/\s+/g, ' ').trim(),
          score: titleMatchScore(String(item.title || ''), wantedTitles)
        }));
      if (items.length) {
        cache.set(key, items, 5 * 60);
        return items;
      }
    } catch (error) {
      console.warn(`[resolver] search "${query}": ${error.message}`);
    }
  }

  try {
    const response = await onlineGet('/search/videos', {
      params: {
        type: 'public',
        t: 'a',
        o: 'mr',
        search_query: query,
        page: 1
      },
      headers: { Referer: `${ONLINE_BASE_URL}/` }
    });
    const $ = cheerio.load(response.data);
    const items = onlineSearchItemsFromHtml($, wantedTitles);
    cache.set(key, items, items.length ? 5 * 60 : 45);
    return items;
  } catch (error) {
    console.warn(`[direct-online] search "${query}": ${error.message}`);
    return [];
  }
}

async function streamsForDirectOnlineVideo(item) {
  const pageUrl = absoluteUrl(item && (item.href || (item.id ? `/video/${item.id}` : '')), ONLINE_BASE_URL);
  if (!pageUrl) return [];
  const key = `direct-online-video-v4:${pageUrl}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const response = await onlineGet(pageUrl, { headers: { Referer: `${ONLINE_BASE_URL}/` } });
    const finalUrl = absoluteUrl(response.request?.res?.responseUrl || pageUrl, ONLINE_BASE_URL) || pageUrl;
    const $ = cheerio.load(response.data);
    const pageTitle = $('title').text().replace(/\s+/g, ' ').trim() || item.title || 'SKTOnline';
    const streams = [];

    const add = (raw, label = '') => {
      const url = absoluteUrl(raw, finalUrl);
      if (!url || !isPlayableMediaUrl(url)) return;
      const stream = makeStream('SKTOnline', pageTitle, url, label, finalUrl);
      // Direct CDN files from SKTOnline do not need Stremio to replay the
      // website cookie; the server only needs the cookie to discover them.
      if (/\.mp4(?:$|[?#])/i.test(url)) stream.behaviorHints = { notWebReady: false };
      streams.push(stream);
    };

    $('video#video source[src], video source[src], video[src], source[src]').each((_, el) => {
      add(
        $(el).attr('src'),
        $(el).attr('label') || $(el).attr('res') || $(el).attr('data-res') || ''
      );
    });

    if (!streams.length) {
      for (const media of mediaUrlsFromHtml($, response.data, finalUrl)) add(media.url, media.label);
    }

    const result = dedupeStreams(streams).slice(0, 8);
    cache.set(key, result, result.length ? 10 * 60 : 45);
    return result;
  } catch (error) {
    console.warn(`[direct-online] page ${pageUrl}: ${error.message}`);
    return [];
  }
}

async function findDirectOnlineByTitle(queries, titles) {
  const seenPages = new Set();
  const searchQueries = dedupe(queries || []).slice(0, 9);

  for (let offset = 0; offset < searchQueries.length; offset += 3) {
    const group = searchQueries.slice(offset, offset + 3);
    const resultGroups = await Promise.all(group.map(query => searchDirectOnlineVideos(query, titles)));
    const fresh = [];
    for (const items of resultGroups) {
      for (const item of items) {
        const key = String(item.href || item.id || '');
        if (!key || seenPages.has(key)) continue;
        seenPages.add(key);
        fresh.push(item);
      }
    }
    if (!fresh.length) continue;

    const batches = await Promise.all(fresh.slice(0, 12).map(streamsForDirectOnlineVideo));
    const streams = dedupeStreams(batches.flat());
    if (streams.length) return streams.slice(0, 12);
  }
  return [];
}

'''

text = text[:start] + replacement + text[end:]

# Keep the outer 22 s Stremio request budget, but give the now session-aware
# SKTOnline lookup enough time for the initial homepage + search request.
text = text.replace(
    "directProviderWithin(findDirectOnlineByTitle(queries, titles), 13000, 'SKTOnline title search')",
    "directProviderWithin(findDirectOnlineByTitle(queries, titles), 18000, 'SKTOnline title search')",
    1
)

path.write_text(text)
