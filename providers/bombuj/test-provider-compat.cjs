'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { confirmedStremioEmbedFailure } = require('./provider-compat.js');

test('known Byse embeds are excluded from Stremio web player', () => {
  for (const url of [
    'https://bysekoze.com/e/abc/',
    'https://www.bysekoze.com/e/abc/',
    'https://byse.sx/e/abc/'
  ]) {
    assert.match(confirmedStremioEmbedFailure(url), /embedding-domain-not-authorized/);
  }
});

test('unknown providers and spoofed domains remain available to ordinary preflight', () => {
  for (const url of [
    'https://vidlink.pro/movie/27205',
    'https://voe.sx/e/6aakbggmgzpk',
    'https://notbysekoze.com/e/test',
    'https://bysekoze.com.evil.example/e/test',
    'javascript:alert(1)'
  ]) {
    assert.equal(confirmedStremioEmbedFailure(url), null);
  }
});

test('the two observed Videasy player domains are excluded', () => {
  for (const url of [
    'https://player.videasy.to/movie/27205',
    'https://player.videasy.net/movie/1291595?sub_url=',
    'https://PLAYER.VIDEASY.TO/movie/27205'
  ]) {
    assert.equal(confirmedStremioEmbedFailure(url), 'blank-player-in-stremio:videasy');
  }
});

test('other Primewire links and unrelated Videasy-like hosts are not hidden', () => {
  for (const url of [
    'https://primewire.example/embed/some-video',
    'https://player.videasy.to.evil.example/movie/27205',
    'https://notplayer.videasy.to/movie/27205',
    'https://vidsrc.xyz/embed/movie/27205',
    'https://voe.sx/e/xyz',
    'https://vidapi.ru/movie/27205',
    'https://vidnest.org/embed/movie/27205'
  ]) {
    assert.equal(confirmedStremioEmbedFailure(url), null);
  }
});

test('Mixdrop web embeds are excluded when the host is a verified Mixdrop domain', () => {
  for (const host of [
    'mixdrop.ag', 'mixdrop.co', 'mixdrop.to', 'mixdrop.sx',
    'mixdrop.ps', 'mixdrop.my', 'miixdrop.net', 'miiiixdrop.net',
    'www.mixdrop.ag'
  ]) {
    assert.equal(
      confirmedStremioEmbedFailure('https://' + host + '/e/video123'),
      'embedding-domain-protected:mixdrop'
    );
  }
});

test('other embed providers and spoofed Mixdrop domains are not excluded', () => {
  for (const url of [
    'https://notmixdrop.ag/e/video123',
    'https://mixdrop.ag.attacker.example/e/video123',
    'https://videos.example.test/video.mp4',
    'https://vidlink.pro/movie/27205',
    'https://voe.sx/e/video123',
    'https://streamtape.com/e/video123'
  ]) {
    assert.equal(confirmedStremioEmbedFailure(url), null);
  }
});

test('Cloudflare-blocked vsembed.ru embeds are omitted from Stremio', () => {
  for (const url of [
    'https://vsembed.ru/embed/movie?imdb=tt1375666',
    'https://www.vsembed.ru/embed/movie?imdb=tt32393988',
    'https://VSEMBED.RU/embed/tv?imdb=tt123456'
  ]) {
    assert.equal(confirmedStremioEmbedFailure(url), 'cloudflare-client-block:vsembed.ru');
  }
});

test('unrelated Vidsrc players and similar-looking hostnames remain eligible', () => {
  for (const url of [
    'https://vidsrc.xyz/embed/movie/27205',
    'https://vidsrc.to/embed/movie/27205',
    'https://vsembed.ru.fake.example/embed/movie',
    'https://notvsembed.ru/embed/movie',
    'https://cdn.example.test/video.m3u8',
    'https://voe.sx/e/abc123',
    'https://streamtape.com/e/xyz'
  ]) {
    assert.equal(confirmedStremioEmbedFailure(url), null);
  }
});
