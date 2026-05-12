# LTC Miner — Optimized Litecoin CPU Miner

A fully functional Litecoin (LTC) CPU miner with:
- **Stratum protocol** support (works with all major LTC pools)
- **Multi-threaded** mining via Node.js Worker Threads
- **Scrypt hashing** (Litecoin's PoW algorithm) using Node's native `crypto.scryptSync`
- **Live TUI dashboard** with hashrate chart, worker stats, share log
- **Auto-reconnect** on pool disconnect
- **Configurable** via `.env` or CLI flags

---

## Quick Start

### 1. Set your wallet address

Edit `.env`:
```
POOL_USER=YOUR_LTC_WALLET_ADDRESS.worker1
```

### 2. Choose a pool

Popular LTC pools (all use Stratum port 3333):

| Pool | Host |
|------|------|
| ViaMining | `ltc.pool.viamining.com` |
| LitecoinPool | `us.litecoinpool.org` |
| F2Pool | `ltc.f2pool.com` |
| Antpool | `stratum-ltc.antpool.com` |
| Prohashing | `prohashing.com` |

Update `.env`:
```
POOL_HOST=us.litecoinpool.org
POOL_PORT=3333
```

### 3. Run

```bash
npm start
```

---

## CLI Options

```
node src/index.js [options]

Options:
  -H, --host <host>       Pool host
  -p, --port <port>       Pool port (default: 3333)
  -u, --user <user>       Wallet address + worker name
  -P, --pass <pass>       Pool password (usually 'x')
  -t, --threads <n>       Thread count (0 = auto)
  -i, --intensity <n>     Intensity 1-10 (default: 8)
  --no-dashboard          Disable TUI, plain log output
```

### Examples

```bash
# Auto-detect threads, intensity 9
node src/index.js -u LTC_ADDRESS.rig1 -i 9

# 4 threads, specific pool
node src/index.js -H us.litecoinpool.org -u LTC_ADDRESS.worker1 -t 4

# No dashboard (useful for headless/server)
node src/index.js --no-dashboard
```

---

## Dashboard Controls

| Key | Action |
|-----|--------|
| `Q` / `Ctrl+C` | Quit |
| `R` | Reset stats |
| `Tab` | Focus next widget |
| `↑` / `↓` | Scroll focused widget |

---

## Architecture

```
src/
├── index.js              Entry point, CLI parsing
├── config.js             Default configuration
├── stratum/
│   └── StratumClient.js  Stratum protocol (subscribe/authorize/notify/submit)
├── miner/
│   ├── MinerManager.js   Orchestrates workers + stratum
│   └── MiningWorker.js   Worker thread — Scrypt hash loop
├── ui/
│   └── Dashboard.js      blessed-contrib TUI dashboard
└── utils/
    ├── HashUtils.js       Hashing helpers, target conversion
    └── Logger.js          Multi-output logger with UI hooks
```

---

## Performance Notes

- CPU mining LTC is **not profitable** vs ASIC miners — this is for learning/testing
- Each worker thread gets its own nonce range to avoid collisions
- Scrypt N=1024 r=1 p=1 matches Litecoin mainnet parameters
- Intensity setting controls how aggressively threads yield to the event loop

---

## Supported Pools

Any pool supporting **Stratum v1** protocol works. The miner handles:
- `mining.subscribe`
- `mining.authorize`  
- `mining.notify` (new jobs)
- `mining.set_difficulty`
- `mining.set_extranonce`
- `mining.submit` (share submission)
