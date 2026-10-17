from pathlib import Path
import json

p = Path('api/sktorrent.js')
s = p.read_text()

old_name = """        const name = String(link.attr('title') || link.find('img').attr('alt') || link.text() || '').replace(/\\s+/g, ' ').trim();
"""
new_name = """        const name = String(link.text() || link.attr('title') || link.find('img').attr('alt') || '').replace(/\\s+/g, ' ').trim();
"""
if old_name not in s:
    raise SystemExit('name parser block not found')
s = s.replace(old_name, new_name, 1)

old_lang = r"""function languageLabel(value) {
  const text = String(value || '');
  const langs = [];
  if (/\b(CZ|CS|CZE|CES)\b/i.test(text)) langs.push('🇨🇿 CZ');
  if (/\b(SK|SLK|SLO)\b/i.test(text)) langs.push('🇸🇰 SK');
  if (/\b(EN|ENG)\b/i.test(text)) langs.push('🇬🇧 EN');
  if (/\b(PL|POL)\b/i.test(text)) langs.push('🇵🇱 PL');
  if (/\b(DE|GER|DEU)\b/i.test(text)) langs.push('🇩🇪 DE');
  if (/\b(HU|HUN)\b/i.test(text)) langs.push('🇭🇺 HU');
  return [...new Set(langs)].join(' • ');
}
"""
new_lang = r"""const LANGUAGE_DISPLAY = {
  CZ: '🇨🇿 CZ',
  SK: '🇸🇰 SK',
  EN: '🇬🇧 EN',
  PL: '🇵🇱 PL',
  DE: '🇩🇪 DE',
  HU: '🇭🇺 HU',
  FR: '🇫🇷 FR',
  ES: '🇪🇸 ES',
  IT: '🇮🇹 IT',
  RU: '🇷🇺 RU',
  UA: '🇺🇦 UA'
};

function languageCodesFromText(value) {
  const text = String(value || '');
  const codes = [];
  if (/\b(CZ|CS|CZE|CES)\b/i.test(text)) codes.push('CZ');
  if (/\b(SK|SLK|SLO)\b/i.test(text)) codes.push('SK');
  if (/\b(EN|ENG)\b/i.test(text)) codes.push('EN');
  if (/\b(PL|POL)\b/i.test(text)) codes.push('PL');
  if (/\b(DE|GER|DEU)\b/i.test(text)) codes.push('DE');
  if (/\b(HU|HUN)\b/i.test(text)) codes.push('HU');
  if (/\b(FR|FRE|FRA)\b/i.test(text)) codes.push('FR');
  if (/\b(ES|SPA)\b/i.test(text)) codes.push('ES');
  if (/\b(IT|ITA)\b/i.test(text)) codes.push('IT');
  if (/\b(RU|RUS)\b/i.test(text)) codes.push('RU');
  if (/\b(UA|UKR)\b/i.test(text)) codes.push('UA');
  return [...new Set(codes)];
}

function formatLanguageCodes(codes) {
  return [...new Set((codes || []).filter(Boolean))]
    .map(code => LANGUAGE_DISPLAY[code] || `🌐 ${code}`)
    .join(' • ');
}

function languageLabel(value) {
  return formatLanguageCodes(languageCodesFromText(value));
}

function flagLanguageCode(src) {
  const match = String(src || '').match(/\/flag\/([a-z]{2,3})\.png(?:$|[?#])/i);
  if (!match) return null;
  return ({
    cz: 'CZ', cs: 'CZ', cze: 'CZ',
    sk: 'SK', slk: 'SK', slo: 'SK',
    gb: 'EN', en: 'EN', eng: 'EN', us: 'EN',
    pl: 'PL', pol: 'PL',
    de: 'DE', deu: 'DE', ger: 'DE',
    hu: 'HU', hun: 'HU',
    fr: 'FR', fra: 'FR', fre: 'FR',
    es: 'ES', spa: 'ES',
    it: 'IT', ita: 'IT',
    ru: 'RU', rus: 'RU',
    ua: 'UA', ukr: 'UA'
  })[match[1].toLowerCase()] || null;
}

function subtitleHintFromCategory(category) {
  const text = String(category || '');
  if (/bez\s+titulk/i.test(text)) return 'Bez titulků';
  if (/s\s+titulk/i.test(text)) return 'Titulky';
  return '';
}
"""
if old_lang not in s:
    raise SystemExit('languageLabel block not found')
s = s.replace(old_lang, new_lang, 1)

old_category = """        const category = cell.find('b').first().text().trim();
        if (category && !/(film|seri|dokum|tv)/i.test(category)) return;
        const sizeMatch = text.match(/Velkost\\s*([^|]+)/i);
"""
new_category = """        const category = cell.find('b').first().text().trim();
        if (category && !/(film|seri|dokum|tv)/i.test(category)) return;
        const flagLanguages = [...new Set(cell.find('img[src*="/flag/"]').map((_, flag) =>
          flagLanguageCode($(flag).attr('src'))
        ).get().filter(Boolean))];
        const sizeMatch = text.match(/Velkost\\s*([^|]+)/i);
"""
if old_category not in s:
    raise SystemExit('category parser block not found')
s = s.replace(old_category, new_category, 1)

old_push = """          category,
          size: sizeMatch ? sizeMatch[1].trim() : '?',
"""
new_push = """          category,
          flagLanguages,
          size: sizeMatch ? sizeMatch[1].trim() : '?',
"""
if old_push not in s:
    raise SystemExit('result push block not found')
s = s.replace(old_push, new_push, 1)

old_output = """    const combined = `${candidate.name} ${file.path}`;
    const quality = qualityFromText(combined);
    const tags = codecTags(combined);
    const language = languageLabel(combined);
    const size = candidate.size !== '?' ? candidate.size : humanBytes(file.length);
"""
new_output = """    const combined = `${candidate.name} ${file.path}`;
    const quality = qualityFromText(combined);
    const tags = codecTags(combined);
    const language = formatLanguageCodes(candidate.flagLanguages) || languageLabel(combined);
    const subtitleHint = subtitleHintFromCategory(candidate.category);
    const size = candidate.size !== '?' ? candidate.size : humanBytes(file.length);
"""
if old_output not in s:
    raise SystemExit('torrent display metadata block not found')
s = s.replace(old_output, new_output, 1)

old_lines = """    const titleLines = [
      language ? `🎧 ${language}` : null,
      releaseName ? `🎞 ${releaseName}` : null,
      details
    ].filter(Boolean);
"""
new_lines = """    const titleLines = [
      language ? `🎧 ${language}` : null,
      subtitleHint ? `💬 ${subtitleHint}` : null,
      releaseName ? `🎞 ${releaseName}` : null,
      details
    ].filter(Boolean);
"""
if old_lines not in s:
    raise SystemExit('torrent titleLines block not found')
s = s.replace(old_lines, new_lines, 1)
p.write_text(s)

addon = Path('addon.js')
a = addon.read_text()
a = a.replace('combined-v15:', 'combined-v16:')
addon.write_text(a)

pkg_path = Path('package.json')
pkg = json.loads(pkg_path.read_text())
pkg['version'] = '0.1.13'
pkg_path.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + '\n')
