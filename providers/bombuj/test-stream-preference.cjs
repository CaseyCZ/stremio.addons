'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { streamPriority, sortBombujStreams } = require('./stream-preference.js');
const { formatBombujStream } = require('./stream-display.js');

const sub = (id, lang) => ({ id, lang, url: `https://video.example/${id}.vtt` });
const stream = (description, options = {}) => ({
  name: 'Bombuj • VOE', description,
  url: 'https://video.example/master.m3u8', ...options
});

test('CZ dub beats high-resolution English sources and direct stream preference', () => {
  const english4k = stream('EN dab/tit • přímý HLS • 2160p');
  const czechExternal = { name: 'Bombuj • streamtape.com',
    description: 'CZ dabing • externí player', externalUrl: 'https://streamtape.com/e/abc' };
  const sorted = sortBombujStreams([english4k, czechExternal], s => s.url ? 0 : 10);
  assert.equal(sorted[0], czechExternal);
  assert.equal(streamPriority(czechExternal), 0);
});

test('English with actual Czech VTT appears ahead of English without subtitles', () => {
  const plain = stream('EN dab/tit • přímý HLS');
  const withSubs = stream('EN dab/tit • přímý HLS',
    { subtitles: [sub('czech', 'cs'), sub('alternate', 'cze'), sub('english', 'en')] });
  assert.deepEqual(sortBombujStreams([plain, withSubs]), [withSubs, plain]);
  assert.equal(streamPriority(withSubs), 1);
  assert.equal(formatBombujStream(withSubs).subtitles.length, 3);
});

test('CZ/SK subtitle group is preserved without inventing an EN audio track', () => {
  const group = stream('CZ/SK titulky • externí player');
  assert.equal(streamPriority(group), 4);
  const formatted = formatBombujStream(group);
  assert.match(formatted.title, /^🎧 🌐 Původní/);
  assert.equal(formatted.subtitles, undefined);
});

test('already-formatted stream retains established labels and language priority', () => {
  const cz = formatBombujStream(stream('CZ dabing • přímý HLS'));
  const en = formatBombujStream(stream('EN dab/tit • přímý HLS',
    { subtitles: [sub('czech', 'ces')] }));
  assert.deepEqual(sortBombujStreams([en, cz]), [cz, en]);
  assert.match(cz.title, /^🎧 🇨🇿 CZ\n💬 /);
});

test('provider ranking is stable within the same language tier', () => {
  const a = stream('CZ dabing • externí player', { name: 'Bombuj • VOE', url: undefined });
  const b = stream('CZ dabing • externí player', { name: 'Bombuj • Streamtape', url: undefined });
  const score = item => item.name.includes('Streamtape') ? 0 : 10;
  assert.deepEqual(sortBombujStreams([a, b], score), [b, a]);
});
