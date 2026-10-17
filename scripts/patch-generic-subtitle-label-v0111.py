from pathlib import Path
import json

p = Path('addon.js')
s = p.read_text()
old = """  const availability = new Map(await Promise.all(videoIds.map(async videoId => {\n    const [hasCz, hasSk] = await Promise.all([\n      subtitleUrlExists(`https://online.sktorrent.eu/media/videos/vtt/${videoId}/cze.vtt`),\n      subtitleUrlExists(`https://online.sktorrent.eu/media/videos/vtt/${videoId}/slo.vtt`)\n    ]);\n    const labels = [];\n    if (hasCz) labels.push('🇨🇿 CZ');\n    if (hasSk) labels.push('🇸🇰 SK');\n    return [videoId, labels];\n  })));\n\n  return streams.map(stream => {\n    const videoId = sktVideoIdFromStream(stream);\n    if (!videoId) return stream;\n    const labels = availability.get(videoId) || [];\n    return {\n      ...stream,\n      title: replaceStreamSubtitleLine(stream.title, labels.length ? labels.join(' • ') : 'Bez titulků')\n    };\n  });\n"""
new = """  const availability = new Map(await Promise.all(videoIds.map(async videoId => {\n    const [hasCz, hasSk] = await Promise.all([\n      subtitleUrlExists(`https://online.sktorrent.eu/media/videos/vtt/${videoId}/cze.vtt`),\n      subtitleUrlExists(`https://online.sktorrent.eu/media/videos/vtt/${videoId}/slo.vtt`)\n    ]);\n    return [videoId, Boolean(hasCz || hasSk)];\n  })));\n\n  return streams.map(stream => {\n    const videoId = sktVideoIdFromStream(stream);\n    if (!videoId) return stream;\n    const hasSubtitles = availability.get(videoId) === true;\n    return {\n      ...stream,\n      title: replaceStreamSubtitleLine(stream.title, hasSubtitles ? 'Titulky' : 'Bez titulků')\n    };\n  });\n"""
if old not in s:
    raise SystemExit('subtitle label block not found')
s = s.replace(old, new, 1)
s = s.replace('combined-v14:', 'combined-v15:')
p.write_text(s)

pkg_path = Path('package.json')
pkg = json.loads(pkg_path.read_text())
pkg['version'] = '0.1.11'
pkg_path.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + '\n')
