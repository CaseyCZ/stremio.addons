'use strict';

// Bombuj's picture catalogue includes independent anchors for cards, trailers,
// and navigation. Parse each film anchor in isolation (not across cards).
function decodeHtml(value) {
  return String(value || '').replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

function cleanHtml(value) {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')).trim();
}

function parseMovieCards(html) {
  const input = String(html || '');
  const re = /<a\b[^>]*href=["']([^"']*online-film-[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set();
  const cards = [];
  for (const match of input.matchAll(re)) {
    let detailUrl, slug;
    try {
      const url = new URL(decodeHtml(match[1]), 'https://www.bombuj.si');
      if (url.protocol !== 'https:' || url.hostname !== 'www.bombuj.si') continue;
      const tail = url.pathname.split('/').filter(Boolean).pop() || '';
      if (!/^online-film-[a-z0-9-]+$/i.test(tail)) continue;
      slug = tail.replace(/^online-film-/i, '').toLowerCase();
      detailUrl = url.origin + url.pathname;
    } catch { continue; }
    if (seen.has(slug)) continue;

    const body = match[2] || '';
    const images = [...body.matchAll(/<img\b[^>]*>/gi)];
    const imageSrc = img => (img?.[0] || '').match(/\b(?:data-src|src)=["']([^"']+)["']/i)?.[1];
    const cover = images.find(img => /\/images\/covers\//i.test(imageSrc(img) || '')) || images.at(-1);
    if (cover && /\/images\/slide\//i.test(imageSrc(cover) || '')) continue;

    const textTitle =
      body.match(/<div\b[^>]*font-size\s*:\s*(?:18|23)px[^>]*>([\s\S]*?)<\/div>/i)?.[1] ||
      cover?.[0].match(/\balt=["']([^"']+)["']/i)?.[1] ||
      cleanHtml(body);
    const title = cleanHtml(textTitle) || slug.replace(/-/g, ' ');
    const year = slug.match(/(?:19|20)\d{2}/)?.[0] ||
      cleanHtml(body).match(/\b(?:19|20)\d{2}\b/)?.[0] || null;
    let poster = null;
    try {
      const image = imageSrc(cover);
      if (image) poster = new URL(decodeHtml(image), 'https://www.bombuj.si').href;
    } catch {}
    cards.push({ slug, detailUrl, poster, title, year });
    seen.add(slug);
  }
  return cards;
}

module.exports = { parseMovieCards };
