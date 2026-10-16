module.exports = {
  apps: [
    {
      name: 'stremio-sktonline',
      script: './addon.js',
      cwd: __dirname,
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 7002,
        CONFIG_ENCRYPTION_KEY_FILE: '/home/ubuntu/.stremio-sktonline-config-key'
      }
    }
  ]
};
