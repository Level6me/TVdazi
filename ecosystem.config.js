module.exports = {
  apps: [
    {
      name: 'wesaver',
      script: 'dist/login.js',
      cwd: './',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '350M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
