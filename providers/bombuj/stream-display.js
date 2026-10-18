'use strict';

// One presentation formatter for Bombuj's custom movie AND series streams.
// Formatting is metadata-only; video URLs and subtitles remain provider-hosted.
function subtitleTracks(streams) {
  const seen = new Set();
  const out = [];
  for (const stream of streams || []) {
    const candidates = [];
    for (const sub of Array.isArray(stream?.subtitles) ? stream.subtitles : []) {
      if (sub?.url) candidates.push({ url: sub.url, lang: sub.lang || 'ces' });
    }
    for (const raw of [stream?.externalUrl, stream?.url]) {
      try {
        const parsed = new URL(raw);
        const keys = ['sub_url', 'sub_file', 'sub1', 'c1_file', 'c2_file', 'c3_file'];
        for (const key of keys) {
          const url = parsed.searchParams.get(key);
          if (url) candidates.push({ url, lang: 'ces' });
        }
      } catch {}
    }
    for (const sub of candidates) {
      if (typeof sub.url !== 'string' || !/^https?:\/\//i.test(sub.url) || seen.has(sub.url)) continue;
      seen.add(sub.url);
      out.push({ id: 'bombuj-sub-' + (out.length + 1), url: sub.url, lang: sub.lang || 'ces' });
    }
  }
  return out;
}

function audioLabel(stream) {
  // Source's language group is the FIRST segment of index.js description,
  // for example "CZ dabing • externí player" or "EN dab/tit".
  const language = String(stream?.description || '').split(/\s*•\s*/)[0].trim();
  if (/\bCZ\s*dab/i.test(language) || /^CZ$/i.test(language)) return '🇨🇿 CZ';
  if (/\bSK\s*dab/i.test(language) || /^SK$/i.test(language)) return '🇸🇰 SK';
  if (/\bEN\s*dab/i.test(language) || /^EN$/i.test(language)) return '🇬🇧 EN';
  // An English-with-subtitles section means English audio, but not
  // necessarily an attached, working CZ/SK subtitle track.
  if (/^EN\s*[\w/ ]*tit/i.test(language)) return '🇬🇧 EN';
  return '🌐 Neurčeno';
}

function subtitleLabel(stream) {
  const subs = subtitleTracks([stream]);
  if (!subs.length) return 'Bez titulků';

  const subtitleUrls = [stream?.externalUrl, stream?.url].filter(Boolean);
  for (const raw of subtitleUrls) {
    try {
      const parsed = new URL(raw);
      const labels = ['c1_label', 'c2_label', 'c3_label', 'sub_label']
        .map(key => parsed.searchParams.get(key) || '').join(' ');
      if (/CZ\s*[/+-]\s*SK|CZSK|SK\s*[/+-]\s*CZ/i.test(labels)) return '🇨🇿 CZ • 🇸🇰 SK';
    } catch {}
  }
  const langs = new Set(subs.map(sub => String(sub.lang || '').toLowerCase()));
  const cz = [...langs].some(lang => /^(?:cs|cz|ces|cze)$/.test(lang));
  const sk = [...langs].some(lang => /^(?:sk|slk|slo)$/.test(lang));
  if (cz && sk) return '🇨🇿 CZ • 🇸🇰 SK';
  if (sk) return '🇸🇰 SK';
  if (cz) return '🇨🇿 CZ';
  if ([...langs].some(lang => /^(?:en|eng)$/.test(lang))) return '🇬🇧 EN';
  return 'Titulky';
}

function formatBombujStream(stream) {
  const provider = String(stream?.name || '').replace(/^Bombuj\s*•\s*/i, '').trim() || 'Zdroj';
  const direct = !!stream?.url;
  return {
    ...stream,
    name: direct ? 'Bombuj • Direct' : 'Bombuj • ' + provider,
    title: '🎧 ' + audioLabel(stream) + '\n💬 ' + subtitleLabel(stream) +
      '\n' + (direct ? '🎬 Direct • ' : '🌐 Web player • ') + provider,
    description: undefined
  };
}

module.exports = { subtitleTracks, audioLabel, subtitleLabel, formatBombujStream };
