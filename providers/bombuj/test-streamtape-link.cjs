'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { validStreamtapeEmbed } = require('./streamtape-link.js');

const direct = 'https://streamtape.com/e/jrw77oXa8zUzAV4/?directSRT=true&c1_label=cz%2Fsk';

test('Streamtape external URL remains direct and keeps subtitle parameters', () => {
  const parsed = validStreamtapeEmbed(direct);
  assert.equal(parsed, direct);
  assert.equal(new URL(parsed).hostname,'streamtape.com');
  assert.equal(new URL(parsed).searchParams.get('c1_label'),'cz/sk');
});

test('only true Streamtape HTTPS embeds qualify for special reachability checks', () => {
  const valid=['https://streamtape.com/e/jrw77oXa8zUzAV4','https://www.streamtape.com/e/jrw77oXa8zUzAV4/'];
  for(const url of valid)assert.equal(validStreamtapeEmbed(url),url);
  for(const candidate of [
    'https://evil.test/e/jrw77oXa8zUzAV4',
    'https://streamtape.com.evil.test/e/jrw77oXa8zUzAV4',
    'https://streamtape.com/redirect?url=https://evil.test',
    'http://streamtape.com/e/jrw77oXa8zUzAV4',
    'https://streamtape.com@evil.test/e/jrw77oXa8zUzAV4',
    'https://streamtape.com/e/id/../../evil'
  ])assert.equal(validStreamtapeEmbed(candidate),null,candidate);
});

test('public addon does not expose a Streamtape navigation redirect', () => {
  const front=readFileSync(require.resolve('./preflight-front.js'),'utf8');
  assert(!front.includes('open/streamtape'));
  assert(!front.includes('neutralRedirectUrl'));
  assert(!front.includes('Referrer-Policy'));
  assert.match(front,/direct-only=\$\{direct\.length\} omitted-web=/);
});
