'use strict';

function qualityLabel(stream) {
  // Use declared metadata/filenames, not arbitrary numbers in signed CDN URLs.
  const text = [stream?.name, stream?.title, stream?.description, stream?.behaviorHints?.filename].filter(Boolean).join(' ');
  const match = text.match(/\b([1-9]\d{2,3})p\b/i);
  if (match) return match[1] + 'p';
  if (/\b(?:4k|uhd)\b/i.test(text)) return '2160p';
  if (/\bfull\s*hd\b|\bfhd\b/i.test(text)) return '1080p';
  if (/\bhd\b/i.test(text)) return '720p';
  return 'Kvalita neuvedena';
}

function hlsVariants(text, baseUrl) {
  if (!String(text).replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) return [];
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const resolution = lines[i].match(/(?:[:,])RESOLUTION=(\d+)x(\d+)(?:,|$)/i);
    const height = resolution ? Number(resolution[2]) : null;
    const path = lines.slice(i + 1).find(line => line && !line.startsWith('#'));
    if (!path) continue;
    try {
      const url = new URL(path, baseUrl);
      if (url.protocol !== 'https:' || url.username || url.password) continue;
      result.push({ url: url.href, height, quality: height ? height + 'p' : null });
    } catch {}
  }
  return result.sort((a, b) => (b.height || 0) - (a.height || 0));
}

async function inspectHls(url, { fetchImpl = fetch, headers = {}, timeoutMs = 5000 } = {}) {
  const response = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(5000, timeoutMs))) });
  if (response.status !== 200) { await response.body?.cancel(); return null; }
  const reader = response.body?.getReader(), chunks = []; let bytes = 0;
  if (!reader) return null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 65536) return null;
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) return null;
  const variants = hlsVariants(text, response.url || url);
  if (variants.length) return variants[0];
  return text.includes('#EXTINF:') ? { url, quality: null } : null;
}
module.exports = { qualityLabel, hlsVariants, inspectHls };
