'use strict';
// Explicit server-side diagnostic switch. Never enabled by a URL/query param.
// This bypasses OUR filtering only, not provider authorization or Cloudflare.
function testUnblockAllowed(rawUrl, env = process.env) {
  if (env.BOMBUJ_TEST_UNBLOCK_EMBEDS !== '1') return false;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return new Set(['bysekoze.com', 'byse.sx', 'vsembed.ru',
      'mixdrop.ag', 'mixdrop.co', 'mixdrop.to', 'mixdrop.sx', 'mixdrop.ps',
      'mixdrop.my', 'miixdrop.net', 'miiiixdrop.net', 'mxdrop.click']).has(host);
  } catch { return false; }
}
function testDirectVoeAllowed(rawUrl, env = process.env) {
  // The normal switch overrides the legacy diagnostic switch, including 0.
  if ((env.BOMBUJ_DIRECT_VOE ?? env.BOMBUJ_TEST_DIRECT_VOE) !== '1') return false;
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      ['voe.sx', 'voe2.sx'].includes(u.hostname.toLowerCase().replace(/^www\./, ''));
  } catch { return false; }
}
module.exports = { testUnblockAllowed, testDirectVoeAllowed };
