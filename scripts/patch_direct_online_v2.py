from pathlib import Path

path = Path('api/sktonline.js')
text = path.read_text()

# The public working SKTOnline addon collects /video/<id> results directly.
# Do not reject those cards because surrounding HTML can contain unrelated
# years/dates and eliminate valid videos before their player page is read.
year_filter = "      if (context && candidateHasConflictingYears(context, wantedTitles)) return;\n"
if year_filter not in text:
    raise SystemExit('direct search year filter not found')
text = text.replace(year_filter, '', 1)

# Invalidate stale empty direct-search cache entries after this change.
if 'online-title-search-v2:' not in text:
    raise SystemExit('direct search cache key not found')
text = text.replace('online-title-search-v2:', 'online-title-search-v3:', 1)

# Use the simple player extraction path proven by the public
# Online-Sktorrent-Stremio-addon: GET /video/<id>, read <video><source>, and
# return the MP4 directly. No proxyHeaders are attached to these CDN streams.
old = """async function streamsForDirectOnlineVideo(item) {
  const pageUrl = `${ONLINE_BASE_URL}/video/${encodeURIComponent(item.id)}`;
  return streamsForOnlinePage(pageUrl, `${ONLINE_BASE_URL}/`, item.title || '');
}
"""
new = """async function streamsForDirectOnlineVideo(item) {
  const pageUrl = `${ONLINE_BASE_URL}/video/${encodeURIComponent(item.id)}`;
  const key = `direct-online-video-v3:${item.id}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const response = await onlineHttp.get(pageUrl, { headers: { Referer: `${ONLINE_BASE_URL}/` } });
    const finalUrl = absoluteUrl(response.request?.res?.responseUrl || pageUrl, ONLINE_BASE_URL) || pageUrl;
    const $ = cheerio.load(response.data);
    const pageTitle = $('title').text().replace(/\\s+/g, ' ').trim() || item.title || 'SKTOnline';
    const streams = [];

    const add = (raw, label = '') => {
      const url = absoluteUrl(raw, finalUrl);
      if (!url || !/\\.mp4(?:$|[?#])/i.test(url)) return;
      const quality = qualityLabel(label, url);
      const languages = streamLanguages(`${pageTitle} ${label}`);
      streams.push({
        name: `SKTOnline • ${quality}`,
        title: `🎧 ${formatLanguages(languages.audio)}\\n💬 ${languages.subtitles.length ? formatLanguages(languages.subtitles) : 'Bez titulků'}\\n🎬 ${quality}`,
        url
      });
    };

    $('video source[src], video[src]').each((_, el) => {
      add(
        $(el).attr('src'),
        $(el).attr('label') || $(el).attr('res') || $(el).attr('data-res') || ''
      );
    });

    // Fallback for minor markup changes while preserving the direct MP4 path.
    if (!streams.length) {
      for (const media of mediaUrlsFromHtml($, response.data, finalUrl)) add(media.url, media.label);
    }

    const result = dedupeStreams(streams).slice(0, 8);
    cache.set(key, result, result.length ? 10 * 60 : 60);
    return result;
  } catch (error) {
    console.warn(`[direct-online] video ${item.id}: ${error.message}`);
    return [];
  }
}
"""
if old not in text:
    raise SystemExit('streamsForDirectOnlineVideo block not found')
text = text.replace(old, new, 1)

path.write_text(text)
