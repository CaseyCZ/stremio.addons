'use strict';

// Bombuj film and series players share the accordion markup. Each <li>
// must be parsed independently: provider labels often contain nested
// <span> tags ("voe.sx - VIP", "(New)") and must not swallow the next li.
function decodeAttribute(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&#(?:0*38|x0*26);/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:0*39|x0*27);/gi, "'");
}

function plainText(value) {
  return decodeAttribute(String(value || '').replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')).trim();
}

function parseListItems(html, language) {
  const sources = [];
  const listItems = String(html || '').matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi);
  for (const item of listItems) {
    const url = item[1].match(/\blink\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!url) continue;
    const innerAnchor = item[2].match(/<a\b[^>]*>([\s\S]*?)<\/a>/i)?.[1];
    const provider = plainText(innerAnchor || item[2]);
    if (!provider || /\bVIP\b/i.test(provider)) continue;
    const cleaned = decodeAttribute(url);
    if (!/^(?:https?:)?\/\//i.test(cleaned) && !cleaned.startsWith('/')) continue;
    sources.push({ url: cleaned, provider, language });
  }
  return sources;
}

function parseBombujPlayerGroups(html, fallbackLanguage = 'Bombuj') {
  const input = String(html || '');
  const headings = [...input.matchAll(/<div\b[^>]*\bclass\s*=\s*["'][^"']*\bdropdownlink\b[^"']*["'][^>]*>/gi)];
  if (!headings.length) return parseListItems(input, fallbackLanguage);

  const result = [];
  for (let i = 0; i < headings.length; i++) {
    const start = headings[i].index + headings[i][0].length;
    const end = headings[i + 1]?.index ?? input.length;
    const group = input.slice(start, end);
    const language = plainText(group.split(/<\/div\s*>/i, 1)[0]) || fallbackLanguage;
    // Only the submenu belonging to the language header is considered;
    // unrelated navigation items must not leak into provider discovery.
    const listHtml = group.match(/<ul\b[^>]*>([\s\S]*?)<\/ul>/i)?.[1] || '';
    result.push(...parseListItems(listHtml, language));
  }
  return result;
}

module.exports = { decodeAttribute, parseBombujPlayerGroups };
