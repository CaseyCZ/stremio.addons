'use strict';

// Language aliases describe languages, never a fixed set of Bombuj sections.
// New/unrecognized section names remain visible verbatim instead of disappearing.
const entries = [
  ['ces', 'CZ', 'CZ', 'cs cz ces cze czech český čeština české'],
  ['slk', 'SK', 'SK', 'sk slk slo slovak slovenský slovenčina slovenské'],
  ['eng', 'EN', 'GB', 'en eng english anglický angličtina'],
  ['deu', 'DE', 'DE', 'de deu ger german německý němčina'],
  ['fra', 'FR', 'FR', 'fr fra fre french francouzský francouzština'],
  ['spa', 'ES', 'ES', 'es spa spanish španělský španělština'],
  ['pol', 'PL', 'PL', 'pl pol polish polský polština'],
  ['ita', 'IT', 'IT', 'it ita italian italský italština'],
  ['por', 'PT', 'PT', 'pt por portuguese portugalský portugalština'],
  ['rus', 'RU', 'RU', 'ru rus russian ruský ruština'],
  ['ukr', 'UK', 'UA', 'uk ua ukr ukrainian ukrajinský ukrajinština'],
  ['jpn', 'JA', 'JP', 'ja jp jpn japanese japonský japonština'],
  ['kor', 'KO', 'KR', 'ko kr kor korean korejský korejština'],
  ['zho', 'ZH', 'CN', 'zh cn zho chi chinese čínský čínština'],
  ['hin', 'HI', 'IN', 'hi hin hindi hindština'],
  ['ben', 'BN', 'BD', 'bn ben bengali bengálština'],
  ['hun', 'HU', 'HU', 'hu hun hungarian maďarský maďarština'],
  ['ron', 'RO', 'RO', 'ro ron rum romanian rumunský rumunština'],
  ['nld', 'NL', 'NL', 'nl nld dut dutch nizozemský nizozemština'],
  ['tur', 'TR', 'TR', 'tr tur turkish turecký turečtina'],
  ['ara', 'AR', null, 'ar ara arabic arabský arabština']
];
const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const aliases = new Map();
for (const entry of entries) for (const alias of entry[3].split(' ')) aliases.set(fold(alias), entry);
const flag = country => country ? [...country].map(c => String.fromCodePoint(127397 + c.charCodeAt(0))).join('') : '🌐';
function languageCode(value) {
  const text = fold(value).trim();
  return aliases.get(text)?.[0] || aliases.get(text.split('-')[0])?.[0] || (/^[a-z]{3}$/.test(text) ? text : 'und');
}
function languageLabel(code) {
  const entry = entries.find(item => item[0] === code);
  return entry ? `${flag(entry[2])} ${entry[1]}` : `🌐 ${String(code).toUpperCase()}`;
}
function languages(text) {
  const tokens = fold(text).replace(/czsk/g, 'cz sk').match(/[a-z]+/g) || [];
  return [...new Set(tokens.map(token => aliases.get(token)?.[0]).filter(Boolean))];
}
function parseGroup(value) {
  const raw = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  const audio = [], subtitles = [];
  let hasAudio = false, hasSubtitles = false;
  const roles = /([^;•+]+?)\s+(dabing|dab|audio|zvuk|titulky|tit|subtitles|subs)\b/giu;
  for (const match of raw.matchAll(roles)) {
    const isAudio = /^(?:dab|audio|zvuk)/i.test(match[2]);
    if (isAudio) hasAudio = true; else hasSubtitles = true;
    (isAudio ? audio : subtitles).push(...languages(match[1]));
  }
  if (!hasAudio && !hasSubtitles) audio.push(...languages(raw));
  return { raw, audio: [...new Set(audio)], subtitles: [...new Set(subtitles)], hasAudio, hasSubtitles };
}
module.exports = { languageCode, languageLabel, parseGroup };
