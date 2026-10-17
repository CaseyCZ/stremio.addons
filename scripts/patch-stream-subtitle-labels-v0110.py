from pathlib import Path
import json

p = Path('addon.js')
s = p.read_text()
needle = """function normalizePlaybackStreams(streams) {\n  if (!Array.isArray(streams)) return [];\n  return streams.map(stream => {\n    if (!stream || !String(stream.name || '').startsWith('SKTOnline • ')) return stream;\n    try {\n      const url = new URL(String(stream.url || ''));\n      const host = url.hostname.toLowerCase();\n      const isSktCdn = host === 'sktorrent.eu' || host.endsWith('.sktorrent.eu');\n      if (url.protocol !== 'https:' || !isSktCdn || !/\\.mp4$/i.test(url.pathname)) return stream;\n    } catch (_) {\n      return stream;\n    }\n\n    const behaviorHints = { ...(stream.behaviorHints || {}) };\n    delete behaviorHints.proxyHeaders;\n    behaviorHints.notWebReady = false;\n    return { ...stream, behaviorHints };\n  });\n}\n"""
insert = needle + """
function sktVideoIdFromStream(stream) {
  if (!stream || !String(stream.name || '').startsWith('SKTOnline • ')) return null;
  try {
    const url = new URL(String(stream.url || ''));
    const match = decodeURIComponent(url.pathname || '').match(/\\/h264\\/(\\d+)_((?:2160|1440|1080|720|480|360|240)p)\\.mp4$/i);
    return match ? match[1] : null;
  } catch (_) {
    return null;
  }
}

function replaceStreamSubtitleLine(title, value) {
  const lines = String(title || '').split('\\n');
  const text = `💬 ${value || 'Bez titulků'}`;
  const index = lines.findIndex(line => /^💬\\s/.test(line));
  if (index >= 0) lines[index] = text;
  else if (lines.length > 1) lines.splice(1, 0, text);
  else lines.push(text);
  return lines.join('\\n');
}

async function decorateSktOnlineSubtitleLabels(streams) {
  if (!Array.isArray(streams) || !streams.length) return streams || [];
  const videoIds = uniqueStrings(streams.map(sktVideoIdFromStream).filter(Boolean));
  if (!videoIds.length) return streams;

  const availability = new Map(await Promise.all(videoIds.map(async videoId => {
    const [hasCz, hasSk] = await Promise.all([
      subtitleUrlExists(`https://online.sktorrent.eu/media/videos/vtt/${videoId}/cze.vtt`),
      subtitleUrlExists(`https://online.sktorrent.eu/media/videos/vtt/${videoId}/slo.vtt`)
    ]);
    const labels = [];
    if (hasCz) labels.push('🇨🇿 CZ');
    if (hasSk) labels.push('🇸🇰 SK');
    return [videoId, labels];
  })));

  return streams.map(stream => {
    const videoId = sktVideoIdFromStream(stream);
    if (!videoId) return stream;
    const labels = availability.get(videoId) || [];
    return {
      ...stream,
      title: replaceStreamSubtitleLine(stream.title, labels.length ? labels.join(' • ') : 'Bez titulků')
    };
  });
}
"""
if needle not in s:
    raise SystemExit('normalizePlaybackStreams block not found')
s = s.replace(needle, insert, 1)
s = s.replace("const cacheKey = `combined-v13:${configFingerprint(cfg)}:${req.params.type}:${req.params.id}`;", "const cacheKey = `combined-v14:${configFingerprint(cfg)}:${req.params.type}:${req.params.id}`;")
s = s.replace("const combinedKey = `combined-v13:${fingerprint}:${type}:${requestId}`;", "const combinedKey = `combined-v14:${fingerprint}:${type}:${requestId}`;")
old = "const direct = normalizePlaybackStreams(Array.isArray(directBundle.streams) ? directBundle.streams : []);"
new = "const direct = await decorateSktOnlineSubtitleLabels(normalizePlaybackStreams(Array.isArray(directBundle.streams) ? directBundle.streams : []));"
if old not in s:
    raise SystemExit('direct normalize line not found')
s = s.replace(old, new, 1)
p.write_text(s)

pkg_path = Path('package.json')
pkg = json.loads(pkg_path.read_text())
pkg['version'] = '0.1.10'
pkg_path.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + '\n')
