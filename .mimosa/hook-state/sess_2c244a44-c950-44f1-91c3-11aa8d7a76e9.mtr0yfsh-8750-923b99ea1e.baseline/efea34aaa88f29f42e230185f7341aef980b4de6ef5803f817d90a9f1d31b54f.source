const TRIOS_ROOT = process.env.TRIOS_ROOT || __dirname;

module.exports = {
  apps: [
    {
      name: 'clade-monitor',
      script: './target/release/clade-monitor',
      cwd: TRIOS_ROOT,
      env: {
        TRIOS_ROOT: TRIOS_ROOT,
        TRIOS_PORT_SOVEREIGN: '9105',
        TRIOS_PORT_A2A: '9200',
        TRIOS_PORT_CANARY: '9205',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
    },
    {
      name: 'clade-dashboard',
      script: './target/release/clade-dashboard',
      cwd: TRIOS_ROOT,
      env: {
        TRIOS_ROOT: TRIOS_ROOT,
        TRIOS_PORT_DASHBOARD: '9405',
        TRIOS_PORT_SOVEREIGN: '9105',
        TRIOS_PORT_CANARY: '9205',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
