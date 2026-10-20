'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../public/configure.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);

test('configuration and analytics JavaScript compile', () => {
  assert.equal(scripts.length, 2);
  for (const js of scripts) assert.doesNotThrow(() => new vm.Script(js));
  assert.match(scripts[0], /refreshTorrent\(\)/);
});
test('analytics uses existing GA4 property with its own explicit consent', () => {
  const js = scripts[1];
  assert.match(js, /G-SZTERTRTCE/);
  assert.match(js, /stremio-addons-analytics-consent-v1/);
  assert.match(js, /if \(consent === 'granted'\) loadAnalytics\(\)/);
  assert.match(js, /else showBanner\(\)/);
  assert.match(js, /showSettingsButton\(\)/);
});
test('encrypted configuration paths and query are never sent to GA', () => {
  const js = scripts[1];
  assert.match(js, /PAGE_LOCATION = \`\$\{location.origin\}\/stremio-addons\/configure\`/);
  assert.doesNotMatch(js, /PAGE_LOCATION\s*=\s*[^;]*(?:location\.pathname|location\.search)/);
  assert.match(js, /ad_storage: 'denied'/);
  assert.match(js, /ad_personalization: 'denied'/);
});
test('no GA requests are started without visitor consent', () => {
  const js = scripts[1];
  const inserted = [];
  const fakeNode = () => ({
    dataset: {}, children: [], setAttribute() {}, addEventListener() {},
    appendChild(n) { this.children.push(n); }, remove() {},
    querySelector() { return { addEventListener() {} }; }
  });
  const body = fakeNode();
  const document = {
    readyState: 'complete', documentElement: { lang:'cs' },
    body, title:'Config', cookie:'',
    head: { appendChild(n) { inserted.push(n); } },
    querySelector() { return null; }, getElementById() { return null; },
    createElement() { return fakeNode(); }, addEventListener() {}
  };
  const sandbox = { document, localStorage: {getItem() {return null;},setItem() {}},
    location: {origin:'https://example.test',pathname:'/enc1.secret/configure',
      search:'?secret=yes',hostname:'example.test'}, navigator:{language:'cs'},window:{} };
  vm.runInNewContext(js, sandbox);
  assert.equal(inserted.some(n => String(n.src||'').includes('googletagmanager.com')), false);
  assert.equal(sandbox.window.gtag, undefined);
  assert.ok(body.children.length > 0);
});