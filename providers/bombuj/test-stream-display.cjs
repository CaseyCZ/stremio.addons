'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { formatBombujStream, subtitleTracks } = require('./stream-display.js');

const streamtape = 'https://streamtape.com/e/jrw77oXa8zUzAV4/?directSRT=true&c1_label=cz%2Fsk&c1_file=https%3A%2F%2Fserialy.bombuj.si%2Ftitulky%2Fabc.vtt';

test('movies and series use one identical CZ stream formatter without modifying video URLs', () => {
  const input={
    name:'Bombuj • streamtape.com', description:'CZ dabing • externí player',
    externalUrl:streamtape
  };
  const movie = formatBombujStream(input);
  const episode = formatBombujStream(input);
  assert.deepEqual(movie,episode);
  assert.equal(movie.externalUrl,streamtape);
  assert.equal(movie.name,'Bombuj • streamtape.com');
  assert.equal(movie.title,
    '🎧 🇨🇿 CZ\n💬 🇨🇿 CZ • 🇸🇰 SK\n🌐 Web player • streamtape.com');
  assert.equal(movie.description,undefined);
});

test('English-with-subtitles group gives correct audio flag without inventing subtitle tracks', () => {
  const input = {
    name:'Bombuj • vidlink', description:'EN dab/tit • externí player',
    externalUrl:'https://vidlink.pro/tv/288673/1/1?sub_file=&sub_label=CZSK'
  };
  const stream=formatBombujStream(input);
  assert.equal(stream.name,'Bombuj • vidlink');
  assert.equal(stream.title,'🎧 🇬🇧 EN\n💬 Bez titulků\n🌐 Web player • vidlink');
  assert.equal(stream.externalUrl,input.externalUrl);
});

test('recognizes Slovak audio and separately verified Czech subtitles', () => {
  const input={
    name:'Bombuj • voe2.sx', description:'SK dabing • externí player',
    externalUrl:'https://voe2.sx/e/example',
    subtitles:[{id:'test-cz',url:'https://serialy.bombuj.si/titulky/cz.vtt',lang:'ces'}]
  };
  const formatted=formatBombujStream(input);
  assert.equal(formatted.title,'🎧 🇸🇰 SK\n💬 🇨🇿 CZ\n🌐 Web player • voe2.sx');
  assert.deepEqual(formatted.subtitles,input.subtitles);
});

test('direct streams retain their media URL, headers and quality metadata', () => {
  const input={
    name:'Bombuj • VOE',description:'EN dab/tit • přímý HLS',
    url:'https://voe.sx/media/playlist.m3u8',
    behaviorHints:{proxyHeaders:{request:{Referer:'https://serialy.bombuj.si/'}}}
  };
  const out=formatBombujStream(input);
  assert.equal(out.name,'Bombuj • Direct');
  assert.equal(out.title,'🎧 🇬🇧 EN\n💬 Bez titulků\n🎬 Direct • VOE');
  assert.equal(out.url,input.url);
  assert.deepEqual(out.behaviorHints,input.behaviorHints);
});

test('unknown audio is labeled honestly, not mislabeled with a flag', () => {
  const stream=formatBombujStream({
    name:'Bombuj • Mystery',description:'Bombuj • externí player',
    externalUrl:'https://provider.example/video'
  });
  assert.equal(stream.title,'🎧 🌐 Neurčeno\n💬 Bez titulků\n🌐 Web player • Mystery');
});

test('movie subtitle resource still extracts subtitle query parameters', () => {
  const tracks=subtitleTracks([{externalUrl:streamtape}]);
  assert.equal(tracks.length,1);
  assert.equal(tracks[0].lang,'ces');
  assert.equal(tracks[0].url,'https://serialy.bombuj.si/titulky/abc.vtt');
});
