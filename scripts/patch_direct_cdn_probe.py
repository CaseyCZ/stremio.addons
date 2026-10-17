from pathlib import Path

path = Path('api/sktonline.js')
text = path.read_text()

helper = r'''
function onlineVideoIdFromItem(item) {
  const explicit = String(item && item.id || '').trim();
  if (/^\d+$/.test(explicit)) return explicit;
  const href = String(item && item.href || '').trim();
  const match = href.match(/\/video\/(\d+)(?:\/|$)/i);
  return match ? match[1] : null;
}

async function probeSktCdnHead(url) {
  try {
    const response = await axios.head(url, {
      timeout: 2200,
      maxRedirects: 2,
      validateStatus: () => true,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Encoding': 'identity',
        Referer: `${SKTORRENT_BASE_URL}/`
      }
    });
    const status = Number(response.status || 0);
    const length = Number(response.headers && response.headers['content-length'] || 0);
    const contentType = String(response.headers && response.headers['content-type'] || '').toLowerCase();
    return (status === 200 || status === 206) && (length > 1000000 || contentType.startsWith('video/'));
  } catch (_) {
    return false;
  }
}

async function findSktCdnEdge(videoId) {
  const id = String(videoId || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const key = `skt-cdn-edge-v1:${id}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached || null;

  const edges = Array.from({ length: 30 }, (_, index) => index + 1);
  for (let offset = 0; offset < edges.length; offset += 10) {
    const group = edges.slice(offset, offset + 10);
    const checks = await Promise.all(group.map(async edge => {
      const base = `https://online${edge}.sktorrent.eu/media/videos//h264/${id}`;
      const [p480, p720] = await Promise.all([
        probeSktCdnHead(`${base}_480p.mp4`),
        probeSktCdnHead(`${base}_720p.mp4`)
      ]);
      return p480 || p720 ? edge : null;
    }));
    const found = checks.find(Boolean);
    if (found) {
      cache.set(key, found, 6 * 60 * 60);
      return found;
    }
  }

  cache.set(key, '', 90);
  return null;
}

async function streamsForKnownOnlineVideoId(videoId, pageTitle = 'SKTOnline') {
  const id = String(videoId || '').trim();
  if (!/^\d+$/.test(id)) return [];
  const key = `skt-cdn-streams-v1:${id}:${normalize(pageTitle)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const edge = await findSktCdnEdge(id);
  if (!edge) {
    cache.set(key, [], 90);
    return [];
  }

  const qualities = ['1080p', '720p', '480p', '360p'];
  const checks = await Promise.all(qualities.map(async quality => {
    const url = `https://online${edge}.sktorrent.eu/media/videos//h264/${id}_${quality}.mp4`;
    return await probeSktCdnHead(url) ? { url, quality } : null;
  }));

  const streams = checks.filter(Boolean).map(item => {
    const stream = makeStream('SKTOnline', pageTitle || 'SKTOnline', item.url, item.quality, `${ONLINE_BASE_URL}/`);
    stream.behaviorHints = { notWebReady: false };
    return stream;
  });
  const result = dedupeStreams(streams);
  cache.set(key, result, result.length ? 60 * 60 : 90);
  return result;
}

'''

anchor = 'function mediaUrlsFromHtml('
if 'function streamsForKnownOnlineVideoId(' not in text:
    pos = text.index(anchor)
    text = text[:pos] + helper + text[pos:]

start = text.index('async function streamsForDirectOnlineVideo(')
end = text.index('\nasync function findDirectOnlineByTitle(', start)
new_direct = r'''async function streamsForDirectOnlineVideo(item) {
  const videoId = onlineVideoIdFromItem(item);
  const sourceTitle = String(item && item.title || '').replace(/\s+/g, ' ').trim() || 'SKTOnline';

  // Current online.sktorrent.eu /video/<id> pages can return an empty body to
  // server-side clients while the actual MP4 remains available on one of the
  // online1..online30 CDN edges. Resolve the edge directly from the video ID.
  if (videoId) {
    const direct = await streamsForKnownOnlineVideoId(videoId, sourceTitle);
    if (direct.length) return direct.slice(0, 8);
  }

  const pageUrl = absoluteUrl(item && (item.href || (item.id ? `/video/${item.id}` : '')), ONLINE_BASE_URL);
  if (!pageUrl) return [];
  const key = `direct-online-video-v5:${pageUrl}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const response = await onlineGet(pageUrl, { headers: { Referer: `${ONLINE_BASE_URL}/` } });
    const finalUrl = absoluteUrl(response.request?.res?.responseUrl || pageUrl, ONLINE_BASE_URL) || pageUrl;
    const $ = cheerio.load(response.data);
    const pageTitle = $('title').text().replace(/\s+/g, ' ').trim() || sourceTitle;
    const streams = [];

    const add = (raw, label = '') => {
      const url = absoluteUrl(raw, finalUrl);
      if (!url || !isPlayableMediaUrl(url)) return;
      const stream = makeStream('SKTOnline', pageTitle, url, label, finalUrl);
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
'''
text = text[:start] + new_direct + text[end:]

start = text.index('async function findDirectOnlineByTitle(')
end = text.index('\nasync function streamsFromSledujSearch(', start)
new_find = r'''async function findDirectOnlineByTitle(queries, titles) {
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

    fresh.sort((a, b) => (Number(b.score || 0) - Number(a.score || 0)));
    const all = [];
    for (const item of fresh.slice(0, 4)) {
      const streams = await streamsForDirectOnlineVideo(item);
      all.push(...streams);
      const unique = dedupeStreams(all);
      if (unique.length >= 4) return unique.slice(0, 12);
    }
    const unique = dedupeStreams(all);
    if (unique.length) return unique.slice(0, 12);
  }
  return [];
}
'''
text = text[:start] + new_find + text[end:]

path.write_text(text)
