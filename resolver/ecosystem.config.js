module.exports = {
  apps: [
    {
      name: 'sktonline-home-resolver',
      script: 'resolver/server.js',
      cwd: __dirname + '/..',
      env: {
        PORT: 7010
      },
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000
    }
  ]
};
