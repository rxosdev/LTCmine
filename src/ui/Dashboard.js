'use strict';

const blessed = require('blessed');
const contrib = require('blessed-contrib');
const { formatHashrate } = require('../utils/HashUtils');

class Dashboard {
  constructor(manager, config) {
    this.manager = manager;
    this.config = config;
    this.screen = null;
    this.grid = null;
    this.widgets = {};
    this._logLines = [];
    this._hashrateHistory = new Array(60).fill(0);
    this._shareHistory = [];
    this._updateTimer = null;
  }

  start() {
    this._buildScreen();
    this._bindEvents();
    this._startUpdateLoop();
    this.screen.render();
  }

  stop() {
    if (this._updateTimer) clearInterval(this._updateTimer);
    if (this.screen) this.screen.destroy();
  }

  _buildScreen() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'LTC Miner Dashboard',
      fullUnicode: true,
    });

    this.grid = new contrib.grid({ rows: 12, cols: 12, screen: this.screen });

    // ── Hashrate sparkline ────────────────────────────────────────────────────
    this.widgets.hashrate = this.grid.set(0, 0, 4, 8, contrib.line, {
      label: ' Hashrate (H/s) ',
      showLegend: true,
      legend: { width: 12 },
      style: { line: 'cyan', text: 'white', baseline: 'black' },
      xLabelPadding: 3,
      xPadding: 5,
      wholeNumbersOnly: false,
    });

    // ── Stats box ─────────────────────────────────────────────────────────────
    this.widgets.stats = this.grid.set(0, 8, 4, 4, blessed.box, {
      label: ' Mining Stats ',
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'cyan' } },
      padding: { left: 1, right: 1 },
    });

    // ── Pool info ─────────────────────────────────────────────────────────────
    this.widgets.pool = this.grid.set(4, 0, 2, 6, blessed.box, {
      label: ' Pool ',
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'yellow' } },
      padding: { left: 1 },
    });

    // ── Worker table ──────────────────────────────────────────────────────────
    this.widgets.workers = this.grid.set(4, 6, 2, 6, contrib.table, {
      label: ' Workers ',
      keys: true,
      columnSpacing: 2,
      columnWidth: [8, 14, 8],
      style: { border: { fg: 'green' } },
    });

    // ── Share log ─────────────────────────────────────────────────────────────
    this.widgets.shares = this.grid.set(6, 0, 3, 6, contrib.log, {
      label: ' Share Log ',
      tags: true,
      style: { border: { fg: 'magenta' } },
    });

    // ── Event log ─────────────────────────────────────────────────────────────
    this.widgets.log = this.grid.set(6, 6, 3, 6, contrib.log, {
      label: ' Event Log ',
      tags: true,
      style: { border: { fg: 'blue' } },
    });

    // ── Status bar ────────────────────────────────────────────────────────────
    this.widgets.status = this.grid.set(9, 0, 1, 12, blessed.box, {
      tags: true,
      style: { bg: 'blue', fg: 'white' },
    });

    // ── Help bar ──────────────────────────────────────────────────────────────
    this.widgets.help = this.grid.set(10, 0, 2, 12, blessed.box, {
      label: ' Help ',
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'white' } },
      content: '{bold}Q{/bold} Quit  {bold}R{/bold} Reset Stats  {bold}Tab{/bold} Focus  {bold}↑↓{/bold} Scroll',
    });

    // Key bindings
    this.screen.key(['q', 'Q', 'C-c'], () => process.emit('SIGINT'));
    this.screen.key(['r', 'R'], () => this._resetStats());
  }

  _bindEvents() {
    const mgr = this.manager;

    mgr.on('hashrate', (hps) => {
      this._hashrateHistory.push(hps);
      if (this._hashrateHistory.length > 60) this._hashrateHistory.shift();
      this._updateHashrateChart();
    });

    mgr.on('accepted', (count) => {
      const ts = new Date().toLocaleTimeString();
      this.widgets.shares.log(`{green-fg}[${ts}] ✓ Share ACCEPTED (total: ${count}){/green-fg}`);
      this._shareHistory.push({ ts, result: 'accepted' });
    });

    mgr.on('rejected', (count) => {
      const ts = new Date().toLocaleTimeString();
      this.widgets.shares.log(`{red-fg}[${ts}] ✗ Share REJECTED (total: ${count}){/red-fg}`);
      this._shareHistory.push({ ts, result: 'rejected' });
    });

    mgr.on('status', (status) => {
      const ts = new Date().toLocaleTimeString();
      const colorMap = {
        connected: 'cyan',
        authorized: 'green',
        disconnected: 'red',
        authFailed: 'red',
      };
      const color = colorMap[status] || 'white';
      this.widgets.log.log(`{${color}-fg}[${ts}] Status: ${status}{/${color}-fg}`);
    });

    mgr.on('job', (job) => {
      const ts = new Date().toLocaleTimeString();
      this.widgets.log.log(`{yellow-fg}[${ts}] New job: ${job.id}{/yellow-fg}`);
    });

    // Capture logger output
    this.manager.logger.onLog(({ level, msg, ts }) => {
      const colorMap = { debug: 'gray', info: 'white', warn: 'yellow', error: 'red' };
      const color = colorMap[level] || 'white';
      const time = new Date(ts).toLocaleTimeString();
      this._logLines.push(`{${color}-fg}[${time}] ${msg}{/${color}-fg}`);
      if (this._logLines.length > 200) this._logLines.shift();
    });
  }

  _startUpdateLoop() {
    this._updateTimer = setInterval(() => {
      this._updateStats();
      this._updatePool();
      this._updateWorkers();
      this._updateStatusBar();
      this.screen.render();
    }, 1000);
  }

  _updateHashrateChart() {
    const data = this._hashrateHistory;
    const labels = data.map((_, i) => String(i));
    this.widgets.hashrate.setData([
      {
        title: 'H/s',
        x: labels,
        y: data,
        style: { line: 'cyan' },
      },
    ]);
  }

  _updateStats() {
    const s = this.manager.getStats();
    const uptime = this._formatUptime(s.uptime);
    const hr = formatHashrate(s.hashrate);
    const avgHr = s.uptime > 0
      ? formatHashrate(s.totalHashes / s.uptime)
      : '0 H/s';
    const ratio = s.accepted + s.rejected > 0
      ? ((s.accepted / (s.accepted + s.rejected)) * 100).toFixed(1)
      : '100.0';
    const lastShare = s.lastShareTime
      ? Math.floor((Date.now() - s.lastShareTime) / 1000) + 's ago'
      : 'never';

    this.widgets.stats.setContent(
      `{bold}{cyan-fg}Hashrate:{/cyan-fg}{/bold}  ${hr}\n` +
      `{bold}{cyan-fg}Avg Rate:{/cyan-fg}{/bold}  ${avgHr}\n` +
      `{bold}{green-fg}Accepted:{/green-fg}{/bold}  ${s.accepted}\n` +
      `{bold}{red-fg}Rejected:{/red-fg}{/bold}  ${s.rejected}\n` +
      `{bold}Ratio:{/bold}     ${ratio}%\n` +
      `{bold}Diff:{/bold}      ${s.difficulty}\n` +
      `{bold}Uptime:{/bold}    ${uptime}\n` +
      `{bold}Last Share:{/bold} ${lastShare}\n` +
      `{bold}Total H:{/bold}   ${this._formatBigNum(s.totalHashes)}`
    );
  }

  _updatePool() {
    const cfg = this.config.pool;
    const workerDefs = cfg.workers || [{ user: cfg.user }];
    const clients = this.manager.stratumClients || [];

    let lines = '';
    for (let i = 0; i < workerDefs.length; i++) {
      const client = clients[i];
      const connected = client && client.connected;
      const auth = client && client.authorized;
      const color = connected ? (auth ? 'green' : 'yellow') : 'red';
      const status = connected ? (auth ? 'AUTH' : 'CONN') : 'DOWN';
      lines += `{bold}${workerDefs[i].user}{/bold}  {${color}-fg}[${status}]{/${color}-fg}\n`;
    }

    this.widgets.pool.setContent(
      `{bold}Host:{/bold} ${cfg.host}:${cfg.port}\n` + lines
    );
  }

  _updateWorkers() {
    const s = this.manager.getStats();
    const headers = ['Worker', 'Hashrate', 'Active'];
    const data = s.workerHashrates.map((hr, i) => [
      `  #${i}`,
      `  ${formatHashrate(hr)}`,
      `  ${this.manager.workers[i]?.active ? '{green-fg}YES{/green-fg}' : '{red-fg}NO{/red-fg}'}`,
    ]);

    this.widgets.workers.setData({ headers, data });
  }

  _updateStatusBar() {
    const s = this.manager.getStats();
    const hr = formatHashrate(s.hashrate);
    const clients = this.manager.stratumClients || [];
    const anyConnected = clients.some(c => c && c.connected);
    const anyAuthed = clients.some(c => c && c.authorized);
    const connStr = anyAuthed
      ? '{green-fg}● AUTHORIZED{/green-fg}'
      : anyConnected
        ? '{yellow-fg}● CONNECTED{/yellow-fg}'
        : '{red-fg}● DISCONNECTED{/red-fg}';
    this.widgets.status.setContent(
      ` ${connStr}  {bold}Hashrate:{/bold} ${hr}  ` +
      `{bold}Accepted:{/bold} {green-fg}${s.accepted}{/green-fg}  ` +
      `{bold}Rejected:{/bold} {red-fg}${s.rejected}{/red-fg}  ` +
      `{bold}Diff:{/bold} ${s.difficulty}  ` +
      `{bold}Threads:{/bold} ${this.config.mining.threads}`
    );
  }

  _resetStats() {
    const s = this.manager.stats;
    s.accepted = 0;
    s.rejected = 0;
    s.totalHashes = 0;
    s.startTime = Date.now();
    s.lastShareTime = null;
    this._hashrateHistory = new Array(60).fill(0);
    this._shareHistory = [];
    this.widgets.shares.log('{yellow-fg}Stats reset{/yellow-fg}');
  }

  _formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  _formatBigNum(n) {
    if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (n >= 1e9)  return (n / 1e9).toFixed(2) + 'G';
    if (n >= 1e6)  return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3)  return (n / 1e3).toFixed(2) + 'K';
    return String(n);
  }
}

module.exports = Dashboard;
