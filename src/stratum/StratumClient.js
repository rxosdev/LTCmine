'use strict';

const net = require('net');
const EventEmitter = require('events');

class StratumClient extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.socket = null;
    this.connected = false;
    this.authorized = false;
    this.subscribed = false;
    this._msgId = 1;
    this._pending = new Map();
    this._buf = '';
    this._reconnectTimer = null;
    this._reconnectCount = 0;
    this.extraNonce1 = '';
    this.extraNonce2Size = 4;
    this.currentJob = null;
    this.difficulty = 1;
  }

  connect() {
    this.logger.info(`Connecting to ${this.config.host}:${this.config.port}...`);
    this._cleanup();

    this.socket = new net.Socket();
    this.socket.setEncoding('utf8');
    this.socket.setTimeout(this.config.timeout || 30000);

    this.socket.on('connect', () => this._onConnect());
    this.socket.on('data', (data) => this._onData(data));
    this.socket.on('error', (err) => this._onError(err));
    this.socket.on('close', () => this._onClose());
    this.socket.on('timeout', () => {
      this.logger.warn('Socket timeout');
      this.socket.destroy();
    });

    this.socket.connect(this.config.port, this.config.host);
  }

  disconnect() {
    this._reconnectCount = -1;
    this._cleanup();
  }

  _cleanup() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.authorized = false;
    this.subscribed = false;
    this._buf = '';
    this._pending.clear();
  }

  _onConnect() {
    this.connected = true;
    this._reconnectCount = 0;
    this.logger.info('Connected to pool');
    this.emit('connected');
    this._subscribe();
  }

  _onData(data) {
    this._buf += data;
    const lines = this._buf.split('\n');
    this._buf = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        this._handleMessage(msg);
      } catch (e) {
        this.logger.debug('Parse error:', e.message, '| Raw:', trimmed.slice(0, 100));
      }
    }
  }

  _onError(err) {
    this.logger.error('Socket error:', err.message);
    this.emit('error', err);
  }

  _onClose() {
    this.connected = false;
    this.logger.warn('Disconnected from pool');
    this.emit('disconnected');

    if (this._reconnectCount === -1) return;

    const maxReconnects = this.config.maxReconnects || 0;
    if (maxReconnects > 0 && this._reconnectCount >= maxReconnects) {
      this.logger.error('Max reconnect attempts reached');
      this.emit('fatal', new Error('Max reconnects exceeded'));
      return;
    }

    this._reconnectCount++;
    const delay = this.config.reconnectDelay || 5000;
    this.logger.info(`Reconnecting in ${delay / 1000}s... (attempt ${this._reconnectCount})`);
    this._reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  _send(method, params) {
    const id = this._msgId++;
    const msg = JSON.stringify({ id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.connected) {
        return reject(new Error('Not connected'));
      }
      this._pending.set(id, { resolve, reject, method });
      this.socket.write(msg, (err) => {
        if (err) {
          this._pending.delete(id);
          reject(err);
        }
      });
    });
  }

  _handleMessage(msg) {
    if (msg.id !== null && msg.id !== undefined && this._pending.has(msg.id)) {
      const { resolve, reject, method } = this._pending.get(msg.id);
      this._pending.delete(msg.id);

      if (msg.error) {
        this.logger.warn(`${method} error:`, JSON.stringify(msg.error));
        reject(new Error(JSON.stringify(msg.error)));
      } else {
        this._handleResponse(method, msg.result);
        resolve(msg.result);
      }
      return;
    }

    if (msg.method) {
      this._handleNotification(msg.method, msg.params);
    }
  }

  _handleResponse(method, result) {
    switch (method) {
      case 'mining.subscribe': this._onSubscribeResult(result); break;
      case 'mining.authorize': this._onAuthorizeResult(result); break;
      case 'mining.submit':    this._onSubmitResult(result);    break;
    }
  }

  _handleNotification(method, params) {
    switch (method) {
      case 'mining.notify':         this._onNotify(params);         break;
      case 'mining.set_difficulty': this._onSetDifficulty(params);  break;
      case 'mining.set_extranonce': this._onSetExtranonce(params);  break;
      case 'client.reconnect':
        this.logger.info('Pool requested reconnect');
        this._onClose();
        break;
      default:
        this.logger.debug('Unknown notification:', method);
    }
  }

  async _subscribe() {
    try {
      await this._send('mining.subscribe', [
        'ltc-miner/1.0.0', null, this.config.host, String(this.config.port),
      ]);
    } catch (err) {
      this.logger.error('Subscribe failed:', err.message);
    }
  }

  _onSubscribeResult(result) {
    if (!Array.isArray(result) || result.length < 3) {
      this.logger.error('Invalid subscribe response');
      return;
    }
    this.extraNonce1 = result[1];
    this.extraNonce2Size = result[2];
    this.subscribed = true;
    this.logger.info(`Subscribed | ExtraNonce1: ${this.extraNonce1} | EN2 size: ${this.extraNonce2Size}`);
    this.emit('subscribed');
    this._authorize();
  }

  async _authorize() {
    try {
      await this._send('mining.authorize', [this.config.user, this.config.pass]);
    } catch (err) {
      this.logger.error('Authorize failed:', err.message);
    }
  }

  _onAuthorizeResult(result) {
    if (result === true) {
      this.authorized = true;
      this.logger.info(`Authorized as ${this.config.user}`);
      this.emit('authorized');
    } else {
      this.logger.error('Authorization rejected by pool');
      this.emit('authFailed');
    }
  }

  _onNotify(params) {
    if (!params || params.length < 9) return;

    const [jobId, prevhash, coinb1, coinb2, merkleBranches, version, nbits, ntime, cleanJobs] = params;

    const job = {
      id: jobId,
      prevhash,
      coinb1,
      coinb2,
      merkleBranches,
      version: parseInt(version, 16),
      nbits,
      ntime,
      cleanJobs,
      extraNonce1: this.extraNonce1,
      extraNonce2Size: this.extraNonce2Size,
      difficulty: this.difficulty,
      receivedAt: Date.now(),
    };

    job.merkleRoot = this._computeMerkleRoot(job);
    this.currentJob = job;
    this.logger.debug(`New job: ${jobId} | clean: ${cleanJobs}`);
    this.emit('job', job);
  }

  _computeMerkleRoot(job) {
    const crypto = require('crypto');
    const en2 = Buffer.alloc(job.extraNonce2Size).toString('hex');
    const coinbaseTx = job.coinb1 + job.extraNonce1 + en2 + job.coinb2;
    let hash = this._dsha256(Buffer.from(coinbaseTx, 'hex'));
    for (const branch of job.merkleBranches) {
      hash = this._dsha256(Buffer.concat([hash, Buffer.from(branch, 'hex')]));
    }
    return hash.toString('hex');
  }

  _dsha256(buf) {
    const crypto = require('crypto');
    return crypto.createHash('sha256')
      .update(crypto.createHash('sha256').update(buf).digest())
      .digest();
  }

  _onSetDifficulty(params) {
    if (params && params[0]) {
      this.difficulty = params[0];
      this.logger.info(`Difficulty set to ${this.difficulty}`);
      this.emit('difficulty', this.difficulty);
    }
  }

  _onSetExtranonce(params) {
    if (params && params.length >= 2) {
      this.extraNonce1 = params[0];
      this.extraNonce2Size = params[1];
      this.logger.info(`ExtraNonce updated: ${this.extraNonce1}`);
    }
  }

  async submit(jobId, extraNonce2, ntime, nonce) {
    try {
      const result = await this._send('mining.submit', [
        this.config.user, jobId, extraNonce2, ntime, nonce,
      ]);
      return result;
    } catch (err) {
      this.logger.warn('Submit error:', err.message);
      return false;
    }
  }

  _onSubmitResult(result) {
    if (result === true) {
      this.emit('accepted');
    } else {
      this.emit('rejected');
    }
  }
}

module.exports = StratumClient;
