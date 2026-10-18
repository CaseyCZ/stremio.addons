'use strict';

// Recognize the actual embed destination for a narrowly scoped preflight.
// The addon does not generate a server-hosted redirect or video proxy.
function validStreamtapeEmbed(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    if (url.protocol !== 'https:') return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname !== 'streamtape.com' && hostname !== 'www.streamtape.com') return null;
    if (!/^\/e\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) return null;
    if (url.username || url.password || url.port) return null;
    if (url.href.length > 2048) return null;
    return url.href;
  } catch {
    return null;
  }
}

module.exports = { validStreamtapeEmbed };
