'use strict';

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const COLORS = {
  debug: '\x1b[36m',
  info:  '\x1b[32m',
  warn:  '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
};

class Logger {
  constructor(config = {}) {
    this.level = LEVELS[config.level] ?? LEVELS.info;
    this.logFile = config.file ? path.resolve(config.file) : null;
    this.listeners = [];
    this._stream = null;

    if (this.logFile) {
      this._stream = fs.createWriteStream(this.logFile, { flags: 'a' });
    }
  }

  _log(level, ...args) {
    if (LEVELS[level] < this.level) return;

    const ts = new Date().toISOString();
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    const line = `[${ts}] [${level.toUpperCase()}] ${msg}`;
    const colored = `${COLORS[level]}[${level.toUpperCase()}]${COLORS.reset} ${msg}`;

    if (!process.env.NO_CONSOLE) {
      process.stdout.write(colored + '\n');
    }

    if (this._stream) {
      this._stream.write(line + '\n');
    }

    this.listeners.forEach(fn => fn({ level, msg, ts, line }));
  }

  debug(...args) { this._log('debug', ...args); }
  info(...args)  { this._log('info',  ...args); }
  warn(...args)  { this._log('warn',  ...args); }
  error(...args) { this._log('error', ...args); }

  onLog(fn) {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter(l => l !== fn); };
  }
}

module.exports = Logger;
