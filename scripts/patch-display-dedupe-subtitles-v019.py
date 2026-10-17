from pathlib import Path

repo = Path('.')

# Patch api/sktonline.js
p = repo / 'api/sktonline.js'
s = p.read_text()
old = """function cleanResolvedStream(stream) {\n  if (!stream || typeof stream !== 'object') return stream;\n  const { _sktVideoId, ...clean } = stream;\n  return clean;\n}\n\nasync function findOnlineSourceBundle({ imdbId, titles, type, season, episode, sktUsername = '', sktPassword = '' }) {\n"""
new = """function cleanResolvedStream(stream) {\n  if (!stream || typeof stream !== 'object') return stream;\n  const { _sktVideoId, ...clean } = stream;\n  return clean;\n}\n\nfunction sktDisplayVariantKey(stream) {\n  const videoId = videoIdFromResolvedStream(stream);\n  if (!videoId || !String(stream && stream.name || '').startsWith('SKTOnline • ')) return null;\n  const title = String(stream && stream.title || '');\n  const audio = (title.match(/^🎧\\s*(.+)$/m) || [])[1] || '?';\n  const subtitles = (title.match(/^💬\\s*(.+)$/m) || [])[1] || 'Bez titulků';\n  return `${normalize(audio)}|${normalize(subtitles)}`;\n}\n\nfunction streamQualityNumber(stream) {\n  const text = `${String(stream && stream.name || '')} ${String(stream && stream.url || '')}`;\n  const match = text.match(/\\b(2160|1440|1080|720|480|360|240)p\\b/i);\n  return match ? Number(match[1]) : 0;\n}\n\nfunction selectBestSktDisplayStreams(streams) {\n  const groups = new Map();\n  (streams || []).forEach((stream, index) => {\n    const variant = sktDisplayVariantKey(stream);\n    const videoId = videoIdFromResolvedStream(stream);\n    if (!variant || !videoId) return;\n    const key = `${variant}|${videoId}`;\n    let group = groups.get(key);\n    if (!group) {\n      group = { key, variant, videoId, firstIndex: index, count: 0, maxQuality: 0 };\n      groups.set(key, group);\n    }\n    group.count += 1;\n    group.maxQuality = Math.max(group.maxQuality, streamQualityNumber(stream));\n  });\n\n  const winnerByVariant = new Map();\n  for (const group of groups.values()) {\n    const current = winnerByVariant.get(group.variant);\n    if (!current ||\n        group.maxQuality > current.maxQuality ||\n        (group.maxQuality === current.maxQuality && group.count > current.count) ||\n        (group.maxQuality === current.maxQuality && group.count === current.count && group.firstIndex < current.firstIndex)) {\n      winnerByVariant.set(group.variant, group);\n    }\n  }\n\n  const selected = new Set([...winnerByVariant.values()].map(group => group.key));\n  return (streams || []).filter(stream => {\n    const variant = sktDisplayVariantKey(stream);\n    const videoId = videoIdFromResolvedStream(stream);\n    if (!variant || !videoId) return true;\n    return selected.has(`${variant}|${videoId}`);\n  });\n}\n\nasync function findOnlineSourceBundle({ imdbId, titles, type, season, episode, sktUsername = '', sktPassword = '' }) {\n"""
if old not in s:
    raise SystemExit('sktonline insertion anchor not found')
s = s.replace(old, new, 1)
old = """  const resolved = dedupeStreams([\n    ...fromDirectOnline,\n    ...fromTorrentDetails,\n    ...sledujToByTitle\n  ]).slice(0, 48);\n\n  const videoIds = dedupe(resolved.map(videoIdFromResolvedStream).filter(Boolean));\n  return {\n    streams: resolved.map(cleanResolvedStream),\n    videoIds\n  };\n"""
new = """  const resolvedAll = dedupeStreams([\n    ...fromDirectOnline,\n    ...fromTorrentDetails,\n    ...sledujToByTitle\n  ]).slice(0, 48);\n\n  // Keep every healthy SKTOnline videoId internally for subtitles and future\n  // rediscovery, but show only the best source for each audio/subtitle variant.\n  const videoIds = dedupe(resolvedAll.map(videoIdFromResolvedStream).filter(Boolean));\n  const resolved = selectBestSktDisplayStreams(resolvedAll);\n  return {\n    streams: resolved.map(cleanResolvedStream),\n    videoIds\n  };\n"""
if old not in s:
    raise SystemExit('sktonline bundle anchor not found')
s = s.replace(old, new, 1)
p.write_text(s)

# Patch addon.js so subtitle probes use the same SKTOnline SOCKS/WARP proxy.
p = repo / 'addon.js'
s = p.read_text()
old = "const NodeCache = require('node-cache');\n"
new = "const NodeCache = require('node-cache');\nconst { SocksProxyAgent } = require('socks-proxy-agent');\n"
if old not in s:
    raise SystemExit('addon import anchor not found')
s = s.replace(old, new, 1)
old = "const cinemeta = new CinemetaApi();\n"
new = """const cinemeta = new CinemetaApi();\nconst SKTONLINE_PROXY_URL = String(process.env.SKTONLINE_PROXY_URL || '').trim();\nconst sktOnlineSubtitleProxyAgent = SKTONLINE_PROXY_URL ? new SocksProxyAgent(SKTONLINE_PROXY_URL) : null;\n\nfunction subtitleProxyConfig() {\n  return sktOnlineSubtitleProxyAgent\n    ? { httpAgent: sktOnlineSubtitleProxyAgent, httpsAgent: sktOnlineSubtitleProxyAgent, proxy: false }\n    : {};\n}\n"""
if old not in s:
    raise SystemExit('addon cinemeta anchor not found')
s = s.replace(old, new, 1)
old = """    const response = await require('axios').get(url, {\n      timeout: 7000,\n      responseType: 'text',\n"""
new = """    const response = await require('axios').get(url, {\n      timeout: 7000,\n      ...subtitleProxyConfig(),\n      responseType: 'text',\n"""
if old not in s:
    raise SystemExit('subtitle axios anchor not found')
s = s.replace(old, new, 1)
p.write_text(s)

# Bump package version. Lockfile will be refreshed by workflow.
p = repo / 'package.json'
s = p.read_text().replace('"version": "0.1.8"', '"version": "0.1.9"', 1)
p.write_text(s)
