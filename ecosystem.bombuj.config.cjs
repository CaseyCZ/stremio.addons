'use strict';

// Bombuj remains a separate PM2 process and public /stremio-bombuj/ route,
// but its code now comes from the unified SKTOnline + Bombuj repository.
const path = require('node:path');
module.exports = {
  apps: [{
    name: 'stremio-bombuj',
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
      BOMBUJ_DIRECT_VOE: '0'
    }
  }]
};
