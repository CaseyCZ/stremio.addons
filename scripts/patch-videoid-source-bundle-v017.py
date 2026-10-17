from pathlib import Path
import json

# api/sktonline.js: preserve SKTOnline videoId as internal source identity and
# expose one resolver returning both clean Stremio streams and videoIds.
p = Path('api/sktonline.js')
s = p.read_text()

old = """  const streams = checks.filter(Boolean).map(item => {\n    const stream = makeStream('SKTOnline', pageTitle || 'SKTOnline', item.url, item.quality, `${ONLINE_BASE_URL}/`);\n    stream.behaviorHints = { notWebReady: false };\n    return stream;\n  });\n"""
new = """  const streams = checks.filter(Boolean).map(item => {\n    const stream = makeStream('SKTOnline', pageTitle || 'SKTOnline', item.url, item.quality, `${ONLINE_BASE_URL}/`);\n    stream.behaviorHints = { notWebReady: false };\n    // Internal identity only. findOnlineSourceBundle strips this before the\n    // stream is returned to Stremio, while keeping videoId for subtitles.\n    stream._sktVideoId = id;\n    return stream;\n  });\n"""
if old not in s:
    raise SystemExit('streamsForKnownOnlineVideoId anchor not found')
s = s.replace(old, new, 1)

old = """async function findOnlineStreams({ imdbId, titles, type, season, episode, sktUsername = '', sktPassword = '' }) {\n  const queries = buildQueries(titles, type, season, episode);\n  let sktClient = null;\n  if (sktUsername && sktPassword) {\n    try { sktClient = getClient(sktUsername, sktPassword); } catch (_) {}\n  }\n\n  const [fromDirectOnline, fromTorrentDetails, sledujToByTitle] = await Promise.all([\n    directProviderWithin(findDirectOnlineByTitle(queries, titles), 18000, 'SKTOnline title search'),\n    directProviderWithin(findFromSktorrentDetails(queries, titles, imdbId, sktClient), 18000, 'SKTorrent detail players'),\n    directProviderWithin(findSledujtetoByTitle(queries, titles), 12000, 'SledujTo title search')\n  ]);\n\n  return dedupeStreams([\n    ...fromDirectOnline,\n    ...fromTorrentDetails,\n    ...sledujToByTitle\n  ]).slice(0, 48);\n}\n\nmodule.exports = {\n  findOnlineStreams,\n  findDirectOnlineByTitle,\n  findFromSktorrentDetails\n};\n"""
new = """function videoIdFromResolvedStream(stream) {\n  const explicit = String(stream && stream._sktVideoId || '').trim();\n  if (/^\\d+$/.test(explicit)) return explicit;\n  try {\n    const parsed = new URL(String(stream && stream.url || ''));\n    const match = decodeURIComponent(parsed.pathname || '').match(/\\/h264\\/(\\d+)_((?:2160|1440|1080|720|480|360|240)p)\\.mp4$/i);\n    return match ? match[1] : null;\n  } catch (_) {\n    return null;\n  }\n}\n\nfunction cleanResolvedStream(stream) {\n  if (!stream || typeof stream !== 'object') return stream;\n  const { _sktVideoId, ...clean } = stream;\n  return clean;\n}\n\nasync function findOnlineSourceBundle({ imdbId, titles, type, season, episode, sktUsername = '', sktPassword = '' }) {\n  const queries = buildQueries(titles, type, season, episode);\n  let sktClient = null;\n  if (sktUsername && sktPassword) {\n    try { sktClient = getClient(sktUsername, sktPassword); } catch (_) {}\n  }\n\n  const [fromDirectOnline, fromTorrentDetails, sledujToByTitle] = await Promise.all([\n    directProviderWithin(findDirectOnlineByTitle(queries, titles), 18000, 'SKTOnline title search'),\n    directProviderWithin(findFromSktorrentDetails(queries, titles, imdbId, sktClient), 18000, 'SKTorrent detail players'),\n    directProviderWithin(findSledujtetoByTitle(queries, titles), 12000, 'SledujTo title search')\n  ]);\n\n  const resolved = dedupeStreams([\n    ...fromDirectOnline,\n    ...fromTorrentDetails,\n    ...sledujToByTitle\n  ]).slice(0, 48);\n\n  const videoIds = dedupe(resolved.map(videoIdFromResolvedStream).filter(Boolean));\n  return {\n    streams: resolved.map(cleanResolvedStream),\n    videoIds\n  };\n}\n\nasync function findOnlineStreams(options) {\n  return (await findOnlineSourceBundle(options)).streams;\n}\n\nmodule.exports = {\n  findOnlineStreams,\n  findOnlineSourceBundle,\n  findDirectOnlineByTitle,\n  findFromSktorrentDetails\n};\n"""
if old not in s:
    raise SystemExit('findOnlineStreams export block not found')
s = s.replace(old, new, 1)
p.write_text(s)

# addon.js: cache the source identity separately from combined Direct+P2P
# streams and reuse it in the subtitles resource.
p = Path('addon.js')
s = p.read_text()

old = "const { findOnlineStreams } = require('./api/sktonline');"
new = "const { findOnlineStreams, findOnlineSourceBundle } = require('./api/sktonline');"
if old not in s:
    raise SystemExit('addon import anchor not found')
s = s.replace(old, new, 1)

old = "const subtitleProbeCache = new NodeCache({ stdTTL: 60 * 60, checkperiod: 5 * 60, maxKeys: 4000 });"
new = "const subtitleProbeCache = new NodeCache({ stdTTL: 60 * 60, checkperiod: 5 * 60, maxKeys: 4000 });\nconst sourceIdentityCache = new NodeCache({ stdTTL: 10 * 60, checkperiod: 60, maxKeys: 2000 });"
if old not in s:
    raise SystemExit('cache anchor not found')
s = s.replace(old, new, 1)

old = """  const combinedKey = `combined-v13:${configFingerprint(cfg)}:${type}:${requestId}`;\n  let directStreams = streamCache.get(combinedKey);\n\n  if (!Array.isArray(directStreams)) {\n    const meta = await cinemeta.getMeta(type, parsed.imdbId);\n    const titles = titleCandidates(meta, type);\n    if (!titles.length) {\n      subtitleCache.set(lookupKey, [], 2 * 60);\n      return [];\n    }\n    directStreams = await resolveWithin(findOnlineStreams({\n      imdbId: parsed.imdbId,\n      titles,\n      type,\n      season: parsed.season,\n      episode: parsed.episode,\n      sktUsername: cfg.enableTorrents ? cfg.sktUsername : '',\n      sktPassword: cfg.enableTorrents ? cfg.sktPassword : ''\n    }), 22000, 'subtitle-direct-detail');\n  }\n\n  const videoIds = extractSktOnlineVideoIds(directStreams).slice(0, 8);\n"""
new = """  const fingerprint = configFingerprint(cfg);\n  const combinedKey = `combined-v13:${fingerprint}:${type}:${requestId}`;\n  const sourceKey = `source-videoids-v1:${fingerprint}:${type}:${requestId}`;\n  let videoIds = sourceIdentityCache.get(sourceKey);\n\n  // Backward-compatible fallback for a stream response cached before the\n  // source-identity resolver ran. Normally subtitles reuse sourceKey directly.\n  if (!Array.isArray(videoIds) || !videoIds.length) {\n    const combinedStreams = streamCache.get(combinedKey);\n    if (Array.isArray(combinedStreams)) {\n      videoIds = extractSktOnlineVideoIds(combinedStreams);\n    }\n  }\n\n  if (!Array.isArray(videoIds) || !videoIds.length) {\n    const meta = await cinemeta.getMeta(type, parsed.imdbId);\n    const titles = titleCandidates(meta, type);\n    if (!titles.length) {\n      subtitleCache.set(lookupKey, [], 2 * 60);\n      return [];\n    }\n    const bundleRaw = await resolveWithin(findOnlineSourceBundle({\n      imdbId: parsed.imdbId,\n      titles,\n      type,\n      season: parsed.season,\n      episode: parsed.episode,\n      sktUsername: cfg.enableTorrents ? cfg.sktUsername : '',\n      sktPassword: cfg.enableTorrents ? cfg.sktPassword : ''\n    }), 22000, 'subtitle-direct-source');\n    const bundle = bundleRaw && !Array.isArray(bundleRaw) ? bundleRaw : { streams: [], videoIds: [] };\n    videoIds = Array.isArray(bundle.videoIds) ? bundle.videoIds : [];\n    if (videoIds.length) sourceIdentityCache.set(sourceKey, videoIds, 10 * 60);\n  }\n\n  videoIds = uniqueStrings(videoIds).slice(0, 8);\n"""
if old not in s:
    raise SystemExit('subtitle source block not found')
s = s.replace(old, new, 1)

old = """    const directPromise = cfg.enableOnline\n      ? resolveWithin(findOnlineStreams({\n          imdbId: parsed.imdbId,\n          titles,\n          type: req.params.type,\n          season: parsed.season,\n          episode: parsed.episode,\n          sktUsername: cfg.enableTorrents ? cfg.sktUsername : '',\n          sktPassword: cfg.enableTorrents ? cfg.sktPassword : ''\n        }), 22000, 'direct-detail')\n      : Promise.resolve([]);\n"""
new = """    const directPromise = cfg.enableOnline\n      ? resolveWithin(findOnlineSourceBundle({\n          imdbId: parsed.imdbId,\n          titles,\n          type: req.params.type,\n          season: parsed.season,\n          episode: parsed.episode,\n          sktUsername: cfg.enableTorrents ? cfg.sktUsername : '',\n          sktPassword: cfg.enableTorrents ? cfg.sktPassword : ''\n        }), 22000, 'direct-source')\n      : Promise.resolve({ streams: [], videoIds: [] });\n"""
if old not in s:
    raise SystemExit('stream directPromise block not found')
s = s.replace(old, new, 1)

old = """    const [directRaw, torrents] = await Promise.all([directPromise, torrentPromise]);\n    const direct = normalizePlaybackStreams(directRaw);\n    const streams = dedupeCombinedStreams([...direct, ...torrents]);\n\n    streamCache.set(cacheKey, streams, streams.length ? 5 * 60 : 60);\n"""
new = """    const [directRaw, torrents] = await Promise.all([directPromise, torrentPromise]);\n    const directBundle = directRaw && !Array.isArray(directRaw)\n      ? directRaw\n      : { streams: Array.isArray(directRaw) ? directRaw : [], videoIds: [] };\n    const direct = normalizePlaybackStreams(Array.isArray(directBundle.streams) ? directBundle.streams : []);\n    const videoIds = uniqueStrings(Array.isArray(directBundle.videoIds) ? directBundle.videoIds : []);\n    const streams = dedupeCombinedStreams([...direct, ...torrents]);\n\n    if (videoIds.length) {\n      const sourceKey = `source-videoids-v1:${configFingerprint(cfg)}:${req.params.type}:${req.params.id}`;\n      sourceIdentityCache.set(sourceKey, videoIds, 10 * 60);\n      console.log(`[source] ${req.params.type}/${req.params.id}: videoIds=${videoIds.join(',')}`);\n    }\n    streamCache.set(cacheKey, streams, streams.length ? 5 * 60 : 60);\n"""
if old not in s:
    raise SystemExit('stream bundle result block not found')
s = s.replace(old, new, 1)

old = """    subtitleProbeCacheKeys: subtitleProbeCache.keys().length\n"""
new = """    subtitleProbeCacheKeys: subtitleProbeCache.keys().length,\n    sourceIdentityCacheKeys: sourceIdentityCache.keys().length\n"""
if old not in s:
    raise SystemExit('health cache block not found')
s = s.replace(old, new, 1)
p.write_text(s)

# Bump version so the deployed build is unambiguous.
p = Path('package.json')
data = json.loads(p.read_text())
if data.get('version') != '0.1.6':
    raise SystemExit(f"unexpected package version: {data.get('version')}")
data['version'] = '0.1.7'
p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
