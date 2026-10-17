from pathlib import Path
import json

# 1) Direct lookup: do not let the slow SKTorrent-detail branch block the whole
# direct result past addon.js's 22s timeout. Also fix the pagination regex typo.
p = Path('api/sktonline.js')
s = p.read_text()
old = "const match = href.match(/[?&]page=(\\di+)/i);"
new = "const match = href.match(/[?&]page=(\\d+)/i);"
if old not in s:
    raise SystemExit('missing pagination regex anchor')
s = s.replace(old, new, 1)
old = "directProviderWithin(findFromSktorrentDetails(queries, titles, imdbId, sktClient), 60000, 'SKTorrent detail players')"
new = "directProviderWithin(findFromSktorrentDetails(queries, titles, imdbId, sktClient), 18000, 'SKTorrent detail players')"
if old not in s:
    raise SystemExit('missing direct detail timeout anchor')
s = s.replace(old, new, 1)
p.write_text(s)

# 2) Sosac overlay: only values from IMDb-named fields may be interpreted as
# IMDb IDs. Never turn generic numeric fields such as _id into fake tt IDs.
p = Path('api/sosac-overlay.js')
s = p.read_text()
start = s.find('function extractImdb(')
end = s.find('\nfunction itemYear(', start)
if start < 0 or end < 0:
    raise SystemExit('missing extractImdb block')
replacement = r'''function extractImdb(value, depth = 0, seen = new Set()) {
  if (depth > 4 || value === null || value === undefined) return null;
  if (typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);

  const preferred = ['imdb', 'imdb_id', 'imdbId', 'imdbid', 'imdbID', 'm'];
  for (const key of preferred) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const candidate = value[key];
    const direct = normalizeImdb(candidate);
    if (direct) return direct;
    if (candidate && typeof candidate === 'object') {
      const nested = extractImdb(candidate, depth + 1, seen);
      if (nested) return nested;
    }
  }

  for (const [key, nested] of Object.entries(value)) {
    if (preferred.includes(key) || !nested || typeof nested !== 'object') continue;
    const found = extractImdb(nested, depth + 1, seen);
    if (found) return found;
  }
  return null;
}
'''
s = s[:start] + replacement + s[end:]
p.write_text(s)

# 3) Bump addon version so Stremio refreshes the manifest/resources/idPrefixes.
p = Path('package.json')
data = json.loads(p.read_text())
if data.get('version') != '0.1.5':
    raise SystemExit(f"unexpected package version: {data.get('version')}")
data['version'] = '0.1.6'
p.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
