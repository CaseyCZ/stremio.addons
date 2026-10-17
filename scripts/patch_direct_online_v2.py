from pathlib import Path

path = Path('api/sktonline.js')
text = path.read_text()

# A resolver that successfully returns no matches must not suppress the proven
# public HTML path on online.sktorrent.eu.
old = """      cache.set(key, items, items.length ? 5 * 60 : 60);\n      return items;\n    } catch (error) {\n      console.warn(`[resolver] search \\\"${query}\\\": ${error.message}`);\n    }\n  }\n\n  try {"""
new = """      if (items.length) {\n        cache.set(key, items, 5 * 60);\n        return items;\n      }\n    } catch (error) {\n      console.warn(`[resolver] search \\\"${query}\\\": ${error.message}`);\n    }\n  }\n\n  try {"""
if old not in text:
    raise SystemExit('resolver direct-search block not found')
text = text.replace(old, new, 1)

# Do not reject the Online search result cards by a year found in surrounding
# card text. The known working SKTOnline addon simply collects /video/<id>
# links and validates by the search query; card text often contains unrelated
# dates/years which used to eliminate valid videos before their page was read.
old = """      if (context && candidateHasConflictingYears(context, wantedTitles)) return;\n      seen.add(match[1]);"""
new = """      seen.add(match[1]);"""
if old not in text:
    raise SystemExit('direct search year filter not found')
text = text.replace(old, new, 1)

# Version the direct-search cache so stale empty searches cannot survive the fix.
text = text.replace('online-title-search-v2:', 'online-title-search-v3:', 1)

# Use the simple, proven online.sktorrent.eu player extraction path for title
# searches. Return the MP4 directly without proxyHeaders, matching the public
# Online-Sktorrent-Stremio-addon behavior. Keep the generic parser as fallback.
old = """async function streamsForDirectOnlineVideo(item) {\n  const pageUrl = `${ONLINE_BASE_URL}/video/${encodeURIComponent(item.id)}`;\n  return streamsForOnlinePage(pageUrl, `${ONLINE_BASE_URL}/`, item.title || '');\n}\n"""
new = """async function streamsForDirectOnlineVideo(item) {\n  const pageUrl = `${ONLINE_BASE_URL}/video/${encodeURIComponent(item.id)}`;\n  const key = `direct-online-video-v3:${item.id}`;\n  const cached = cache.get(key);\n  if (cached !== undefined) return cached;\n\n  try {\n    const response = await onlineHttp.get(pageUrl, { headers: { Referer: `${ONLINE_BASE_URL}/` } });\n    const finalUrl = absoluteUrl(response.request?.res?.responseUrl || pageUrl, ONLINE_BASE_URL) || pageUrl;\n    const $ = cheerio.load(response.data);\n    const pageTitle = $('title').text().replace(/\\s+/g, ' ').trim() || item.title || 'SKTOnline';\n    const streams = [];\n    const add = (raw, label = '') => {\n      const url = absoluteUrl(raw, finalUrl);\n      if (!url || !/\\.mp4(?:$|[?#])/i.test(url)) return;\n      const quality = qualityLabel(label, url);\n      const languages = streamLanguages(`${pageTitle} ${label}`);\n      streams.push({\n        name: `SKTOnline • ${quality}`,\n        title: `🎧 ${formatLanguages(languages.audio)}\\n💬 ${languages.subtitles.length ? formatLanguages(languages.subtitles) : 'Bez titulků'}\\n🎬 ${quality}`,\n        url\n      });\n    };\n\n    // This is the exact structure used by the known working public addon.\n    $('video source[src], video[src]').each((_, el) => {\n      add(\n        $(el).attr('src'),\n        $(el).attr('label') || $(el).attr('res') || $(el).attr('data-res') || ''\n      );\n    });\n\n    // Keep broader extraction as a fallback if the player markup changes.\n    if (!streams.length) {\n      for (const media of mediaUrlsFromHtml($, response.data, finalUrl)) add(media.url, media.label);\n    }\n\n    const result = dedupeStreams(streams).slice(0, 8);\n    cache.set(key, result, result.length ? 10 * 60 : 60);\n    return result;\n  } catch (error) {\n    console.warn(`[direct-online] video ${item.id}: ${error.message}`);\n    return [];\n  }\n}\n"""
if old not in text:
    raise SystemExit('streamsForDirectOnlineVideo block not found')
text = text.replace(old, new, 1)

# Generic resolver page resolution should also fall back to HTML when the
# resolver responds successfully but with an empty source list.
old = """      cache.set(key, result, result.length ? 10 * 60 : 60);\n      return result;\n    } catch (error) {\n      console.warn(`[resolver] page ${pageUrl}: ${error.message}`);\n    }\n  }\n\n  try {"""
new = """      if (result.length) {\n        cache.set(key, result, 10 * 60);\n        return result;\n      }\n    } catch (error) {\n      console.warn(`[resolver] page ${pageUrl}: ${error.message}`);\n    }\n  }\n\n  try {"""
if old not in text:
    raise SystemExit('resolver page block not found')
text = text.replace(old, new, 1)

path.write_text(text)
