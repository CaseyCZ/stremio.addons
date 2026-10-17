from pathlib import Path
import json

p = Path('api/sktorrent.js')
s = p.read_text()

s = s.replace("else if (/\\b(h\\.?264|x264|avc)\\b/i.test(text)) tags.push('H264');", "else if (/\\b(h\\.?264|x264|avc)\\b/i.test(text)) tags.push('H.264');")

old = """    const size = candidate.size !== '?' ? candidate.size : humanBytes(file.length);\n    const details = [`👥 ${candidate.seeds} seed`, `📦 ${size}`, ...tags].filter(Boolean).join(' • ');\n    const titleLines = [\n      language ? `🎧 ${language}` : null,\n      `🗂️ ${candidate.name}`,\n      details\n    ].filter(Boolean);\n\n    return {\n"""
new = """    const size = candidate.size !== '?' ? candidate.size : humanBytes(file.length);\n    const fileName = String(file.path || '').split('/').pop();\n    const releaseName = fileName\n      .replace(/\\.(?:mkv|mp4|avi|m4v|mov|ts|webm)$/i, '')\n      .replace(/\\s+/g, ' ')\n      .trim();\n    const details = [`👥 ${candidate.seeds} seed`, `📦 ${size}`, ...tags].filter(Boolean).join(' • ');\n    const titleLines = [\n      language ? `🎧 ${language}` : null,\n      releaseName ? `🎞 ${releaseName}` : null,\n      details\n    ].filter(Boolean);\n\n    return {\n"""
if old not in s:
    raise SystemExit('SKTorrent title block not found')
s = s.replace(old, new, 1)

old2 = """        fileName: String(file.path || '').split('/').pop(),\n"""
new2 = """        fileName,\n"""
if old2 not in s:
    raise SystemExit('fileName assignment not found')
s = s.replace(old2, new2, 1)
p.write_text(s)

pkg_path = Path('package.json')
pkg = json.loads(pkg_path.read_text())
pkg['version'] = '0.1.12'
pkg_path.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + '\n')
