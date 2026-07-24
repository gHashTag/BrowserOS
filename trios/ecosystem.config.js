// PM2 ecosystem config for trios native services.
//
// P4: paths are no longer hardcoded to a single developer's macOS layout.
// TRIOS_ROOT resolves in this order:
//   1. process.env.TRIOS_ROOT (explicit override, works on any host/OS)
//   2. the directory this config file lives in (portable default)
// This keeps the file identical across macOS/Linux checkouts and CI.
const path = require('path');

const TRIOS_ROOT = process.env.TRIOS_ROOT || __dirname;

module.exports = {
  apps: [
    {
      name: 'clade-monitor',
      script: './target/release/clade-monitor',
      cwd: TRIOS_ROOT,
      env: {
        TRIOS_ROOT,
        TRIOS_PORT_SOVEREIGN: process.env.TRIOS_PORT_SOVEREIGN || '9105',
        TRIOS_PORT_A2A: process.env.TRIOS_PORT_A2A || '9200',
        TRIOS_PORT_CANARY: process.env.TRIOS_PORT_CANARY || '9205',
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
        TRIOS_ROOT,
        TRIOS_PORT_DASHBOARD: process.env.TRIOS_PORT_DASHBOARD || '9405',
        TRIOS_PORT_SOVEREIGN: process.env.TRIOS_PORT_SOVEREIGN || '9105',
        TRIOS_PORT_CANARY: process.env.TRIOS_PORT_CANARY || '9205',
      },
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
