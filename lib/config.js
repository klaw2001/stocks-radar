'use strict';

const path = require('path');
const fs   = require('fs');

// ─── Load .env ────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  });
}

// ─── Env vars ─────────────────────────────────────────────────────────────────
const PORT           = parseInt(process.env.PORT || '5000', 10);
const ADMIN_KEY      = process.env.ADMIN_KEY || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || 'results-radar-secret-change-me';
const X_BEARER_TOKEN    = process.env.X_BEARER_TOKEN || '';
const TIJORI_KEY        = process.env.TIJORI_CONCALL_MONITOR_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

// Parse USERS="alice:pass1,bob:pass2"
const USERS = Object.fromEntries(
  (process.env.USERS || '')
    .split(',')
    .map(e => e.trim().split(':'))
    .filter(p => p.length === 2 && p[0] && p[1])
);
const HAS_USERS = Object.keys(USERS).length > 0;

// ─── Polling schedule constants ───────────────────────────────────────────────
const STOCKSCANS_CRON    = '0 * * * *';   // every 1 hr
const TIJORI_CRON        = '0 * * * *';   // every 1 hr
const STOCKPRICE_CRON    = '*/10 * * * *';   // every 10 min, market-hours check inside poller
const MARKET_OPEN_HOUR   = 9;
const MARKET_CLOSE_HOUR  = 16;

module.exports = {
  PORT,
  ADMIN_KEY,
  SESSION_SECRET,
  X_BEARER_TOKEN,
  TIJORI_KEY,
  OPENROUTER_API_KEY,
  USERS,
  HAS_USERS,
  STOCKSCANS_CRON,
  TIJORI_CRON,
  STOCKPRICE_CRON,
  MARKET_OPEN_HOUR,
  MARKET_CLOSE_HOUR,
};
