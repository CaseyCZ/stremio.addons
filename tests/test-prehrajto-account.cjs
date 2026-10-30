'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPrehrajtoAccountClient, findPrehrajtoAccountStreams,
  publicHttpsUrl, searchItems, accountToken, mappedSubtitles } = require('../api/prehrajto-account');

const cfg = { prehrajtoEmail: 'example@example.invalid', prehrajtoPassword: 'not-a-real-password' };
const response = (data, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  json: async () => data
});

test('Streamlet-style API v2 uses two distinct auth/search/link steps without media proxy', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push([url, options]);
    if (url.endsWith('/users/login')) return response({ payload: { data: { access_token: 'mock-account-token' } } });
    if (url.includes('/videos/search?')) return response({ payload: { data: {
      videos: [{ id: 123, title: 'Mayday 2026 CZ titulky 1080p' }]
    } } });
    if (url.endsWith('/videos/123/download?mp4=true')) return response({
      payload: { data: { download_link: 'https://edge.premiumcdn.net/123/video.mp4?token=signed' } }
    });
    throw Error('unexpected URL ' + url);
  };
  const api = createPrehrajtoAccountClient({ fetchImpl });
  const files = await api.search({ email: cfg.prehrajtoEmail, password: cfg.prehrajtoPassword,
    phrase: 'Mayday 2026' });
  assert.equal(files.length, 1);
  const url = await api.link({ email: cfg.prehrajtoEmail, password: cfg.prehrajtoPassword, id: files[0].id });
  assert.match(url, /premiumcdn\.net/);
  assert.equal(requests.length, 3);
  assert.equal(requests[0][1].method, 'POST');
  assert.deepEqual(JSON.parse(requests[0][1].body), {
    email: cfg.prehrajtoEmail, password: cfg.prehrajtoPassword
  });
  assert.ok(requests[1][0].includes('phrase=Mayday+2026'));
  assert.ok(requests[1][0].includes('sort-by=relevance'));
  assert.ok(requests[1][0].includes('limit=20'));
  assert.equal(requests[1][1].headers.Authorization, 'Bearer mock-account-token');
  assert.equal(requests[2][1].headers.Authorization, 'Bearer mock-account-token');
  assert.ok(requests.every(([url]) => !url.includes(cfg.prehrajtoPassword)));
});

test('registered account is optional and never returns unverified candidates', async () => {
  let searched = 0;
  const api = {
    search: async () => {
      searched++;
      return [
        { id: 1, title: 'Mayday 2026 CZ titulky',
          subtitles: [{ language: 'cze', title: 'CZE', cdnUrl: 'https://edge.premiumcdn.net/cz.vtt' },
            { language: 'eng', title: 'ENG', cdnUrl: 'https://edge.premiumcdn.net/en.vtt' },
            { language: 'eng2', title: 'ENG2', cdnUrl: 'https://edge.premiumcdn.net/en2.vtt' }] },
        { id: 2, title: 'Mayday 2025 CZ titulky' },
        { id: 3, title: 'Mayday: The Flight 2026' }
      ];
    },
    link: async ({ id }) => {
      assert.equal(id, '1');
      return 'https://pf-storage6.premiumcdn.net/1/preview.mp4?token=signed';
    }
  };
  assert.deepEqual(await findPrehrajtoAccountStreams({
    cfg: {}, meta: { name: 'Mayday', year: 2026 }, type: 'movie'
  }, { api }), []);
  const streams = await findPrehrajtoAccountStreams({
    cfg, meta: { name: 'Mayday', year: 2026 }, type: 'movie'
  }, { api });
  assert.equal(searched, 2);
  assert.equal(streams.length, 1);
  assert.equal(streams[0].subtitles.length, 3);
  assert.deepEqual(streams[0].subtitles.map(x => x.lang), ['ces', 'eng', 'eng']);
  assert.notEqual(streams[0].name, 'Přehraj.to • Direct');
});

test('rejects unsafe video and subtitle URLs, including fake provider hosts', () => {
  for (const url of [
    'http://premiumcdn.net/video.mp4',
    'https://premiumcdn.net.evil.invalid/video.mp4',
    'https://127.0.0.1/file.mp4',
    'https://localhost/file.mp4',
    'https://user:pass@prehrajto.cz/video.mp4',
    'https://192.168.1.1/video.mp4'
  ]) assert.equal(publicHttpsUrl(url), null, url);
  assert.ok(publicHttpsUrl('https://pf-storage6.premiumcdn.net/123/file.mp4'));
  assert.deepEqual(mappedSubtitles([
    { language: 'eng', title: 'ENG', cdnUrl: 'https://evil.invalid/en.vtt' },
    { language: 'cze', title: 'CZE', cdnUrl: 'https://cdn.premiumcdn.net/cs.vtt' },
    { language: 'cze', title: 'CZE', cdnUrl: 'https://cdn.premiumcdn.net/cs.vtt' }
  ], 7).map(x => x.lang), ['ces']);
});

test('accepts supported Streamlet response mappings but does not invent tokens or results', () => {
  assert.equal(accountToken({ payload: { data: { token: 'valid-token' } } }), 'valid-token');
  assert.equal(accountToken({ payload: { data: {} } }), null);
  assert.deepEqual(searchItems({ payload: { data: { results: [{ id: 1 }] } } }), [{ id: 1 }]);
  assert.deepEqual(searchItems({ payload: { data: { invalid: true } } }), []);
});

test('HTTP 401 retries authentication once; 429 enters cooldown without repeated logins', async () => {
  let logins = 0;
  let searches = 0;
  const api = createPrehrajtoAccountClient({
    fetchImpl: async (url) => {
      if (url.endsWith('/users/login')) {
        logins++;
        return response({ payload: { data: { token: 'token-' + logins } } });
      }
      searches++;
      if (searches === 1) return response({}, 401);
      if (searches === 2) return response({ payload: { data: { videos: [] } } });
      return response({}, 429);
    }
  });
  const params = { email: cfg.prehrajtoEmail, password: cfg.prehrajtoPassword, phrase: 'Mayday' };
  assert.deepEqual(await api.search(params), []);
  assert.equal(logins, 2);
  assert.equal(searches, 2);
  await assert.rejects(() => api.search(params), /429/);
  await assert.rejects(() => api.search(params), /rate limited/);
  assert.equal(searches, 3);
  assert.equal(logins, 2);
});
