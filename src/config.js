'use strict';

const os = require('os');

module.exports = {
  pool: {
    host: process.env.POOL_HOST || 'us.litecoinpool.org',
    port: parseInt(process.env.POOL_PORT) || 3333,
    workers: [
      { user: 'rxlok.', pass: '' },
      { user: 'rxlok.', pass: '' },
      { user: 'rxlok.', pass: '' },
      { user: 'rxlok.', pass: '' },
    ],
    user: process.env.POOL_USER || 'rxlok.',
    pass: process.env.POOL_PASS || '',
    reconnectDelay: 5000,
    maxReconnects: 0,
    timeout: 30000,
  },
  mining: {
    threads: parseInt(process.env.THREADS) || os.cpus().length,
    intensity: parseInt(process.env.INTENSITY) || 8,
    scanTime: parseInt(process.env.SCAN_TIME) || 5,
    scryptN: 1024,
    scryptR: 1,
    scryptP: 1,
    scryptLen: 32,
  },
  log: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || 'miner.log',
  },
};
