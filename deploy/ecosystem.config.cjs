module.exports = {
  apps: [
    {
      name: 'haunted-house-sync',
      script: 'server/src/index.js',
      node_args: '--no-warnings',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: '3000',
        SERVE_FRONTEND: 'false',
        TRUST_PROXY: 'true'
      }
    }
  ]
};
