'use strict';
// Observed Bombuj VOE format: label;ISO-language;HTTPS-URL.
// Only this explicit format is accepted; no language is inferred from CZ/SK.
function voeSubtitles(embed, index) {
  try {
    const parsed = new URL(embed);
    if (!['voe.sx', 'voe2.sx'].includes(parsed.hostname.replace(/^www\./, ''))) return [];
    const value = parsed.searchParams.get('subtitles') || '';
    if (value.length > 8192) return [];
    const match = value.match(/^([^;]*);([a-z]{2,3});(https:\/\/[^\s]+)$/i);
    if (!match) return [];
    const url = new URL(match[3]);
    if (url.protocol !== 'https:' || url.username || url.password) return [];
    const lang = { cs: 'ces', cz: 'ces', ces: 'ces', cze: 'ces', sk: 'slk', slk: 'slk', slo: 'slk', en: 'eng', eng: 'eng' }[match[2].toLowerCase()];
    if (!lang) return [];
    return [{ id: `bombuj-voe-${index}-${lang}`, url: url.href, lang }];
  } catch { return []; }
}
module.exports = { voeSubtitles };
