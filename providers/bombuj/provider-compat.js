'use strict';
const { testUnblockAllowed } = require('./embed-test-policy.js');

// A normal HTTP request cannot reproduce browser iframe/domain authorization.
// Only explicitly verified Stremio-incompatible embed hosts belong here.
// Match real hostnames, never arbitrary substrings or provider names.
function confirmedStremioEmbedFailure(rawUrl) {
  if (testUnblockAllowed(rawUrl)) return null;
  try {
    const url = new URL(String(rawUrl || ''));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    // The legacy Videasy web players return a blank screen in the actual
    // Stremio iOS webview. Check the resolved URL, not the Bombuj provider
    // label (e.g. Primewire), because other Primewire hosts may work.
    if (host === 'player.videasy.to' || host === 'player.videasy.net') {
      return 'blank-player-in-stremio:videasy';
    }
    // Confirmed on iOS Stremio: Cloudflare displays "Sorry, you have been
    // blocked" when a Vidsrc embed resolves to vsembed.ru. Limit this
    // exception to this actual player host, not the generic Vidsrc label.
    // The preflight layer applies this only to web embeds, not direct media.
    if (host === 'vsembed.ru' || host === 'www.vsembed.ru') {
      return 'cloudflare-client-block:vsembed.ru';
    }
    // Known Mixdrop embed domains: the iOS Stremio player reports domain
    // protection for these web embeds. Real direct media URLs remain untouched
    // because the preflight layer checks direct streams separately.
    const mixdropHosts = new Set([
      'mixdrop.ag', 'mixdrop.co', 'mixdrop.to', 'mixdrop.sx',
      'mixdrop.ps', 'mixdrop.my', 'miixdrop.net', 'miiiixdrop.net'
    ]);
    if (mixdropHosts.has(host) || (host.startsWith('www.') && mixdropHosts.has(host.slice(4)))) {
      return 'embedding-domain-protected:mixdrop';
    }
    if (
      host === 'bysekoze.com' || host.endsWith('.bysekoze.com') ||
      host === 'byse.sx' || host.endsWith('.byse.sx')
    ) {
      // Verified in Stremio's player: "embedding from web.stremio.com is not allowed".
      return 'embedding-domain-not-authorized:web.stremio.com';
    }
  } catch {}
  return null;
}

module.exports = { confirmedStremioEmbedFailure };
