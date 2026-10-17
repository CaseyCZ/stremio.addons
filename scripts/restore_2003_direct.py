from pathlib import Path

path = Path('api/sktonline.js')
text = path.read_text()


def replace_between(source, start_marker, end_marker, replacement):
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    return source[:start] + replacement.rstrip() + '\n\n' + source[end:]

search_function = r'''async function searchSktorrentDetails(query, wantedTitles, trustedReference = false) {
  // Restore the permissive search strategy that was proven working on
  // 2026-10-16 around 20:03, while keeping today's authenticated detail
  // resolver and improved embed parsing.
  const wantedKey = (wantedTitles || []).map(normalize).sort().join('|');
  const key = `skt-detail-search-history-v1:${normalize(query)}:${trustedReference ? 'trusted' : 'normal'}:${wantedKey}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  try {
    const response = await sktorrentHttp.get('/torrent/torrents_v2.php', {
      params: { search: query, category: 0, active: 0, order: 'data', by: 'DESC', page: 0 },
      headers: { Referer: `${SKTORRENT_BASE_URL}/torrent/torrents_v2.php` }
    });
    const $ = cheerio.load(response.data);
    const items = [];
    const seen = new Set();

    $('a[href*="details.php"]').each((_, el) => {
      const link = $(el);
      const href = String(link.attr('href') || '');
      const idMatch = href.match(/[?&]id=([a-f0-9]{40})/i);
      if (!idMatch || seen.has(idMatch[1])) return;

      const cell = link.closest('td');
      const card = cell.length ? cell : link.closest('tr, article, div');
      const name = String(
        link.attr('title') ||
        link.find('img').attr('alt') ||
        link.text() ||
        card.text() || ''
      ).replace(/\s+/g, ' ').trim();
      if (!name) return;

      const score = titleMatchScore(name, wantedTitles);
      // This 0.45 threshold and lack of hard year rejection matches the
      // successful 20:03 code path. Explicit adult-category results are still
      // discarded so permissive matching does not promote unrelated XXX rows.
      if (!trustedReference && score < 0.45) return;

      const category = String(card.find('b').first().text() || '').trim();
      if (/^x{3}$/i.test(category) || /\bxxx\b/i.test(category)) return;

      const detailsUrl = absoluteUrl(href, SKTORRENT_SEARCH_URL);
      if (!detailsUrl) return;

      const cardHtml = String(card.html() || '');
      const hasPlayVideo = /play[\s_-]*video|title\s*=\s*["'][^"']*\bplay\b|alt\s*=\s*["'][^"']*\bplay\b|fa-play(?:-circle)?|glyphicon-play|online\d*\.sktorrent\.eu/i.test(cardHtml);

      seen.add(idMatch[1]);
      items.push({
        id: idMatch[1],
        name,
        category,
        score,
        detailsUrl,
        hasPlayVideo
      });
    });

    const result = items.sort((a, b) => {
      const scoreDiff = (b.score || 0) - (a.score || 0);
      if (scoreDiff) return scoreDiff;
      const playVideoDiff = Number(b.hasPlayVideo) - Number(a.hasPlayVideo);
      if (playVideoDiff) return playVideoDiff;
      return candidateLanguagePriority(a.name) - candidateLanguagePriority(b.name);
    }).slice(0, 16);

    cache.set(key, result, result.length ? 5 * 60 : 60);
    return result;
  } catch (error) {
    console.warn(`[direct] SKTorrent search "${query}": ${error.message}`);
    return [];
  }
}'''

find_function = r'''async function findFromSktorrentDetails(queries, titles, imdbId, client = null) {
  // The working 20:03 build tried several title variants. Later revisions
  // collapsed this to one plain-title query, which made direct discovery much
  // easier to miss. Restore the proven four-query collection, but keep the
  // current authenticated detail fetcher and current embed/CDN resolver.
  const candidates = new Map();
  const historyQueries = dedupe((queries || []).filter(Boolean)).slice(0, 4);

  for (const query of historyQueries) {
    const found = await searchSktorrentDetails(query, titles);
    for (const item of found) {
      if (!candidates.has(item.id)) candidates.set(item.id, item);
    }
    if (candidates.size >= 16) break;
  }

  if (!candidates.size) return [];

  const rankedCandidates = [...candidates.values()].sort((a, b) => {
    const scoreDiff = (b.score || titleMatchScore(b.name, titles)) - (a.score || titleMatchScore(a.name, titles));
    if (scoreDiff) return scoreDiff;
    const playVideoDiff = Number(b.hasPlayVideo) - Number(a.hasPlayVideo);
    if (playVideoDiff) return playVideoDiff;
    return candidateLanguagePriority(a.name) - candidateLanguagePriority(b.name);
  });

  const firstWave = await Promise.all(
    rankedCandidates.slice(0, 10).map(candidate => streamsFromSktorrentDetail(candidate, client))
  );
  let result = dedupeStreams(firstWave.flat());

  // If the best title matches do not carry a direct player, inspect the next
  // matches too. This mirrors the old behavior where multiple query variants
  // could surface a different release containing the SKTOnline embed.
  if (!result.length && rankedCandidates.length > 10) {
    const secondWave = await Promise.all(
      rankedCandidates.slice(10, 16).map(candidate => streamsFromSktorrentDetail(candidate, client))
    );
    result = dedupeStreams(secondWave.flat());
  }

  return result.slice(0, 16);
}'''

text = replace_between(
    text,
    'async function searchSktorrentDetails(',
    'async function streamsForOnlinePage(',
    search_function
)
text = replace_between(
    text,
    'async function findFromSktorrentDetails(',
    'function directProviderWithin(',
    find_function
)

path.write_text(text)
