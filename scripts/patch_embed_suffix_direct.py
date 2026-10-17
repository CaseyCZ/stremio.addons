from pathlib import Path

path = Path('api/sktonline.js')
text = path.read_text()

text = text.replace(
    r"/(?:https?:)?\/\/online(?:\d+)?\.sktorrent\.eu\/embed\/[a-z0-9_-]+/gi",
    r"/(?:https?:)?\/\/online(?:\d+)?\.sktorrent\.eu\/embed\/[a-z0-9_-]+(?:&\d+)?(?:[?#][^\s\"'<>]*)?/gi"
)
text = text.replace(
    r"/(?:^|[\s\"'=(])\/embed\/[a-z0-9_-]+/gi",
    r"/(?:^|[\s\"'=(])\/embed\/[a-z0-9_-]+(?:&\d+)?(?:[?#][^\s\"'<>]*)?/gi"
)
text = text.replace(
    r"/^\/embed\/[a-z0-9_-]+(?:[?#].*)?$/i",
    r"/^\/embed\/[a-z0-9_-]+(?:&\d+)?(?:[?#].*)?$/i"
)
text = text.replace(
    r"!/\/embed\/[a-z0-9_-]+/i.test(url)",
    r"!/\/embed\/[a-z0-9_-]+(?:&\d+)?/i.test(url)"
)

meta_anchor = "  $('iframe[src], frame[src]').each((_, el) => {\n    add($(el).attr('src'), nearbyTitleForOnlineEmbed($, el));\n  });\n\n"
if 'meta[itemprop="embedURL"]' not in text:
    meta_block = meta_anchor + "  $('meta[itemprop=\"embedURL\"][content], meta[property=\"og:url\"][content], meta[property=\"og:video\"][content]').each((_, el) => {\n    add($(el).attr('content'), releaseTitle);\n  });\n\n"
    if meta_anchor not in text:
        raise SystemExit('iframe anchor not found')
    text = text.replace(meta_anchor, meta_block, 1)

helper_anchor = 'function mediaUrlsFromHtml($, html, pageUrl) {'
if 'function onlineVideoIdFromHtml(' not in text:
    helper = r'''function onlineVideoIdFromHtml($, html = '') {
  const values = [String(html || '')];
  if ($) {
    $('video[poster], [style*="media/videos/tmb"], img[src*="media/videos/tmb"], script').each((_, el) => {
      const node = $(el);
      values.push(
        String(node.attr('poster') || ''),
        String(node.attr('style') || ''),
        String(node.attr('src') || ''),
        String(node.html() || '')
      );
    });
  }

  for (const raw of values) {
    const source = cleanUrlText(raw);
    if (!source) continue;
    for (const pattern of [
      /\bvideo_id\s*=\s*["']?(\d{1,10})/i,
      /\/media\/videos\/(?:tmb1?|h264)\/+([0-9]{1,10})(?:\/|_)/i,
      /\/video\/([0-9]{1,10})(?:\/|$)/i
    ]) {
      const match = source.match(pattern);
      if (match) return match[1];
    }
  }
  return null;
}

'''
    if helper_anchor not in text:
        raise SystemExit('media helper anchor not found')
    text = text.replace(helper_anchor, helper + helper_anchor, 1)

text = text.replace(
    '  const key = `linked-online:${pageUrl}:${normalize(sourceTitle)}`;',
    '  const key = `linked-online-v2:${pageUrl}:${normalize(sourceTitle)}`;',
    1
)
old = """    const streams = mediaUrlsFromHtml($, response.data, finalUrl)\n      .map(item => makeStream('SKTOnline', title, item.url, item.label, referer || finalUrl));\n    const result = dedupeStreams(streams);\n"""
new = """    let streams = mediaUrlsFromHtml($, response.data, finalUrl)\n      .map(item => makeStream('SKTOnline', title, item.url, item.label, referer || finalUrl));\n\n    if (!streams.length) {\n      const videoId = onlineVideoIdFromHtml($, response.data);\n      if (videoId) streams = await streamsForKnownOnlineVideoId(videoId, title);\n    }\n\n    const result = dedupeStreams(streams);\n"""
if old not in text:
    raise SystemExit('streamsForOnlinePage block not found')
text = text.replace(old, new, 1)

text = text.replace(
    "  const key = `skt-detail-direct-v2:${client ? client.clientKey : 'anon'}:${candidate.id}`;",
    "  const key = `skt-detail-direct-v3:${client ? client.clientKey : 'anon'}:${candidate.id}`;",
    1
)
marker = "    const onlineEntries = onlineEmbedEntriesFromDetail($, finalUrl, title, response.data);\n  const onlineDirectLinks = links.filter(url => isSktOnlineUrl(url) && isPlayableMediaUrl(url));\n"
replacement = "    const onlineEntries = onlineEmbedEntriesFromDetail($, finalUrl, title, response.data);\n    const detailVideoId = onlineVideoIdFromHtml($, response.data);\n    const onlineDirectLinks = links.filter(url => isSktOnlineUrl(url) && isPlayableMediaUrl(url));\n"
if marker not in text:
    raise SystemExit('detail marker not found')
text = text.replace(marker, replacement, 1)

old_parallel = """      Promise.all([\n      ...onlineEntries.slice(0, 6).map(entry => streamsForOnlinePage(entry.url, finalUrl, entry.title || title)),\n      ...onlineDirectLinks.slice(0, 4).map(url => Promise.resolve([makeStream('SKTOnline', title, url, '', finalUrl)]))\n    ])\n"""
new_parallel = """      Promise.all([\n        ...(detailVideoId ? [streamsForKnownOnlineVideoId(detailVideoId, title)] : []),\n        ...onlineEntries.slice(0, 6).map(entry => streamsForOnlinePage(entry.url, finalUrl, entry.title || title)),\n        ...onlineDirectLinks.slice(0, 4).map(url => Promise.resolve([makeStream('SKTOnline', title, url, '', finalUrl)]))\n      ])\n"""
if old_parallel not in text:
    raise SystemExit('online detail batch block not found')
text = text.replace(old_parallel, new_parallel, 1)

path.write_text(text)
