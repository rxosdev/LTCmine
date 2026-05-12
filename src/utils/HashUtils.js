'use strict';

const crypto = require('crypto');

function sha256d(data) {
  return crypto.createHash('sha256')
    .update(crypto.createHash('sha256').update(data).digest())
    .digest();
}

function reverseHex(hex) {
  return Buffer.from(hex, 'hex').reverse().toString('hex');
}

function packUInt32LE(n) {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32LE(n >>> 0, 0);
  return buf;
}

function packUInt32BE(n) {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32BE(n >>> 0, 0);
  return buf;
}

function diffToTarget(diff) {
  const diff1 = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
  const target = diff1 / BigInt(Math.floor(diff * 65536)) * BigInt(65536);
  const hex = target.toString(16).padStart(64, '0');
  return Buffer.from(hex, 'hex');
}

function meetsTarget(hashBuf, targetBuf) {
  for (let i = 0; i < 32; i++) {
    if (hashBuf[i] < targetBuf[i]) return true;
    if (hashBuf[i] > targetBuf[i]) return false;
  }
  return true;
}

function formatHashrate(hps) {
  if (hps >= 1e9) return (hps / 1e9).toFixed(2) + ' GH/s';
  if (hps >= 1e6) return (hps / 1e6).toFixed(2) + ' MH/s';
  if (hps >= 1e3) return (hps / 1e3).toFixed(2) + ' KH/s';
  return hps.toFixed(2) + ' H/s';
}

function buildHeader(job, nonce) {
  const buf = Buffer.allocUnsafe(80);
  let offset = 0;

  buf.writeUInt32LE(job.version, offset); offset += 4;
  Buffer.from(job.prevhash, 'hex').copy(buf, offset); offset += 32;
  Buffer.from(job.merkleRoot, 'hex').copy(buf, offset); offset += 32;
  buf.writeUInt32LE(parseInt(job.ntime, 16), offset); offset += 4;
  buf.writeUInt32LE(parseInt(job.nbits, 16), offset); offset += 4;
  buf.writeUInt32LE(nonce >>> 0, offset);

  return buf;
}

module.exports = {
  sha256d,
  reverseHex,
  packUInt32LE,
  packUInt32BE,
  diffToTarget,
  meetsTarget,
  formatHashrate,
  buildHeader,
};
