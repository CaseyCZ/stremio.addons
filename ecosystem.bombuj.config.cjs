'use strict';

// Bombuj runs as a separate internal PM2 process on port 7004;
// its public manifest is under /stremio-addons/bombuj/ in the unified repository.
const path = require('node:path');
module.exports = {
  apps: [{
    name: 'stremio-addons-bombuj',
    script: 'preflight-front.js',
    cwd: path.join(__dirname, 'providers', 'bombuj'),
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    env: {
      NODE_ENV: 'production',
      // PM2 services must survive GitHub Actions job cleanup.
      RUNNER_TRACKING_ID: '',
      PORT: '7004',
      // Cross-network CDN requests return 403; keep VOE in its web player.
      BOMBUJ_DIRECT_VOE: '0',
      // Personal production trial: each opt-in resolver retains the original
      // web player as a fallback for expiring or IP-bound direct media links.
      BOMBUJ_DIRECT_VIDARA: '1',
      BOMBUJ_DIRECT_PLOYAN: '1',
      BOMBUJ_DIRECT_VIDAPI: '1',
      BOMBUJ_DIRECT_VIDNEST: '1',
      BOMBUJ_DIRECT_VIDLINK: '1',
      BOMBUJ_DIRECT_VIDEASY: '1',
      BOMBUJ_DIRECT_STREAMTAPE: '1'
    }
  }]
};
