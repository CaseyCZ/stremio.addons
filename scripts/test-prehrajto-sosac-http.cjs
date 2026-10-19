'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const PORT = 17987;
const BASE = 'http://127.0.0.1:' + PORT;
const bootstrap = String.raw`
  const { SosacOverlay } = require('./api/sosac-overlay');
  const { CinemetaApi } = require('./api/cinemeta');
  const overlay = require('./api/bombuj-overlay');
  const prehrajto = require('./api/prehrajto');

  SosacOverlay.prototype.resolve = async function(type, id) {
    if (!this.isConfigured()) return null;
    if (type === 'movie' && id === 'sosac_m_123')
      return {imdbId:'tt33400719', season:null, episode:null, id:'tt33400719'};
    if (type === 'series' && id === 'sosac_ep_345')
      return {imdbId:'tt18546730', season:2, episode:6, id:'tt18546730:2:6'};
    if (type === 'series' && id === 'sosac_s_234')
      return {imdbId:'tt18546730', season:null, episode:null, id:'tt18546730'};
    return null;
  };
  overlay.resolveBombujId = async (type, id) =>
    type === 'movie' && id === 'bombuj-movie-strange-harvest'
    ? {imdbId:'tt33400719',season:null,episode:null,id:'tt33400719'}
    : null;
  CinemetaApi.prototype.getMeta = async (type, id) => ({
    name: id === 'tt18546730' ? 'The Walking Dead: Dead City' : 'Strange Harvest',
    year: id === 'tt18546730' ? 2025 : 2024
  });
  prehrajto.findPrehrajtoStreams = async ({meta,type,season,episode}) => [{
    name:'Přehraj.to',
    title: meta.name + ' ' + (season ?? '-') + ':' + (episode ?? '-'),
    url:'https://pf-storage6.premiumcdn.net/fixture.mp4',
    subtitles: []
  }];
  require('./addon.js');
`;
const child = spawn(process.execPath, ['-e', bootstrap], {
  cwd: require('node:path').resolve(__dirname, '..'),
  env: {
    ...process.env,
    PORT: String(PORT),
    CONFIG_ENCRYPTION_KEY: 'a'.repeat(64)
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout.on('data', chunk => output += chunk.toString());
child.stderr.on('data', chunk => output += chunk.toString());

async function ready() {
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw Error('Addon exited: ' + output);
    try {
      const response = await fetch(BASE + '/health');
      if (response.ok) return;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Addon did not start: ' + output);
}
async function json(path) {
  const resp = await fetch(BASE + path);
  return { status: resp.status, body: await resp.json() };
}
async function token(payload) {
  const resp = await fetch(BASE + '/api/config-token', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload)
  });
  assert.equal(resp.status, 200);
  const { token } = await resp.json();
  assert.ok(token.startsWith('enc1.'));
  return token;
}

(async () => {
  try {
    await ready();
    const plain = await json('/prehrajto/manifest.json');
    assert.equal(plain.status, 200);
    assert.equal(plain.body.id, 'cz.caseycz.stremio.prehrajto.direct');
    assert.ok(plain.body.idPrefixes.includes('tt'));
    assert.ok(plain.body.idPrefixes.includes('bombuj-movie-'));
    assert.ok(!plain.body.idPrefixes.includes('sosac_m_'));

    const noAccount = await json('/prehrajto/stream/movie/sosac_m_123.json');
    assert.deepEqual(noAccount.body.streams, []);

    const credToken = await token({
      addonType:'prehrajto', sosacUsername:'test', sosacPassword:'fake-pass'
    });
    const prefix = '/' + credToken + '/prehrajto';
    const linked = await json(prefix + '/manifest.json');
    assert.equal(linked.status, 200);
    assert.equal(linked.body.id, plain.body.id);
    assert.ok(linked.body.idPrefixes.includes('sosac_m_'));
    assert.ok(linked.body.idPrefixes.includes('sosac_s_'));
    assert.ok(linked.body.idPrefixes.includes('sosac_ep_'));

    // Stremio's Configure button opens the installed manifest directory.
    // Every configured provider must redirect to the same public setup page,
    // without leaking the encrypted token into the redirect URL.
    async function configurationLink(installedPath) {
      const response = await fetch(BASE + installedPath, { redirect: 'manual' });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      const location = response.headers.get('location');
      assert.ok(location);
      assert.ok(!location.includes('enc1.'), 'Redirect must not expose config token');
      const target = new URL(location, BASE + installedPath);
      assert.equal(target.pathname, '/configure');
      const page = await fetch(target);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Propojení se Sosáčem/);
    }
    await configurationLink('/' + credToken);
    await configurationLink('/' + credToken + '/');
    await configurationLink('/' + credToken + '/prehrajto');
    await configurationLink('/' + credToken + '/prehrajto/');

    const bombujToken = await token({
      addonType:'bombuj', sosacUsername:'test', sosacPassword:'fake-pass'
    });
    await configurationLink('/' + bombujToken);
    await configurationLink('/' + bombujToken + '/bombuj');
    await configurationLink('/' + bombujToken + '/bombuj/');

    const directToken = await token({ addonType:'sktonline' });
    await configurationLink('/' + directToken);
    await configurationLink('/' + directToken + '/');

    const badProviderRoot = await fetch(BASE + '/' + credToken + '/bombuj', { redirect:'manual' });
    assert.equal(badProviderRoot.status, 404);
    const invalidConfigureRoot = await fetch(BASE + '/enc1.not-a-valid.token.hmac', { redirect:'manual' });
    assert.equal(invalidConfigureRoot.status, 404);

    const movie = await json(prefix + '/stream/movie/sosac_m_123.json');
    assert.equal(movie.status, 200);
    assert.equal(movie.body.streams.length, 1);
    assert.match(movie.body.streams[0].title, /Strange Harvest/);

    const episode = await json(prefix + '/stream/series/sosac_ep_345.json');
    assert.equal(episode.body.streams.length, 1);
    assert.match(episode.body.streams[0].title, /2:6/);

    const showOnly = await json(prefix + '/stream/series/sosac_s_234.json');
    assert.deepEqual(showOnly.body.streams, []);

    const bombuj = await json('/prehrajto/stream/movie/bombuj-movie-strange-harvest.json');
    assert.equal(bombuj.body.streams.length, 1);
    const imdb = await json('/prehrajto/stream/movie/tt33400719.json');
    assert.equal(imdb.body.streams.length, 1);

    const invalid = await json('/bad-token/prehrajto/manifest.json');
    assert.equal(invalid.status, 400);

    const unrelatedToken = await token({addonType:'sktonline'});
    const unrelated = await json('/' + unrelatedToken + '/prehrajto/manifest.json');
    assert.equal(unrelated.status, 400);

    console.log('Prehraj.to standalone, configured Sosac, Bombuj and IMDb routes OK');
  } finally {
    child.kill('SIGTERM');
  }
})().catch(error => {
  console.error(error, output);
  process.exitCode = 1;
});
