module.exports = {
  apps: [
    {
      name: 'bitmcp',
      script: 'server.js',
      cwd: '/www/wwwroot/bitmcp',
      instances: 1,
      autorestart: true,
      max_memory_restart: '200M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
