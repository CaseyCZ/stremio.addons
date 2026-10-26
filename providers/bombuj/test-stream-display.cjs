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
    '🎧 🇨🇿 CZ\n💬 🇨🇿 CZ / 🇸🇰 SK\n🌐 Web player • streamtape.com');
  assert.equal(movie.description,undefined);
});

test('English-with-subtitles group gives correct audio flag without inventing subtitle tracks', () => {
  const input = {
    name:'Bombuj • vidlink', description:'EN dab/tit • externí player',
    externalUrl:'https://vidlink.pro/tv/288673/1/1?sub_file=&sub_label=CZSK'
  };
  const stream=formatBombujStream(input);
  assert.equal(stream.name,'Bombuj • vidlink');
  assert.equal(stream.title,'🎧 🇬🇧 EN\n💬 🇨🇿 CZ / 🇸🇰 SK (Bombuj)\n🌐 Web player • vidlink');
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
  assert.equal(out.name,'Bombuj • Kvalita neuvedena');
  assert.equal(out.title,'🎧 🇬🇧 EN\n💬 Neuvedeny\n🎬 Kvalita neuvedena');
  assert.equal(out.url,input.url);
  assert.deepEqual(out.behaviorHints,input.behaviorHints);
});

test('VidLink browser-ready MP4 keeps its WEB TEST label across formatting passes', () => {
  const input = {
    name: 'Bombuj • vidlink', description: 'CZ/SK titulky • přímý MP4 • 1080p • WEB TEST',
    url: 'https://bcdn.hakunaymatata.com/test.mp4',
    behaviorHints: { filename: 'bombuj-2-1080p.mp4' }
  };
  const once = formatBombujStream(input);
  const twice = formatBombujStream(once);
  assert.match(once.name, /WEB TEST/);
  assert.match(once.title, /🎬 .*WEB TEST/);
  assert.equal(twice.name, once.name);
  assert.equal(twice.title, once.title);
  assert.equal(twice.url, input.url);
  assert(!('notWebReady' in twice.behaviorHints));
  assert(!('proxyHeaders' in twice.behaviorHints));
  const front = wrapperFunctions('./front.js', ['displayDirect']);
  const publicStream = front.displayDirect(twice);
  assert.match(publicStream.name, /WEB TEST/);
  assert.match(publicStream.title, /🎬 .*WEB TEST/);
  assert.equal(publicStream.url, input.url);
});

test('unknown audio is labeled honestly, not mislabeled with a flag', () => {
  const stream=formatBombujStream({
    name:'Bombuj • Mystery',description:'Bombuj • externí player',
    externalUrl:'https://provider.example/video'
  });
  assert.equal(stream.title,'🎧 🌐 Neurčeno\n💬 Neuvedeny\n🌐 Web player • Mystery');
});

test('movie subtitle resource still extracts subtitle query parameters', () => {
  const tracks=subtitleTracks([{externalUrl:streamtape}]);
  assert.equal(tracks.length,1);
  assert.equal(tracks[0].lang,'und');
  assert.equal(tracks[0].url,'https://serialy.bombuj.si/titulky/abc.vtt');
});

function wrapperFunctions(filename, names) {
  const fs = require('node:fs'), vm = require('node:vm');
  const file = require.resolve(filename), local = require('node:module').createRequire(file);
  const mod = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + `\nmodule.exports={${names.join(',')}};`, {
    require: p => p === 'http' ? { createServer: () => ({ listen() {} }) } :
      ['./index.js', './bootstrap.js'].includes(p) ? {} : local(p),
    module: mod, process: { env: {} }, console: { log() {}, error() {} },
    global: { fetch: () => { throw Error('unexpected network request'); } }, URL, AbortSignal
  });
  return mod.exports;
}

test('all four Bombuj groups survive front/bootstrap direct movie/episode formatting', () => {
  const front = wrapperFunctions('./front.js', ['displayDirect']);
  const boot = wrapperFunctions('./bootstrap.js', ['nativeTitle']);
  for (const [group, audio] of [
    ['CZ dabing', '🇨🇿 CZ'], ['SK dabing', '🇸🇰 SK'],
    ['CZ/SK titulky', '🌐 Původní'], ['EN dab/tit', '🇬🇧 EN']
  ]) {
    const raw = { name: 'Bombuj • VOE', description: group + ' • přímý HLS', url: 'https://cdn.example/video.m3u8' };
    const expected = formatBombujStream(raw);
    assert.equal(expected.title.split('\n')[0], '🎧 ' + audio);
    assert.equal(formatBombujStream(expected).title, expected.title);
    assert.equal(formatBombujStream(front.displayDirect(raw)).title, expected.title);
    assert.equal(formatBombujStream({ ...raw, name: 'Bombuj • Direct', title: boot.nativeTitle(raw), description: undefined }).title, expected.title);
  }
});

test('subtitle section does not invent English audio or downloadable subtitle files', () => {
  const stream = formatBombujStream({ name: 'Bombuj • VOE', description: 'CZ/SK titulky • externí player', externalUrl: 'https://voe.sx/e/fixture' });
  assert.match(stream.title, /^🎧 🌐 Původní\n💬 🇨🇿 CZ \/ 🇸🇰 SK \(Bombuj\)/);
  assert.equal(stream.subtitles, undefined);
});

test('explicit VOE Czech subtitle overrides combined section; Slovak query is not defaulted to Czech', () => {
  const raw = { name: 'Bombuj • VOE', description: 'CZ/SK titulky • externí player', externalUrl: 'https://voe.sx/e/fixture?subtitles=' + encodeURIComponent('CZSK;cs;https://cdn.example/cz.vtt') };
  const stream = formatBombujStream(raw);
  assert.match(stream.title, /💬 🇨🇿 CZ\n/);
  assert.equal(stream.subtitles[0].lang, 'ces');
  const tracks = subtitleTracks([{ externalUrl: 'https://provider.example/e/fixture?c1_lang=sk&c1_file=https%3A%2F%2Fcdn.example%2Fsk.vtt' }]);
  assert.equal(tracks[0].lang, 'slk');
  assert.equal(subtitleTracks([{ subtitles: [{ url: 'https://cdn.example/unknown.vtt' }] }])[0].lang, 'und');
});

test('additional language groups are parsed dynamically with separate audio and subtitle roles', () => {
  for (const [group, audio, subtitles] of [
    ['DE dabing', '🇩🇪 DE', 'Neuvedeny'],
    ['FR titulky', '🌐 Původní', '🇫🇷 FR (Bombuj)'],
    ['JA audio + CZ titulky', '🇯🇵 JA', '🇨🇿 CZ (Bombuj)'],
    ['Český dabing + SK titulky', '🇨🇿 CZ', '🇸🇰 SK (Bombuj)'],
    ['CZ / SK dabing', '🇨🇿 CZ / 🇸🇰 SK', 'Neuvedeny'],
    ['English subtitles', '🌐 Původní', '🇬🇧 EN (Bombuj)'],
    ['Nová speciální verze', '🌐 Nová speciální verze', 'Neuvedeny'],
    ['XYZ titulky', '🌐 Původní', 'XYZ titulky (Bombuj)']
  ]) {
    const raw = { name: 'Bombuj • VOE', description: group + ' • přímý HLS', url: 'https://cdn.example/video.m3u8' };
    const result = formatBombujStream(raw);
    assert.equal(result.title.split('\n')[0], '🎧 ' + audio, group);
    assert.equal(result.title.split('\n')[1], '💬 ' + subtitles, group);
    assert.equal(formatBombujStream(result).title, result.title, group);
    assert.equal(result.subtitles, undefined);
  }
});

test('all supplied subtitle languages are shown, including languages beyond the original four groups', () => {
  const stream = formatBombujStream({ name: 'Bombuj • VOE', description: 'JA audio • přímý HLS', url: 'https://cdn.example/video.m3u8',
    subtitles: [{ url: 'https://cdn.example/de.vtt', lang: 'de' }, { url: 'https://cdn.example/fr.vtt', lang: 'fra' }, { url: 'https://cdn.example/ar.vtt', lang: 'ar' }] });
  assert.match(stream.title, /💬 🇩🇪 DE • 🇫🇷 FR • 🌐 AR\n/);
  assert.deepEqual(stream.subtitles.map(s => s.lang), ['deu', 'fra', 'ara']);
});

test('arbitrary new accordion sections stay bound to their own links', () => {
  const { parseBombujPlayerGroups } = require('./player-groups');
  const groups = ['DE dabing', 'FR titulky', 'JA audio + CZ titulky', 'Nová speciální verze'];
  const html = groups.map((label, i) => `<div class="dropdownlink">${label}</div><ul><li link="https://provider.example/${i}"><a>Player</a></li></ul>`).join('');
  const players = parseBombujPlayerGroups(html);
  assert.deepEqual(players.map(p => p.language), groups);
  assert.deepEqual(players.map(p => p.url), groups.map((_, i) => `https://provider.example/${i}`));
  const formatted = players.map(p => formatBombujStream({ name: 'Bombuj • ' + p.provider, description: p.language + ' • externí player', externalUrl: p.url }));
  assert.match(formatted[0].title, /^🎧 🇩🇪 DE/);
  assert.match(formatted[1].title, /💬 🇫🇷 FR \(Bombuj\)/);
  assert.match(formatted[2].title, /^🎧 🇯🇵 JA\n💬 🇨🇿 CZ/);
  assert.match(formatted[3].title, /^🎧 🌐 Nová speciální verze/);
});
