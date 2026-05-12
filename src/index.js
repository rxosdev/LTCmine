'use strict';

require('dotenv').config();
const { program } = require('commander');
const os = require('os');
const MinerManager = require('./miner/MinerManager');
const Dashboard = require('./ui/Dashboard');
const Logger = require('./utils/Logger');
const config = require('./config');

program
  .name('ltc-miner')
  .description('Optimized Litecoin CPU Miner')
  .version('1.0.0')
  .option('-H, --host <host>', 'Pool host', config.pool.host)
  .option('-p, --port <port>', 'Pool port', config.pool.port)
  .option('-u, --user <user>', 'Pool username', config.pool.user)
  .option('-P, --pass <pass>', 'Pool password', config.pool.pass)
  .option('-t, --threads <n>', 'Number of mining threads (0=auto)', String(config.mining.threads))
  .option('-i, --intensity <n>', 'Mining intensity 1-10', String(config.mining.intensity))
  .option('--no-dashboard', 'Disable TUI dashboard')
  .parse(process.argv);

const opts = program.opts();

config.pool.host = opts.host;
config.pool.port = parseInt(opts.port);
config.pool.user = opts.user;
config.pool.pass = opts.pass;
config.mining.threads = parseInt(opts.threads) || os.cpus().length;
config.mining.intensity = Math.min(10, Math.max(1, parseInt(opts.intensity)));

const logger = new Logger(config.log);

async function main() {
  logger.info('=== LTC Miner v1.0.0 ===');
  logger.info(`Pool: ${config.pool.host}:${config.pool.port}`);
  logger.info(`Worker: ${config.pool.user}`);
  logger.info(`Threads: ${config.mining.threads} | Intensity: ${config.mining.intensity}`);

  const manager = new MinerManager(config, logger);

  let dashboard = null;
  if (opts.dashboard !== false) {
    dashboard = new Dashboard(manager, config);
    dashboard.start();
  }

  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    await manager.stop();
    if (dashboard) dashboard.stop();
    process.exit(0);
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err.message);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);
  });

  await manager.start();
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
