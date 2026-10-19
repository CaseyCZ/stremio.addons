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
      PORT: '7004',
      // Provider-direct HLS with the original web player kept as fallback.
      BOMBUJ_DIRECT_VOE: '1'
    }
  }]
};
