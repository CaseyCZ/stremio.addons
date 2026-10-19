'use strict';

const { qualityLabel } = require('./stream-quality.js');
const { voeSubtitles } = require('./resolvers/voe-subtitles.js');

const { languageCode, languageLabel, parseGroup } = require('./group-labels.js');

function subtitleTracks(streams) {
  const seen = new Set(), out = [];
  for (const stream of streams || []) {
    const candidates = [];
    for (const sub of Array.isArray(stream?.subtitles) ? stream.subtitles : []) {
      if (sub?.url) candidates.push({ ...sub, lang: languageCode(sub.lang) });
    }
    for (const raw of [stream?.externalUrl, stream?.url]) {
      try {
        const parsed = new URL(raw);
        candidates.push(...voeSubtitles(raw, out.length));
        const keys = ['sub_url', 'sub_file', 'sub1', ...Array.from({ length: 8 }, (_, i) => `c${i + 1}_file`)];
        for (const key of keys) {
          const url = parsed.searchParams.get(key);
          if (!url) continue;
          const prefix = key.match(/^(c\d+)_file$/)?.[1] || (key === 'sub1' ? 'sub1' : 'sub');
          const hint = parsed.searchParams.get(prefix + '_lang') ||
            parsed.searchParams.get(prefix + '_label') ||
            parsed.searchParams.get('sub_lang') || parsed.searchParams.get('sub_label');
          candidates.push({ url, lang: languageCode(hint) });
        }
      } catch {}
    }
    for (const sub of candidates) {
      if (typeof sub.url !== 'string' || !/^https?:\/\//i.test(sub.url) || seen.has(sub.url)) continue;
      seen.add(sub.url);
      out.push({ id: sub.id || 'bombuj-sub-' + (out.length + 1), url: sub.url, lang: languageCode(sub.lang) });
    }
  }
  return out;
}

function groupText(stream) {
  return String(stream?.description || '').split(/\s*•\s*/)[0].trim().replace(/^[^\p{L}]+/u, '');
}

function titleLine(stream, symbol) {
  return String(stream?.title || '').split(/\r?\n/).find(line => line.startsWith(symbol + ' '))?.slice(symbol.length + 1) || '';
}

function audioLabel(stream) {
  const group = parseGroup(groupText(stream));
  if (group.audio.length) return group.audio.map(languageLabel).join(' / ');
  if (group.hasSubtitles && !group.hasAudio) return '🌐 Původní';
  if (group.raw && group.raw !== 'Bombuj') return '🌐 ' + group.raw;
  return titleLine(stream, '🎧') || '🌐 Neurčeno';
}

function subtitleLabel(stream) {
  const subs = subtitleTracks([stream]);
  const codes = [...new Set(subs.map(sub => sub.lang).filter(lang => lang !== 'und'))];
  if (codes.length) return codes.map(languageLabel).join(' • ');

  const group = parseGroup(groupText(stream));
  const declared = [...group.subtitles];
  for (const raw of [stream?.externalUrl, stream?.url]) {
    try {
      const parsed = new URL(raw);
      for (const [key, value] of parsed.searchParams) {
        if (!/^(?:c\d+|sub\d*)_(?:label|lang)$/.test(key)) continue;
        declared.push(...parseGroup(value).audio);
      }
    } catch {}
  }
  const labels = [...new Set(declared)].map(languageLabel);
  // Website declarations label a section, never create subtitle files.
  if (labels.length) return labels.join(' / ') + (subs.length ? '' : ' (Bombuj)');
  if (subs.length) return 'Titulky';
  if (group.hasSubtitles) return group.raw + ' (Bombuj)';
  return titleLine(stream, '💬') || 'Neuvedeny';
}

function providerLabel(stream) {
  const named = String(stream?.name || '').replace(/^Bombuj\s*•\s*/i, '').trim();
  if (named && !/^(?:Direct|\d{3,4}p|4K|HD|SD|HDR)$/i.test(named)) return named;
  const previous = String(stream?.title || '').split(/\r?\n/)
    .find(line => /^(?:🎬|🌐).*? • .+/.test(line));
  return previous?.match(/ • (.+)$/)?.[1] || named || 'Zdroj';
}

function formatBombujStream(stream) {
  const provider = providerLabel(stream), direct = !!stream?.url;
  const quality = qualityLabel(stream);
  const subtitles = subtitleTracks([stream]);
  return {
    ...stream,
    name: 'Bombuj • ' + (direct ? quality : provider),
    title: '🎧 ' + audioLabel(stream) + '\n💬 ' + subtitleLabel(stream) +
      '\n' + (direct ? '🎬 ' + quality : '🌐 Web player • ' + provider),
    description: undefined,
    subtitles: subtitles.length ? subtitles : undefined
  };
}

module.exports = { subtitleTracks, audioLabel, subtitleLabel, providerLabel, formatBombujStream };
