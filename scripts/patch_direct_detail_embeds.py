from pathlib import Path

path = Path('api/sktonline.js')
text = path.read_text()

start = text.index('function onlineEmbedEntriesFromDetail(')
end = text.index('\nfunction hostOf(', start)
new_func = r'''function onlineEmbedEntriesFromDetail($, pageUrl, releaseTitle, html = '') {
  const entries = [];
  const byUrl = new Map();

  const add = (raw, title = '') => {
    const source = cleanUrlText(raw);
    if (!source) return;

    const candidates = [];
    for (const match of source.match(/(?:https?:)?\/\/online(?:\d+)?\.sktorrent\.eu\/embed\/[a-z0-9_-]+/gi) || []) {
      candidates.push(match);
    }
    for (const match of source.match(/(?:^|[\s"'=(])\/embed\/[a-z0-9_-]+/gi) || []) {
      candidates.push(match.replace(/^[\s"'=(]+/, ''));
    }
    if (!candidates.length && /^\/embed\/[a-z0-9_-]+(?:[?#].*)?$/i.test(source)) candidates.push(source);

    for (const candidate of candidates) {
      let url = null;
      if (/^\/embed\//i.test(candidate)) url = absoluteUrl(candidate, ONLINE_BASE_URL);
      else if (/^\/\//.test(candidate)) url = `https:${candidate}`;
      else url = absoluteUrl(candidate, pageUrl);
      if (!url || !isSktOnlineUrl(url) || !/\/embed\/[a-z0-9_-]+/i.test(url)) continue;

      const existing = byUrl.get(url);
      const cleanTitle = String(title || '').replace(/\s+/g, ' ').trim();
      if (existing) {
        if (!existing.title && cleanTitle) existing.title = cleanTitle;
        continue;
      }
      const entry = { url, title: cleanTitle };
      byUrl.set(url, entry);
      entries.push(entry);
    }
  };

  // The original site usually embeds the player in an iframe. Some current
  // SKTorrent detail pages expose the same link as an anchor, data attribute
  // or JavaScript handler instead, so inspect all of those forms as well.
  $('iframe[src], frame[src]').each((_, el) => {
    add($(el).attr('src'), nearbyTitleForOnlineEmbed($, el));
  });

  $('a[href], [data-src], [data-url], [data-file], [data-video], [onclick]').each((_, el) => {
    const node = $(el);
    const title = String(
      node.attr('title') ||
      node.attr('aria-label') ||
      node.text() ||
      releaseTitle || ''
    ).replace(/\s+/g, ' ').trim();
    for (const attr of ['href', 'src', 'data-src', 'data-url', 'data-file', 'data-video', 'onclick']) {
      add(node.attr(attr), title);
    }
  });

  // Also scan raw HTML. This catches escaped URLs inside inline scripts such as
  // https:\/\/online.sktorrent.eu\/embed\/<token> that Cheerio does not expose
  // as a normal attribute.
  add(cleanUrlText(html), releaseTitle);

  const pageCodes = detailAudioCodes($);
  if (pageCodes.length && pageCodes.length === entries.length) {
    entries.forEach((entry, index) => {
      const codes = releaseLanguageCodesInText(entry.title);
      if (codes.length !== 1) entry.title = `(${pageCodes[index]})`;
    });
  } else {
    const explicitCodes = dedupe(entries.flatMap(entry => releaseLanguageCodesInText(entry.title)));
    const releaseCodes = releaseLanguageCodesInText(releaseTitle);
    const remainingCodes = releaseCodes.filter(code => !explicitCodes.includes(code));
    if (remainingCodes.length === 1) {
      for (const entry of entries) {
        if (!releaseLanguageCodesInText(entry.title).length) {
          entry.title = `${entry.title || releaseTitle} (${remainingCodes[0]})`;
        }
      }
    }
  }

  return entries.sort((a, b) => candidateLanguagePriority(a.title) - candidateLanguagePriority(b.title));
}
'''
text = text[:start] + new_func + text[end:]

old = """async function streamsFromSktorrentDetail(candidate, client = null) {
  const key = `skt-detail-direct:${client ? client.clientKey : 'anon'}:${candidate.id}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const response = client
      ? await client.authenticatedGet(candidate.detailsUrl, { headers: { Referer: SKTORRENT_SEARCH_URL } })
      : await sktorrentHttp.get(candidate.detailsUrl, { headers: { Referer: SKTORRENT_SEARCH_URL } });
    const finalUrl = absoluteUrl(response.request?.res?.responseUrl || candidate.detailsUrl, SKTORRENT_BASE_URL) || candidate.detailsUrl;
    const $ = cheerio.load(response.data);
"""
new = """async function streamsFromSktorrentDetail(candidate, client = null) {
  const key = `skt-detail-direct-v2:${client ? client.clientKey : 'anon'}:${candidate.id}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const fetchDetail = () => client
      ? client.authenticatedGet(candidate.detailsUrl, { headers: { Referer: SKTORRENT_SEARCH_URL } })
      : sktorrentHttp.get(candidate.detailsUrl, { headers: { Referer: SKTORRENT_SEARCH_URL } });
    let response = await fetchDetail();

    // SKTorrent can occasionally answer an authenticated detail request with a
    // successful but empty body when the session has gone stale. Force a fresh
    // login once before giving up so the direct player links are not lost.
    if (client && !String(response.data || '').trim()) {
      await client.login(true);
      response = await fetchDetail();
    }

    const finalUrl = absoluteUrl(response.request?.res?.responseUrl || candidate.detailsUrl, SKTORRENT_BASE_URL) || candidate.detailsUrl;
    const $ = cheerio.load(response.data);
"""
if old not in text:
    raise SystemExit('streamsFromSktorrentDetail header not found')
text = text.replace(old, new, 1)

old_call = "const onlineEntries = onlineEmbedEntriesFromDetail($, finalUrl, title);"
new_call = "const onlineEntries = onlineEmbedEntriesFromDetail($, finalUrl, title, response.data);"
if old_call not in text:
    raise SystemExit('onlineEmbedEntriesFromDetail call not found')
text = text.replace(old_call, new_call, 1)

path.write_text(text)
