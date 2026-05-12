'use strict';

const { parentPort } = require('worker_threads');
const crypto = require('crypto');

function scryptHash(header) {
  return crypto.scryptSync(header, header, 32, {
    N: 1024,
    r: 1,
    p: 1,
    maxmem: 128 * 1024 * 2,
  });
}

function buildHeader(job, nonce, extraNonce2) {
  const buf = Buffer.allocUnsafe(80);
  let offset = 0;

  buf.writeUInt32LE(job.version >>> 0, offset); offset += 4;
  Buffer.from(job.prevhash, 'hex').copy(buf, offset); offset += 32;

  const merkleRoot = computeMerkleRoot(job, extraNonce2);
  Buffer.from(merkleRoot, 'hex').copy(buf, offset); offset += 32;

  buf.writeUInt32LE(parseInt(job.ntime, 16) >>> 0, offset); offset += 4;
  buf.writeUInt32LE(parseInt(job.nbits, 16) >>> 0, offset); offset += 4;
  buf.writeUInt32LE(nonce >>> 0, offset);

  return buf;
}

function computeMerkleRoot(job, extraNonce2) {
  const coinbaseTx = job.coinb1 + job.extraNonce1 + extraNonce2 + job.coinb2;
  let hash = dsha256(Buffer.from(coinbaseTx, 'hex'));
  for (const branch of job.merkleBranches) {
    hash = dsha256(Buffer.concat([hash, Buffer.from(branch, 'hex')]));
  }
  return hash.toString('hex');
}

function dsha256(buf) {
  return crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(buf).digest())
    .digest();
}

function meetsTarget(hashBuf, targetBuf) {
  for (let i = 31; i >= 0; i--) {
    if (hashBuf[i] < targetBuf[i]) return true;
    if (hashBuf[i] > targetBuf[i]) return false;
  }
  return true;
}

let running = false;
let currentJob = null;
let currentTarget = null;
let startNonce = 0;
let nonceRange = 0xFFFFFFFF;
let currentExtraNonce2 = '00000000';

parentPort.on('message', (msg) => {
  switch (msg.type) {
    case 'job':
      currentJob = msg.job;
      currentTarget = Buffer.from(msg.target, 'hex');
      startNonce = msg.startNonce || 0;
      nonceRange = msg.nonceRange || 0xFFFFFFFF;
      currentExtraNonce2 = msg.extraNonce2 || '00000000';
      running = true;
      setImmediate(mineLoop);
      break;
    case 'stop':
      running = false;
      break;
  }
});

function mineLoop() {
  if (!running || !currentJob) {
    parentPort.postMessage({ type: 'idle' });
    return;
  }

  const job = currentJob;
  const target = currentTarget;
  const extraNonce2 = currentExtraNonce2;
  let nonce = startNonce;
  const end = (startNonce + nonceRange) >>> 0;
  let hashes = 0;
  let lastReport = Date.now();

  while (running && currentJob === job) {
    const header = buildHeader(job, nonce, extraNonce2);
    const hash = scryptHash(header);
    hashes++;

    if (meetsTarget(hash, target)) {
      parentPort.postMessage({
        type: 'found',
        nonce: nonce.toString(16).padStart(8, '0'),
        extraNonce2,
        ntime: job.ntime,
        jobId: job.id,
        hash: hash.toString('hex'),
      });
    }

    const now = Date.now();
    if (now - lastReport >= 5000) {
      parentPort.postMessage({ type: 'hashrate', hashes });
      hashes = 0;
      lastReport = now;
    }

    nonce = (nonce + 1) >>> 0;

    if (nonce === end || nonce === 0) {
      parentPort.postMessage({ type: 'nonceExhausted' });
      running = false;
      break;
    }
  }

  if (running && currentJob === job) {
    setImmediate(mineLoop);
  } else {
    parentPort.postMessage({ type: 'idle' });
  }
}
