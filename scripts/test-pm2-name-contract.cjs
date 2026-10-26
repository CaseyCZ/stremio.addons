'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = require(path.join(root, 'ecosystem.config.js')).apps[0];
const bombuj = require(path.join(root, 'ecosystem.bombuj.config.cjs')).apps[0];
assert.equal(main.name, 'stremio-addons');
assert.equal(bombuj.name, 'stremio-addons-bombuj');
assert.equal(Number(main.env.PORT), 7003);
assert.equal(Number(bombuj.env.PORT), 7004);
assert.equal(main.cwd, root);
assert.equal(bombuj.cwd, path.join(root, 'providers/bombuj'));
assert.equal(main.script, './addon.js');
assert.equal(bombuj.script, 'preflight-front.js');
assert.equal(main.env.RUNNER_TRACKING_ID, '');
assert.equal(bombuj.env.RUNNER_TRACKING_ID, '');
assert.equal(main.env.CONFIG_ENCRYPTION_KEY_FILE, '/home/ubuntu/.stremio-sktonline-config-key');
assert.equal(bombuj.env.BOMBUJ_DIRECT_VOE, '1');

const deploy = fs.readFileSync(path.join(root,'deploy-server.sh'),'utf8');
assert.ok(deploy.includes('bash "$PWD/scripts/migrate-pm2-unified-names.sh"'));
assert.ok(deploy.indexOf('bash "$PWD/scripts/migrate-pm2-unified-names.sh"') <
          deploy.indexOf('pm2 startOrReload ecosystem.config.js --only stremio-addons --update-env'));
const provider = fs.readFileSync(path.join(root,'deploy-bombuj-runtime.sh'),'utf8');
assert.ok(provider.includes("pm2 startOrReload \"$CONF\" --only stremio-addons-bombuj"));
assert.ok(provider.includes("apps=JSON.parse(fs.readFileSync(process.argv[2],'utf8')).filter(x=>x.name==='stremio-addons-bombuj')"));
assert.ok(!provider.includes('pm2 restart stremio-bombuj'));
assert.ok(!provider.includes('--only stremio-bombuj'));

const migrate = fs.readFileSync(path.join(root,'scripts/migrate-pm2-unified-names.sh'),'utf8');
for (const fragment of [
  'pm2 delete stremio-sktonline',
  'pm2 delete stremio-bombuj',
  '--only stremio-addons --update-env',
  '--only stremio-addons-bombuj --update-env',
  'rollback()',
  'pm2 save',
  'http://127.0.0.1:7003/health',
  'http://127.0.0.1:7004/manifest.json'
]) assert.ok(migrate.includes(fragment), fragment);

console.log('Unified PM2 names, unchanged ports and rollback contract verified.');
