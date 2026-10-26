'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { byseEmbedId, publicHls, decryptBysePlayback, byseSources, resolveByse } = require('./resolvers/byse.js');

const embed = 'https://bysekoze.com/e/3sdq9djzqcqe/';
const hls = 'https://edge1-frankfurt-sprintcdn.owphbf24.com/a/master.m3u8?token=short';

function fixture(version = 20, paddingBytes = 0) {
  const parts = Array.from({ length: 30 }, () => crypto.randomBytes(16));
  const key = Buffer.concat([parts[version - 1], parts[30 - version]]);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify({ sources: [{ url: hls, quality: '1080p', height: 1080 }],
    tracks: [], padding: 'x'.repeat(paddingBytes) }));
  const payload = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return { algorithm: 'AES-256-GCM', version: String(version),
    key_parts: parts.map(part => part.toString('base64url')),
    iv: iv.toString('base64url'), payload: payload.toString('base64url') };
}

test('BYSE accepts exact HTTPS embeds and never mistakes HTML player for a video', () => {
  assert.equal(byseEmbedId(embed), '3sdq9djzqcqe');
  assert.equal(byseEmbedId('https://byse.sx/e/abcde12345'), 'abcde12345');
  for (const url of [
    'http://bysekoze.com/e/abcde12345', 'https://bysekoze.com.evil.example/e/abcde12345',
    'https://bysekoze.com/@evil', 'https://user:pass@bysekoze.com/e/abcde12345',
    'https://filemoon.sx/e/abcde12345'
  ]) assert.equal(byseEmbedId(url), null);
  assert(publicHls(hls));
  assert(!publicHls('https://localhost/movie.m3u8'));
  assert(!publicHls('https://127.0.0.1/movie.m3u8'));
  assert(!publicHls('https://example.com/embed/movie'));
});

test('BYSE AES-GCM key positions follow each server-selected version', () => {
  for (const version of [1, 3, 15, 20, 30]) {
    const encrypted = fixture(version);
    const config = decryptBysePlayback(encrypted);
    assert.equal(config.sources[0].url, hls);
    assert.equal(byseSources(config)[0].quality, '1080p');
    encrypted.payload = encrypted.payload.slice(0, -2) + 'xx';
    assert.equal(decryptBysePlayback(encrypted), null);
  }
  assert.equal(decryptBysePlayback({}), null);
  assert.equal(decryptBysePlayback(fixture(6, 2000)).sources[0].url, hls);
});

test('BYSE resolver fetches metadata once and returns only original CDN HLS', async () => {
  const calls = [], events = [];
  const result = await resolveByse(embed, {
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      assert.equal(url, 'https://bysekoze.com/api/videos/3sdq9djzqcqe');
      return Response.json({ playback: fixture(6) });
    },
    onDiagnostic: event => events.push(event)
  });
  assert.equal(calls.length, 1);
  assert.equal(result.length, 1);
  assert.equal(result[0].url, hls);
  assert.equal(result[0].type, 'hls');
  assert.equal(result[0].referer, 'https://n1mwq.org/');
  assert(!('externalUrl' in result[0]));
  assert.equal(events[0].mediaUrl, hls);
});

test('BYSE rejects upstream denial and never emits a web URL', async () => {
  const events = [];
  const failed = await resolveByse(embed, {
    fetchImpl: async () => new Response('blocked', { status: 403 }),
    onDiagnostic: event => events.push(event)
  });
  assert.equal(failed, null);
  assert.equal(events[0].reason, 'http-403');
  const noHost = await resolveByse('https://filemoon.sx/e/fixture', {
    fetchImpl: () => { throw Error('unexpected request'); }
  });
  assert.equal(noHost, null);
});
