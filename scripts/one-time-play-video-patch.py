from pathlib import Path

p = Path('api/sktonline.js')
s = p.read_text()

old = """      const card = link.closest('td, tr, article, div');
      const name = String(link.attr('title') || link.find('img').attr('alt') || link.text() || card.text() || '')
        .replace(/\\s+/g, ' ').trim();
      const score = titleMatchScore(name, wantedTitles);
      const category = String(card.find('b').first().text() || '').trim();
      if (!name || !candidateYearMatches(name, wantedTitles) || candidateHasConflictingYears(name, wantedTitles) || score < 0.7) return;
      if (category && !/(film|seri|dokum|tv)/i.test(category)) return;
      const detailsUrl = absoluteUrl(href, SKTORRENT_SEARCH_URL);
      if (!detailsUrl) return;
      seen.add(idMatch[1]);
      items.push({ id: idMatch[1], name, detailsUrl, score, category });
"""
new = """      // Use the whole result row when possible: the blue Play Video icon is
      // often a sibling of the details link, not inside the link itself.
      const row = link.closest('tr');
      const card = row.length ? row : link.closest('td, article, div');
      const name = String(link.attr('title') || link.find('img').attr('alt') || link.text() || card.text() || '')
        .replace(/\\s+/g, ' ').trim();
      const score = titleMatchScore(name, wantedTitles);
      const category = String(card.find('b').first().text() || '').trim();
      if (!name || !candidateYearMatches(name, wantedTitles) || candidateHasConflictingYears(name, wantedTitles) || score < 0.7) return;
      if (category && !/(film|seri|dokum|tv)/i.test(category)) return;
      const detailsUrl = absoluteUrl(href, SKTORRENT_SEARCH_URL);
      if (!detailsUrl) return;

      // Priority hint only: entries without the icon remain as fallback.
      const rowHtml = String(card.html() || '');
      const hasPlayVideo = /play[\\s_-]*video|title\\s*=\\s*[\"'][^\"']*\\bplay\\b|alt\\s*=\\s*[\"'][^\"']*\\bplay\\b|fa-play(?:-circle)?|glyphicon-play|online\\d*\\.sktorrent\\.eu/i.test(rowHtml);

      seen.add(idMatch[1]);
      items.push({ id: idMatch[1], name, detailsUrl, score, category, hasPlayVideo });
"""
if old not in s:
    raise SystemExit('search candidate block not found')
s = s.replace(old, new, 1)

old = """    const result = items
      .sort((a, b) => (b.score - a.score) || (candidateLanguagePriority(a.name) - candidateLanguagePriority(b.name)))
      .slice(0, 8);
"""
new = """    const result = items
      .sort((a, b) =>
        (Number(b.hasPlayVideo) - Number(a.hasPlayVideo)) ||
        (b.score - a.score) ||
        (candidateLanguagePriority(a.name) - candidateLanguagePriority(b.name))
      )
      .slice(0, 10);
"""
if old not in s:
    raise SystemExit('search ranking block not found')
s = s.replace(old, new, 1)

old = """  const rankedCandidates = [...candidates.values()].sort((a, b) => {
    const scoreDiff = (b.score || titleMatchScore(b.name, titles)) - (a.score || titleMatchScore(a.name, titles));
    if (scoreDiff) return scoreDiff;
    return candidateLanguagePriority(a.name) - candidateLanguagePriority(b.name);
  });
const batches = await Promise.all(rankedCandidates.slice(0, 10).map(streamsFromSktorrentDetail));
"""
new = """  const rankedCandidates = [...candidates.values()].sort((a, b) => {
    const playVideoDiff = Number(b.hasPlayVideo) - Number(a.hasPlayVideo);
    if (playVideoDiff) return playVideoDiff;
    const scoreDiff = (b.score || titleMatchScore(b.name, titles)) - (a.score || titleMatchScore(a.name, titles));
    if (scoreDiff) return scoreDiff;
    return candidateLanguagePriority(a.name) - candidateLanguagePriority(b.name);
  });
  const batches = await Promise.all(rankedCandidates.slice(0, 10).map(streamsFromSktorrentDetail));
"""
if old not in s:
    raise SystemExit('detail ranking block not found')
s = s.replace(old, new, 1)
p.write_text(s)

a = Path('addon.js')
addon = a.read_text()
addon2 = addon.replace('combined-v7:', 'combined-v8:', 1)
if addon2 == addon:
    raise SystemExit('combined-v7 cache key not found')
a.write_text(addon2)
