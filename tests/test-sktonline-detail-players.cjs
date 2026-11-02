'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const axios = require('axios');

const targetId = '8c9be29107ab945c893e245116a3174799519994';
const title = 'Spider-Man: Brand New Day (2026)';
const otherIds = Array.from({ length: 7 }, (_, index) => String(index + 1).padStart(40, '0'));
const searchHtml = `<html><body><table><tr>${[
  ...otherIds.map(id => ({ id, playable: false })),
  { id: targetId, playable: true }
].map(item => `<td>${item.playable ? '<img src="//announce.sktorrent.eu/torrent/images/play.png">' : ''}
  <a href="details.php?name=Spider-Man-Brand-New-Day&id=${item.id}"
     title="Stiahni si ${title}">${title}</a></td>`).join('')}</tr></table></body></html>`;

const embeds = [
  { token: '894dfed5aa079f4660fb', videoId: '64724', language: '' },
  { token: '200b31d3b9df1d454fa5', videoId: '64739', language: '(CZ)' },
  { token: '16d63afabb15d0eceeeb', videoId: '64845', language: '(SK)' }
];

const detailHtml = `<html><body><p>Jazyk: CZ, SK, EN</p>${embeds.map(item => `
  <div>${title} ${item.language}</div>
  <iframe src="https://online.sktorrent.eu/embed/${item.token}&1"></iframe>
  <meta property="og:url" content="https://online.sktorrent.eu/embed/${item.token}">`).join('')}
  </body></html>`;

test('SKTorrent detail with three embeds resolves all three players before searching every title variant', async () => {
  const requests = { search: 0, details: [], embeds: [] };
  const originalCreate = axios.create;
  axios.create = config => ({
    get: async url => {
      if (config.baseURL === 'https://sktorrent.eu') {
        if (url === '/torrent/torrents_v2.php') {
          requests.search++;
          return { data: searchHtml, headers: {} };
        }
        const id = String(url).match(/[?&]id=([a-f0-9]{40})/i)?.[1];
        requests.details.push(id);
        return { data: id === targetId ? detailHtml : '<html><body>No online player</body></html>', headers: {} };
      }
      if (config.baseURL === 'https://online.sktorrent.eu') {
        if (url === '/') return { data: '<html></html>', headers: {} };
        requests.embeds.push(url);
        const video = embeds.find(item => String(url).includes(item.token));
        assert(video, `Unexpected embed URL: ${url}`);
        const tracks = video.videoId === '64739'
          ? ['cze.vtt', 'cze_forced.vtt', 'slo.vtt']
          : video.videoId === '64724' ? ['Cesky.vtt'] : ['slo.vtt'];
        return { data: `<html><video>
          <source src="https://online9.sktorrent.eu/media/videos//h264/${video.videoId}_720p.mp4" label="720p">
          <source src="https://online9.sktorrent.eu/media/videos//h264/${video.videoId}_480p.mp4" label="480p">
          ${tracks.map(file => `<track src="https://online.sktorrent.eu/media/videos/vtt/${video.videoId}/${file}" srclang="cs" label="${file}">`).join('')}
          </video></html>`, headers: {} };
      }
      throw new Error(`Unexpected host: ${config.baseURL}`);
    }
  });

  let findFromSktorrentDetails;
  try {
    ({ findFromSktorrentDetails } = require('../api/sktonline'));
  } finally {
    axios.create = originalCreate;
  }

  const streams = await findFromSktorrentDetails(
    ['Spider-Man Brand New Day', 'Spider-Man Zbrusu novy den', 'Brand New Day', 'Spider Man', 'Spider-Man 2026'],
    [title], '', null, 'movie'
  );

  assert.equal(streams.length, 6, 'keep both qualities for each of the three players');
  assert.deepEqual(new Set(streams.map(item => item.url.match(/h264\/(\d+)_/)?.[1])),
    new Set(['64724', '64739', '64845']));
  for (const videoId of ['64724', '64739', '64845']) {
    const variants = streams.filter(item => item.url.includes(`/h264/${videoId}_`));
    assert.deepEqual(new Set(variants.map(item => item.url.match(/_(\d+p)\.mp4/)?.[1])), new Set(['720p', '480p']));
  }
  const withForced = streams.find(item => item.url.includes('/h264/64739_720p.mp4'));
  assert.deepEqual(withForced.subtitles.map(item => item.id), [
    'sktonline-64739-cze', 'sktonline-64739-cze_forced', 'sktonline-64739-slo'
  ]);
  assert.deepEqual(withForced.subtitles.map(item => item.lang), ['cze', 'cze', 'slk']);
  assert.equal(streams.find(item => item.url.includes('/h264/64724_720p.mp4')).subtitles[0].id,
    'sktonline-64724-Cesky');
  assert.equal(requests.embeds.length, 3, 'duplicate og:url metadata must not refetch the same player');
  assert.equal(requests.search, 3, 'stop when three playable sources are available');
  assert(requests.details.includes(targetId), 'the search play icon should prioritize the playable torrent');
  assert(requests.details.length <= 4, 'do not load unrelated details after three sources are found');
  assert(streams.some(item => item.title.includes('🇨🇿 CZ')));
  assert(streams.some(item => item.title.includes('🇸🇰 SK')));
  assert(streams.some(item => item.title.includes('🇬🇧 EN')));
});
