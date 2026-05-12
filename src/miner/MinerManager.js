'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const EventEmitter = require('events');
const StratumClient = require('../stratum/StratumClient');
const { diffToTarget, formatHashrate } = require('../utils/HashUtils');

class MinerManager extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;

    // One stratum client per pool worker
    this.stratumClients = [];
    this.workers = [];
    this.running = false;

    // Stats
    this.stats = {
      accepted: 0,
      rejected: 0,
      hashrate: 0,
      totalHashes: 0,
      startTime: null,
      lastShareTime: null,
      difficulty: 1,
      uptime: 0,
      workerHashrates: [],
      workerStats: [],   // per-stratum-worker stats
    };

    this._workerHashCounts = [];
    this._hashrateTimer = null;
    this._extraNonce2Counter = 0;

    // Expose primary stratum for dashboard compatibility
    this.stratum = null;
  }

  async start() {
    this.running = true;
    this.stats.startTime = Date.now();

    const workerDefs = this.config.pool.workers || [
      { user: this.config.pool.user, pass: this.config.pool.pass }
    ];

    this.logger.info(`Starting with ${workerDefs.length} pool worker(s), ${this.config.mining.threads} CPU thread(s)...`);

    // Init per-worker stats
    this.stats.workerStats = workerDefs.map(w => ({
      user: w.user,
      accepted: 0,
      rejected: 0,
      connected: false,
      authorized: false,
    }));

    // Spawn CPU mining threads
    this._spawnWorkers();
    this._startHashrateMonitor();

    // Connect each stratum worker
    for (let i = 0; i < workerDefs.length; i++) {
      const def = workerDefs[i];
      const poolCfg = {
        host: this.config.pool.host,
        port: this.config.pool.port,
        user: def.user,
        pass: def.pass,
        reconnectDelay: this.config.pool.reconnectDelay,
        maxReconnects: this.config.pool.maxReconnects,
        timeout: this.config.pool.timeout,
      };
      const client = new StratumClient(poolCfg, this.logger);
      this._bindStratumEvents(client, i);
      this.stratumClients.push(client);
      client.connect();
    }

    // Primary stratum = first client (for dashboard)
    this.stratum = this.stratumClients[0];
  }

  async stop() {
    this.running = false;
    this._stopHashrateMonitor();
    this._killWorkers();
    for (const client of this.stratumClients) {
      client.disconnect();
    }
    this.logger.info('Miner stopped');
  }

  _bindStratumEvents(client, index) {
    const tag = `[Worker ${index + 1}]`;

    client.on('connected', () => {
      this.stats.workerStats[index].connected = true;
      this.logger.info(`${tag} Connected`);
      this.emit('status', `connected:${index}`);
    });

    client.on('authorized', () => {
      this.stats.workerStats[index].authorized = true;
      this.logger.info(`${tag} Authorized as ${client.config.user}`);
      this.emit('status', `authorized:${index}`);
    });

    client.on('authFailed', () => {
      this.logger.error(`${tag} Authorization failed for ${client.config.user}`);
      this.emit('status', `authFailed:${index}`);
    });

    client.on('disconnected', () => {
      this.stats.workerStats[index].connected = false;
      this.stats.workerStats[index].authorized = false;
      this.logger.warn(`${tag} Disconnected`);
      this.emit('status', `disconnected:${index}`);
    });

    client.on('job', (job) => {
      this.logger.debug(`${tag} New job: ${job.id}`);
      // Only dispatch from the first authorized client to avoid duplicate work
      if (index === 0) {
        this._dispatchJob(job, client);
      }
      this.emit('job', job);
    });

    client.on('difficulty', (diff) => {
      this.stats.difficulty = diff;
      this.emit('difficulty', diff);
    });

    client.on('accepted', () => {
      this.stats.accepted++;
      this.stats.workerStats[index].accepted++;
      this.stats.lastShareTime = Date.now();
      this.logger.info(`${tag} Share ACCEPTED ✓ (total: ${this.stats.accepted})`);
      this.emit('accepted', this.stats.accepted);
    });

    client.on('rejected', () => {
      this.stats.rejected++;
      this.stats.workerStats[index].rejected++;
      this.logger.warn(`${tag} Share REJECTED ✗ (total: ${this.stats.rejected})`);
      this.emit('rejected', this.stats.rejected);
    });

    client.on('fatal', (err) => {
      this.logger.error(`${tag} Fatal:`, err.message);
    });
  }

  _spawnWorkers() {
    const threadCount = this.config.mining.threads;
    const workerScript = path.join(__dirname, 'MiningWorker.js');

    this._workerHashCounts = new Array(threadCount).fill(0);
    this.stats.workerHashrates = new Array(threadCount).fill(0);

    for (let i = 0; i < threadCount; i++) {
      this._spawnSingleWorker(i, workerScript);
    }
  }

  _spawnSingleWorker(i, workerScript) {
    workerScript = workerScript || path.join(__dirname, 'MiningWorker.js');
    const worker = new Worker(workerScript, {
      workerData: { threadId: i, intensity: this.config.mining.intensity },
    });
    worker.threadId_custom = i;
    worker.active = false;

    worker.on('message', (msg) => this._onWorkerMessage(i, worker, msg));
    worker.on('error', (err) => this.logger.error(`Thread ${i} error:`, err.message));
    worker.on('exit', (code) => {
      if (this.running) {
        this.logger.warn(`Thread ${i} exited (${code}), restarting...`);
        setTimeout(() => this._spawnSingleWorker(i), 1000);
      }
    });

    this.workers[i] = worker;
  }

  _killWorkers() {
    for (const worker of this.workers) {
      if (worker) {
        worker.postMessage({ type: 'stop' });
        worker.terminate();
      }
    }
    this.workers = [];
  }

  _dispatchJob(job, sourceClient) {
    const diff = job.difficulty || this.stats.difficulty;
    const target = diffToTarget(diff);
    this._currentTarget = target.toString('hex');
    this._currentJob = job;
    this._sourceClient = sourceClient;

    const nonceRange = Math.floor(0xFFFFFFFF / Math.max(this.workers.length, 1));

    for (let i = 0; i < this.workers.length; i++) {
      const worker = this.workers[i];
      if (!worker) continue;

      worker.postMessage({
        type: 'job',
        job,
        target: this._currentTarget,
        startNonce: i * nonceRange,
        nonceRange,
        extraNonce2: this._nextExtraNonce2(i),
      });
      worker.active = true;
    }
  }

  _nextExtraNonce2(workerIndex) {
    this._extraNonce2Counter++;
    const client = this.stratumClients[0];
    const size = (client && client.extraNonce2Size) || 4;
    const val = (this._extraNonce2Counter * this.workers.length + workerIndex) >>> 0;
    return val.toString(16).padStart(size * 2, '0');
  }

  _onWorkerMessage(index, worker, msg) {
    switch (msg.type) {
      case 'found':
        this._onShareFound(msg);
        break;

      case 'hashrate':
        this._workerHashCounts[index] = (this._workerHashCounts[index] || 0) + msg.hashes;
        this.stats.workerHashrates[index] = msg.hashes / 5;
        this.stats.totalHashes += msg.hashes;
        break;

      case 'nonceExhausted':
        if (this._currentJob) {
          const nonceRange = Math.floor(0xFFFFFFFF / Math.max(this.workers.length, 1));
          worker.postMessage({
            type: 'job',
            job: this._currentJob,
            target: this._currentTarget,
            startNonce: index * nonceRange,
            nonceRange,
            extraNonce2: this._nextExtraNonce2(index),
          });
        }
        break;

      case 'idle':
        worker.active = false;
        break;
    }
  }

  async _onShareFound(share) {
    // Submit to ALL authorized stratum clients for maximum credit
    const job = this._currentJob;
    if (!job || job.id !== share.jobId) {
      this.logger.debug('Stale share discarded');
      return;
    }

    this.logger.info(`Share found! Nonce: ${share.nonce} | Submitting to all workers...`);

    for (let i = 0; i < this.stratumClients.length; i++) {
      const client = this.stratumClients[i];
      if (client.authorized) {
        await client.submit(share.jobId, share.extraNonce2, share.ntime, share.nonce);
      }
    }

    this.emit('share', share);
  }

  _startHashrateMonitor() {
    const interval = (this.config.mining.scanTime || 5) * 1000;
    this._hashrateTimer = setInterval(() => {
      const total = this.stats.workerHashrates.reduce((a, b) => a + b, 0);
      this.stats.hashrate = total;
      this.stats.uptime = Math.floor((Date.now() - this.stats.startTime) / 1000);
      this.emit('hashrate', total);
    }, interval);
  }

  _stopHashrateMonitor() {
    if (this._hashrateTimer) {
      clearInterval(this._hashrateTimer);
      this._hashrateTimer = null;
    }
  }

  getStats() {
    return { ...this.stats };
  }
}

module.exports = MinerManager;
