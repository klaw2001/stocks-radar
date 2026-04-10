'use strict';

// ─── Dependencies ────────────────────────────────────────────────────────────
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// Load .env if present
const envPath = path.join(__dirname, '.env');
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

const express = require('express');
const session = require('express-session');
const Database = require('better-sqlite3');
const puppeteer = require('puppeteer');

// ─── Logger ───────────────────────────────────────────────────────────────────
const logStream = fs.createWriteStream(path.join(__dirname, 'concall_monitor.log'), { flags: 'a' });

function log(tag, msg, ...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = args.length ? `[${ts}] [${tag}] ${msg} ${args.join(' ')}` : `[${ts}] [${tag}] ${msg}`;
  console.log(line);
  logStream.write(line + '\n');
}
function logErr(tag, msg, ...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = args.length ? `[${ts}] [${tag}] ❌ ${msg} ${args.join(' ')}` : `[${ts}] [${tag}] ❌ ${msg}`;
  console.error(line);
  logStream.write(line + '\n');
}

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '5000', 10);
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin';
const SESSION_SECRET = process.env.SESSION_SECRET || 'results-radar-secret-change-me';
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || '';
const TIJORI_KEY = process.env.TIJORI_CONCALL_MONITOR_API_KEY || '';
// tijoristack.ai uses raw key in Authorization header (no "Bearer" prefix)

// Parse USERS="alice:pass1,bob:pass2"
const USERS = Object.fromEntries(
  (process.env.USERS || '')
    .split(',')
    .map(e => e.trim().split(':'))
    .filter(p => p.length === 2 && p[0] && p[1])
);
const HAS_USERS = Object.keys(USERS).length > 0;

// ─── Startup Config Summary ───────────────────────────────────────────────────
log('config', `PORT=${PORT}`);
log('config', `ADMIN_KEY=${ADMIN_KEY ? '****' + ADMIN_KEY.slice(-4) : '(default: admin)'}`);
log('config', `X_BEARER_TOKEN=${X_BEARER_TOKEN ? '✓ set' : '✗ not set — mock sentiment mode'}`);
log('config', `TIJORI_KEY=${TIJORI_KEY ? '✓ set (' + TIJORI_KEY.slice(0, 6) + '…)' : '✗ not set — mock transcript mode'}`);
log('config', `USERS=${HAS_USERS ? Object.keys(USERS).join(', ') : '(none — dashboard is public)'}`);

// Debug: stores last StockScans API capture for inspection
let lastPollCapture = [];

// Polling intervals
const STOCKSCANS_INTERVAL_MS = 10 * 60 * 1000;  // 10 min
const TIJORI_INTERVAL_MS = 30 * 60 * 1000;       // 30 min
const MARKET_OPEN_HOUR = 9;
const MARKET_CLOSE_HOUR = 16;

// ─── Database ─────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'results_radar.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
log('db', `SQLite opened: ${DB_PATH}`);

db.exec(`
  CREATE TABLE IF NOT EXISTS result_events (
    event_id TEXT PRIMARY KEY,
    company_name TEXT NOT NULL,
    result_date TEXT NOT NULL,
    screener_url TEXT,
    pdf_url TEXT,
    price REAL,
    market_cap REAL,
    pe REAL,
    sales_yoy REAL,
    sales_current REAL,
    ebitda_yoy REAL,
    ebitda_current REAL,
    pat_yoy REAL,
    pat_current REAL,
    eps_yoy REAL,
    eps_current REAL,
    chatter_sentiment TEXT DEFAULT 'neutral',
    chatter_summary TEXT,
    top_post_links TEXT,
    transcript_status TEXT DEFAULT 'pending',
    transcript_url TEXT,
    transcript_summary_url TEXT,
    transcript_summary_text TEXT,
    audio_url TEXT,
    is_read INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS polling_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    poll_time TEXT,
    status TEXT,
    notes TEXT
  );
`);

// Migrate: add audio_url column if missing
const cols = db.prepare("PRAGMA table_info(result_events)").all().map(c => c.name);
if (!cols.includes('audio_url')) {
  db.exec("ALTER TABLE result_events ADD COLUMN audio_url TEXT");
  log('db', 'Migrated: added audio_url column');
}


const dbCount = db.prepare('SELECT COUNT(*) as c FROM result_events').get().c;
log('db', `Tables ready. ${dbCount} existing events in DB.`);

// ─── DB Helpers ───────────────────────────────────────────────────────────────
const stmts = {
  getById: db.prepare('SELECT * FROM result_events WHERE event_id = ?'),
  upsert: db.prepare(`
    INSERT INTO result_events (
      event_id, company_name, result_date, screener_url, pdf_url,
      price, market_cap, pe, sales_yoy, sales_current,
      ebitda_yoy, ebitda_current, pat_yoy, pat_current,
      eps_yoy, eps_current, chatter_sentiment, chatter_summary,
      top_post_links, transcript_status, transcript_url,
      transcript_summary_url, transcript_summary_text, audio_url,
      is_read, created_at, updated_at
    ) VALUES (
      @event_id, @company_name, @result_date, @screener_url, @pdf_url,
      @price, @market_cap, @pe, @sales_yoy, @sales_current,
      @ebitda_yoy, @ebitda_current, @pat_yoy, @pat_current,
      @eps_yoy, @eps_current, @chatter_sentiment, @chatter_summary,
      @top_post_links, @transcript_status, @transcript_url,
      @transcript_summary_url, @transcript_summary_text, @audio_url,
      @is_read, @created_at, @updated_at
    )
    ON CONFLICT(event_id) DO UPDATE SET
      company_name = excluded.company_name,
      screener_url = COALESCE(excluded.screener_url, screener_url),
      pdf_url = COALESCE(excluded.pdf_url, pdf_url),
      price = COALESCE(excluded.price, price),
      market_cap = COALESCE(excluded.market_cap, market_cap),
      pe = COALESCE(excluded.pe, pe),
      sales_yoy = COALESCE(excluded.sales_yoy, sales_yoy),
      sales_current = COALESCE(excluded.sales_current, sales_current),
      ebitda_yoy = COALESCE(excluded.ebitda_yoy, ebitda_yoy),
      ebitda_current = COALESCE(excluded.ebitda_current, ebitda_current),
      pat_yoy = COALESCE(excluded.pat_yoy, pat_yoy),
      pat_current = COALESCE(excluded.pat_current, pat_current),
      eps_yoy = COALESCE(excluded.eps_yoy, eps_yoy),
      eps_current = COALESCE(excluded.eps_current, eps_current),
      chatter_sentiment = COALESCE(excluded.chatter_sentiment, chatter_sentiment),
      chatter_summary = COALESCE(excluded.chatter_summary, chatter_summary),
      top_post_links = COALESCE(excluded.top_post_links, top_post_links),
      transcript_status = COALESCE(excluded.transcript_status, transcript_status),
      transcript_url = COALESCE(excluded.transcript_url, transcript_url),
      transcript_summary_url = COALESCE(excluded.transcript_summary_url, transcript_summary_url),
      transcript_summary_text = COALESCE(excluded.transcript_summary_text, transcript_summary_text),
      audio_url = COALESCE(excluded.audio_url, audio_url),
      is_read = excluded.is_read,
      updated_at = excluded.updated_at
  `),
  addLog: db.prepare(
    'INSERT INTO polling_logs (source, poll_time, status, notes) VALUES (@source, @poll_time, @status, @notes)'
  ),
  getLogs: db.prepare('SELECT * FROM polling_logs ORDER BY id DESC LIMIT 100'),
};

function getEventById(id) {
  return stmts.getById.get(id) || null;
}

function upsertEvent(evt) {
  const now = new Date().toISOString();
  stmts.upsert.run({
    event_id: evt.event_id,
    company_name: evt.company_name,
    result_date: evt.result_date,
    screener_url: evt.screener_url || null,
    pdf_url: evt.pdf_url || null,
    price: evt.price ?? null,
    market_cap: evt.market_cap ?? null,
    pe: evt.pe ?? null,
    sales_yoy: evt.sales_yoy ?? null,
    sales_current: evt.sales_current ?? null,
    ebitda_yoy: evt.ebitda_yoy ?? null,
    ebitda_current: evt.ebitda_current ?? null,
    pat_yoy: evt.pat_yoy ?? null,
    pat_current: evt.pat_current ?? null,
    eps_yoy: evt.eps_yoy ?? null,
    eps_current: evt.eps_current ?? null,
    chatter_sentiment: evt.chatter_sentiment || 'neutral',
    chatter_summary: evt.chatter_summary || null,
    top_post_links: evt.top_post_links || null,
    transcript_status: evt.transcript_status || 'pending',
    transcript_url: evt.transcript_url || null,
    transcript_summary_url: evt.transcript_summary_url || null,
    transcript_summary_text: evt.transcript_summary_text || null,
    audio_url: evt.audio_url || null,
    is_read: evt.is_read ? 1 : 0,
    created_at: evt.created_at || now,
    updated_at: now,
  });
}

function addPollingLog(entry) {
  stmts.addLog.run({
    source: entry.source,
    poll_time: entry.poll_time,
    status: entry.status,
    notes: entry.notes || null,
  });
}

function getAllEvents(filters = {}) {
  let sql = 'SELECT * FROM result_events WHERE 1=1';
  const params = [];
  if (filters.search) {
    sql += ' AND company_name LIKE ?';
    params.push(`%${filters.search}%`);
  }
  if (filters.sentiment) {
    sql += ' AND chatter_sentiment = ?';
    params.push(filters.sentiment);
  }
  if (filters.transcript_status) {
    sql += ' AND transcript_status = ?';
    params.push(filters.transcript_status);
  }
  if (filters.is_read !== undefined) {
    sql += ' AND is_read = ?';
    params.push(filters.is_read ? 1 : 0);
  }
  sql += ' ORDER BY result_date DESC, company_name ASC';
  return db.prepare(sql).all(...params);
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function makeEventId(companyName, date, extra) {
  const raw = `${companyName}-${date}-${extra || ''}`;
  return crypto.createHash('md5').update(raw).digest('hex').slice(0, 12);
}

function toFloat(val) {
  if (val === null || val === undefined) return null;
  const n = parseFloat(String(val).replace(/[, ₹%]/g, ''));
  return isNaN(n) ? null : n;
}

function isMarketHours() {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istHour = new Date(Date.now() + istOffsetMs).getUTCHours();
  return istHour >= MARKET_OPEN_HOUR && istHour < MARKET_CLOSE_HOUR;
}

// ─── StockScans Poller ────────────────────────────────────────────────────────
/**
 * Launches Puppeteer, navigates to StockScans result-scans page, and intercepts
 * the internal XHR/fetch responses to capture the JSON data the SPA loads.
 * Falls back to DOM scraping if no JSON is captured.
 */
async function pollStockScans() {
  // Market hours check disabled — polls anytime
  // if (!isMarketHours()) { log('stockscans', 'Outside market hours, skipping.'); return; }

  const pollTime = new Date().toISOString();
  const today = new Date().toISOString().slice(0, 10);
  let browser;

  log('stockscans', '⏳ Starting poll…');

  try {
    log('stockscans', 'Launching browser…');
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Collect all JSON API responses from the page
    const capturedResponses = [];
    page.on('response', async response => {
      const url = response.url();
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      // Filter for likely result/scan data endpoints
      if (
        url.includes('result') ||
        url.includes('scan') ||
        url.includes('earning') ||
        url.includes('stock')
      ) {
        try {
          const json = await response.json();
          capturedResponses.push({ url, json });
        } catch {
          // not JSON or body already consumed
        }
      }
    });

    log('stockscans', 'Navigating to stockscans.in/result-scans…');
    await page.goto('https://www.stockscans.in/result-scans', {
      waitUntil: 'networkidle2',
      timeout: 45000,
    });
    log('stockscans', 'Page loaded. Waiting for SPA data…');

    // Give SPA a moment to finish rendering after network idle
    await new Promise(r => setTimeout(r, 3000));

    // Try to capture any remaining async data
    await page.waitForTimeout?.(1000).catch(() => {});

    // ── Parse captured JSON responses ──────────────────────────────────────
    let rows = [];

    // Find the largest array anywhere in a JSON object (recursive)
    function findBestArray(obj, depth = 0) {
      if (Array.isArray(obj)) return obj;
      if (!obj || typeof obj !== 'object' || depth > 4) return null;
      let best = null;
      for (const val of Object.values(obj)) {
        const arr = findBestArray(val, depth + 1);
        if (arr && (!best || arr.length > best.length)) best = arr;
      }
      return best;
    }

    // Prefer the results/scan endpoint, then fall back to others
    const sorted = [...capturedResponses].sort((a, b) => {
      const score = u => (u.includes('results/scan') ? 2 : u.includes('scan') ? 1 : 0);
      return score(b.url) - score(a.url);
    });

    log('stockscans', `Captured ${capturedResponses.length} JSON response(s). Parsing…`);
    for (const { url, json } of sorted) {
      const shape = Array.isArray(json)
        ? `Array[${json.length}]`
        : `Object{${Object.keys(json || {}).join(', ')}}`;
      log('stockscans', `  ${url.replace('https://www.stockscans.in', '')} → ${shape}`);

      const candidates = findBestArray(json);
      if (candidates && candidates.length > 0) {
        rows = candidates;
        log('stockscans', `✓ Using ${rows.length} rows from ${url.replace('https://www.stockscans.in', '')}`);
        if (rows[0] && typeof rows[0] === 'object') {
          log('stockscans', `  Row keys: ${Object.keys(rows[0]).join(', ')}`);
          for (const [k, v] of Object.entries(rows[0])) {
            if (v && typeof v === 'object') {
              const shape = Array.isArray(v)
                ? `Array[${v.length}] first=${JSON.stringify(v[0]).slice(0, 120)}`
                : `Object{${Object.keys(v).join(', ')}} = ${JSON.stringify(v).slice(0, 200)}`;
              log('stockscans', `    .${k}: ${shape}`);
            } else {
              log('stockscans', `    .${k}: ${v}`);
            }
          }
        }
        break;
      }
    }

    // Save raw captured data for /api/debug/last-poll
    lastPollCapture = sorted.map(({ url, json }) => ({ url, json }));

    // ── DOM fallback: scrape rendered table if no JSON captured ───────────
    if (rows.length === 0) {
      log('stockscans', '⚠ No usable JSON captured — falling back to DOM scrape.');
      rows = await page.evaluate(() => {
        const results = [];
        // Try various table selectors
        const tables = document.querySelectorAll('table');
        for (const table of tables) {
          const trs = table.querySelectorAll('tbody tr, tr');
          trs.forEach(tr => {
            const tds = tr.querySelectorAll('td');
            if (tds.length < 2) return;
            const cells = Array.from(tds).map(td => td.innerText.trim());
            // Company name is usually in the first cell with text
            const companyCell = cells.find(c => c && c.length > 2 && isNaN(parseFloat(c)));
            if (companyCell) results.push({ _dom: true, cells, company: companyCell });
          });
        }

        // Also try common card/list patterns
        const cards = document.querySelectorAll(
          '[class*="result"], [class*="company"], [class*="stock"], [class*="row"]'
        );
        cards.forEach(card => {
          const text = card.innerText?.trim();
          if (text && text.length > 3) {
            const nameEl = card.querySelector('[class*="name"], [class*="company"], h3, h4, strong');
            if (nameEl) results.push({ _dom: true, cells: [], company: nameEl.innerText.trim() });
          }
        });

        return results;
      });
    }

    await browser.close();
    browser = null;

    // ── Normalize rows → DB events ─────────────────────────────────────────
    log('stockscans', `Normalizing ${rows.length} raw rows…`);
    const normalized = normalizeStockScansRows(rows, today);
    log('stockscans', `  → ${normalized.length} valid companies after normalization`);
    let newCount = 0;

    for (const evt of normalized) {
      if (!getEventById(evt.event_id)) {
        upsertEvent(evt);
        newCount++;
        log('stockscans', `  + NEW: ${evt.company_name} (${evt.result_date})`);
        pollTwitterSentiment(evt.event_id, evt.company_name).catch(err =>
          logErr('twitter', `Failed for ${evt.company_name}: ${err.message}`)
        );
      }
    }

    addPollingLog({
      source: 'stockscans',
      poll_time: pollTime,
      status: 'ok',
      notes: `Parsed ${normalized.length} rows, ${newCount} new.`,
    });
    log('stockscans', `✅ Poll done. ${normalized.length} total, ${newCount} new.`);
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    addPollingLog({ source: 'stockscans', poll_time: pollTime, status: 'error', notes: err.message });
    logErr('stockscans', `Poll failed: ${err.message}`);
  }
}

/**
 * Normalize raw StockScans API rows or DOM-scraped rows into result_events shape.
 *
 * StockScans API row structure (from /api/company/results/scan):
 *   { companyId, metaRatios, resultTable, documents }
 *
 * metaRatios — object with company name + price/mcap/pe
 * resultTable — array of metric rows: [{ label, curr, prev, yoy }, ...]
 *               OR object keyed by metric name
 * documents   — array of { type, url } for PDFs etc.
 */
function normalizeStockScansRows(rows, today) {
  const results = [];

  for (const row of rows) {
    // ── StockScans JSON API path ───────────────────────────────────────────
    if (!row._dom) {
      const meta = row.metaRatios || {};
      const rtRaw = row.resultTable || {};
      const docs = Array.isArray(row.documents) ? row.documents : [];

      // ── Company name ──────────────────────────────────────────────────
      const company =
        meta.companyName || meta.company_name || meta.name ||
        meta.Company || meta['Company Name'] ||
        row.company_name || row.companyName || row.name ||
        (row.companyId ? String(row.companyId) : null);
      if (!company) continue;

      // ── Result date ───────────────────────────────────────────────────
      const resultDate = (
        meta.resultDate || meta.result_date || meta.date ||
        row.resultDate || row.result_date || today
      ).slice(0, 10);

      // ── PDF / source URL ──────────────────────────────────────────────
      const pdfDoc = docs.find(d => (d.type || '').toLowerCase().includes('result') ||
                                    (d.url || '').toLowerCase().includes('.pdf'));
      const pdfUrl = pdfDoc?.url || null;
      const sourceUrl = `https://www.stockscans.in/result-scans`;

      // ── Financial metrics from resultTable ────────────────────────────
      // resultTable can be an array: [{label, curr, prev, yoy_pct}, ...]
      // or an object: { Revenue: {curr, prev, chg}, ... }
      let rt = {};
      if (Array.isArray(rtRaw)) {
        for (const entry of rtRaw) {
          const key = (entry.label || entry.metric || entry.name || entry.key || '').toLowerCase();
          rt[key] = entry;
        }
      } else if (typeof rtRaw === 'object') {
        for (const [k, v] of Object.entries(rtRaw)) {
          rt[k.toLowerCase()] = v;
        }
      }

      // Helper: get current value from a metric entry
      const curr = (entry) => {
        if (!entry) return null;
        return toFloat(entry.curr ?? entry.current ?? entry.value ?? entry.q_curr ?? entry.ttm);
      };
      // Helper: get YoY % from a metric entry
      const yoy = (entry) => {
        if (!entry) return null;
        return toFloat(entry.yoy_pct ?? entry.yoy ?? entry.chg ?? entry.change ?? entry.growth);
      };

      // Find metric entry by trying multiple label variants
      const find = (...keys) => {
        for (const k of keys) {
          const entry = rt[k] || rt[k.toLowerCase()];
          if (entry !== undefined) return entry;
        }
        // Also search by partial match
        for (const [k, v] of Object.entries(rt)) {
          for (const key of keys) {
            if (k.includes(key.toLowerCase())) return v;
          }
        }
        return null;
      };

      const salesEntry   = find('revenue', 'sales', 'net sales', 'total revenue', 'net revenue');
      const ebitdaEntry  = find('ebitda', 'operating profit', 'op profit', 'ebidta');
      const patEntry     = find('pat', 'net profit', 'profit after tax', 'net income');
      const epsEntry     = find('eps', 'earnings per share');

      // ── metaRatios fallbacks for price/mcap/pe ────────────────────────
      const price    = toFloat(meta.cmp ?? meta.price ?? meta.ltp ?? meta.CMP);
      const mcap     = toFloat(meta.marketCap ?? meta.market_cap ?? meta.mcap ?? meta['Mkt Cap']);
      const pe       = toFloat(meta.pe ?? meta.PE ?? meta.pe_ratio ?? meta['P/E']);

      const eventId = makeEventId(company, resultDate, row.companyId || '');

      results.push({
        event_id: eventId,
        company_name: String(company).trim(),
        result_date: resultDate,
        screener_url: sourceUrl,
        pdf_url: pdfUrl,
        price,
        market_cap: mcap,
        pe,
        sales_yoy:     yoy(salesEntry),
        sales_current: curr(salesEntry),
        ebitda_yoy:    yoy(ebitdaEntry),
        ebitda_current:curr(ebitdaEntry),
        pat_yoy:       yoy(patEntry),
        pat_current:   curr(patEntry),
        eps_yoy:       yoy(epsEntry),
        eps_current:   curr(epsEntry),
        chatter_sentiment: 'neutral',
        chatter_summary: null,
        top_post_links: null,
        transcript_status: 'pending',
        transcript_url: null,
        transcript_summary_url: null,
        transcript_summary_text: null,
        is_read: false,
        created_at: new Date().toISOString(),
      });
    } else {
      // ── DOM fallback path ────────────────────────────────────────────────
      const company = row.company;
      if (!company || company.length < 2) continue;
      const eventId = makeEventId(company, today, '');

      // Try to extract numbers from cells array
      const nums = (row.cells || [])
        .map(c => toFloat(c))
        .filter(n => n !== null);

      results.push({
        event_id: eventId,
        company_name: company.trim(),
        result_date: today,
        screener_url: null,
        pdf_url: null,
        price: nums[0] ?? null,
        market_cap: nums[1] ?? null,
        pe: nums[2] ?? null,
        sales_yoy: nums[3] ?? null,
        sales_current: nums[4] ?? null,
        ebitda_yoy: nums[5] ?? null,
        ebitda_current: nums[6] ?? null,
        pat_yoy: nums[7] ?? null,
        pat_current: nums[8] ?? null,
        eps_yoy: nums[9] ?? null,
        eps_current: nums[10] ?? null,
        chatter_sentiment: 'neutral',
        chatter_summary: null,
        top_post_links: null,
        transcript_status: 'pending',
        transcript_url: null,
        transcript_summary_url: null,
        transcript_summary_text: null,
        is_read: false,
        created_at: new Date().toISOString(),
      });
    }
  }

  return results;
}

// ─── Twitter/X Sentiment Poller ───────────────────────────────────────────────
const POSITIVE_KEYWORDS = ['beat', 'strong', 'bullish', 'buy', 'outperform', 'raise', 'upgrade', 'record', 'surge'];
const NEGATIVE_KEYWORDS = ['miss', 'weak', 'bearish', 'sell', 'downgrade', 'cut', 'concern', 'disappoint', 'fall'];

async function pollTwitterSentiment(eventId, companyName) {
  const pollTime = new Date().toISOString();

  if (!X_BEARER_TOKEN) {
    const sentiments = ['good', 'neutral', 'bad'];
    const sentiment = sentiments[Math.floor(Math.random() * sentiments.length)];
    const evt = getEventById(eventId);
    if (!evt) return;
    upsertEvent({
      ...evt,
      chatter_sentiment: sentiment,
      chatter_summary: `[Mock] Simulated ${sentiment} sentiment for ${companyName}.`,
      top_post_links: null,
    });
    log('twitter', `[mock] ${companyName} → ${sentiment}`);
    return;
  }

  log('twitter', `Searching tweets for "${companyName}"…`);
  try {
    const query = encodeURIComponent(`${companyName} results -is:retweet lang:en`);
    const resp = await fetch(
      `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=10&tweet.fields=text,public_metrics`,
      { headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` } }
    );

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      logErr('twitter', `X API ${resp.status} for "${companyName}": ${body.slice(0, 200)}`);
      addPollingLog({ source: 'twitter', poll_time: pollTime, status: 'error', notes: `X API ${resp.status} for ${companyName}: ${body.slice(0, 200)}` });
      return;
    }

    const data = await resp.json();
    const tweets = data.data || [];
    let pos = 0, neg = 0;
    const postLinks = [];

    for (const tweet of tweets) {
      const text = tweet.text.toLowerCase();
      POSITIVE_KEYWORDS.forEach(k => { if (text.includes(k)) pos++; });
      NEGATIVE_KEYWORDS.forEach(k => { if (text.includes(k)) neg++; });
      if (tweet.id) postLinks.push(`https://twitter.com/i/web/status/${tweet.id}`);
    }

    const sentiment = pos > neg ? 'good' : neg > pos ? 'bad' : 'neutral';
    const summary = tweets.length === 0
      ? 'No recent chatter found.'
      : `${tweets.length} posts found. ${pos} positive signals, ${neg} negative signals.`;

    log('twitter', `✓ "${companyName}" → ${sentiment} (${tweets.length} tweets, +${pos}/-${neg})`);

    const evt = getEventById(eventId);
    if (!evt) return;
    upsertEvent({ ...evt, chatter_sentiment: sentiment, chatter_summary: summary, top_post_links: JSON.stringify(postLinks.slice(0, 3)) });
    addPollingLog({ source: 'twitter', poll_time: pollTime, status: 'ok', notes: `${companyName}: ${sentiment} (${tweets.length} tweets)` });
  } catch (err) {
    logErr('twitter', `"${companyName}": ${err.message}`);
    addPollingLog({ source: 'twitter', poll_time: pollTime, status: 'error', notes: `${companyName}: ${err.message}` });
  }
}

// ─── Tijori Finance Poller ────────────────────────────────────────────────────
/**
 * Fetch all recent concalls from tijoristack.ai in one paginated call,
 * then match against our pending events by company name.
 *
 * Uses Puppeteer to bypass Cloudflare bot protection on tijoristack.ai.
 * API docs: https://www.tijoristack.ai/api/v1/  (swagger at /concalls/list)
 * Auth:     Authorization: <raw_key>  (no Bearer prefix)
 */
async function fetchTijoriConcalls() {
  let browser;
  try {
    log('tijori', 'Launching browser to bypass Cloudflare…');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    const page = await browser.newPage();

    log('tijori', 'Loading tijoristack.ai (Cloudflare handshake)…');
    await page.goto('https://www.tijoristack.ai', { waitUntil: 'networkidle2', timeout: 30000 });
    log('tijori', 'Cloudflare cleared. Calling /api/v1/concalls/list…');

    const result = await page.evaluate(async (key) => {
      try {
        const resp = await fetch('/api/v1/concalls/list?page=1&mcap=all&upcoming=false&page_size=100', {
          headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' },
        });
        console.dir(resp , {depth: null})
        const text = await resp.text();
        return { status: resp.status, body: text };
      } catch (e) {
        return { error: e.message };
      }
    }, TIJORI_KEY);

    await browser.close();
    browser = null;

    if (result.error) throw new Error(result.error);

    log('tijori', `API response: HTTP ${result.status}`);
    fs.writeFileSync(
      path.join(__dirname, 'concall_api_response.txt'),
      `[${new Date().toISOString()}] HTTP ${result.status}\n\n${result.body}\n`,
      'utf8'
    );
    if (result.status !== 200) {
      logErr('tijori', `Non-200 response: ${result.body.slice(0, 300)}`);
      return [];
    }

    const json = JSON.parse(result.body);
    const data = json?.data || [];
    log('tijori', `✓ Got ${data.length} concalls from API.`);
    return data;
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw err;
  }
}

async function pollTijori() {
  const pollTime = new Date().toISOString();
  const pending = getAllEvents({ transcript_status: 'pending' });

  // Also pick up 'available' rows that don't yet have a direct PDF URL — these
  // were stored with the old website-page URL and need the recording.transcript_pdf.
  const needsRefresh = db.prepare(`
    SELECT * FROM result_events
    WHERE transcript_status = 'available'
      AND (transcript_url IS NULL OR transcript_url NOT LIKE '%.pdf')
  `).all();

  const toProcess = [...pending, ...needsRefresh];

  log('tijori', `⏳ Starting poll. ${pending.length} pending + ${needsRefresh.length} needing URL refresh.`);
  if (toProcess.length === 0) {
    log('tijori', 'Nothing to process — skipping.');
    return;
  }

  if (!TIJORI_KEY) {
    log('tijori', '[mock mode] No API key — randomly promoting ~30% of pending rows.');
    for (const evt of pending) {
      if (Math.random() > 0.7) {
        const slug = evt.company_name.toLowerCase().replace(/\s+/g, '-');
        upsertEvent({
          ...evt,
          transcript_status: 'available',
          transcript_url: `https://www.tijoristack.ai/concalls/${slug}`,
          transcript_summary_url: `https://www.tijoristack.ai/concalls/${slug}#summary`,
          transcript_summary_text: `[Mock] Key highlights for ${evt.company_name}: Revenue grew 12% YoY. Management guided for continued expansion. Operating margins stable at 18%.`,
        });
        log('tijori', `  [mock] promoted: ${evt.company_name}`);
      }
    }
    addPollingLog({ source: 'tijori', poll_time: pollTime, status: 'ok', notes: `Mock mode. ${toProcess.length} rows processed.` });
    return;
  }

  try {
    const concalls = await fetchTijoriConcalls();

    let updated = 0;
    for (const evt of toProcess) {
      const evtName = evt.company_name.toLowerCase().trim();
      const match = concalls.find(c => {
        const name = (c.company_info?.name || '').toLowerCase().trim();
        return name === evtName || name.includes(evtName) || evtName.includes(name);
      });

      if (!match) {
        log('tijori', `  no match: "${evt.company_name}"`);
        continue;
      }

      const transcriptPdf = match.transcript || null;
      const audioUrl      = match.recording_link || null;
      const highlight     = match.summary_highlight || null;

      // Build summary text from highlight + call summary bullets if available
      let aiSummary = match.ai_summary || null;
      if (typeof aiSummary === 'string') { try { aiSummary = JSON.parse(aiSummary); } catch { aiSummary = null; } }
      const callSummaryKey = aiSummary && Object.keys(aiSummary).find(k => k.toLowerCase().includes('call summary'));
      const bullets = callSummaryKey ? (aiSummary[callSummaryKey] || []).slice(0, 5) : [];
      const summaryText = [highlight, ...bullets].filter(Boolean).join('\n') || null;

      if (!transcriptPdf && !audioUrl && !summaryText) {
        log('tijori', `  matched "${evt.company_name}" but no recording/summary yet`);
        continue;
      }

      const slug = match.company_info?.slug || '';
      const concallPageUrl = slug ? `https://www.tijoristack.ai/concalls/${slug}` : null;
      upsertEvent({
        ...evt,
        transcript_status: 'available',
        transcript_url: transcriptPdf,
        transcript_summary_url: concallPageUrl ? `${concallPageUrl}#summary` : null,
        transcript_summary_text: summaryText,
        audio_url: audioUrl,
      });
      updated++;
      log('tijori', `  ✓ updated: "${evt.company_name}" (slug: ${slug})`);
    }

    addPollingLog({
      source: 'tijori',
      poll_time: pollTime,
      status: 'ok',
      notes: `Fetched ${concalls.length} concalls. Updated ${updated} of ${toProcess.length} processed.`,
    });
    log('tijori', `✅ Poll done. ${updated}/${toProcess.length} updated.`);
  } catch (err) {
    addPollingLog({ source: 'tijori', poll_time: pollTime, status: 'error', notes: err.message });
    logErr('tijori', `Poll failed: ${err.message}`);
  }
}

// ─── Polling Scheduler ────────────────────────────────────────────────────────
let pollingStarted = false;
function startPolling() {
  if (pollingStarted) return;
  pollingStarted = true;

  log('polling', 'Running initial polls on startup…');
  pollStockScans().catch(err => logErr('polling', `StockScans startup poll failed: ${err.message}`));
  pollTijori().catch(err => logErr('polling', `Tijori startup poll failed: ${err.message}`));

  setInterval(() => {
    log('polling', '10m interval — triggering StockScans poll…');
    pollStockScans().catch(err => logErr('polling', err.message));
  }, STOCKSCANS_INTERVAL_MS);

  setInterval(() => {
    log('polling', '30m interval — triggering Tijori poll…');
    pollTijori().catch(err => logErr('polling', err.message));
  }, TIJORI_INTERVAL_MS);

  log('polling', 'Scheduled: StockScans every 10m, Tijori every 30m.');
}

// ─── Express App ──────────────────────────────────────────────────────────────
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Session
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    sameSite: 'lax',
  },
}));

// ─── Auth Middleware ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
  // Auth is only enforced if USERS are configured
  if (!HAS_USERS) return next();

  const pub = ['/login', '/logout'];
  if (pub.includes(req.path)) return next();

  if (req.session?.user) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }

  res.redirect('/login');
});

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session?.user && HAS_USERS) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  if (!HAS_USERS) return res.redirect('/');
  const { username, password } = req.body || {};
  if (username && USERS[username] && USERS[username] === password) {
    req.session.user = username;
    log('auth', `✓ Login: "${username}"`);
    res.redirect('/');
  } else {
    log('auth', `✗ Failed login attempt: "${username}"`);
    res.redirect('/login?error=1');
  }
});

app.post('/logout', (req, res) => {
  log('auth', `Logout: "${req.session?.user}"`);
  req.session.destroy(() => res.redirect('/login'));
});

// ─── Admin Key Check ──────────────────────────────────────────────────────────
function requireAdmin(req, res) {
  const key = req.headers['x-admin-key'] || req.query.admin_key;
  if (key !== ADMIN_KEY) {
    res.status(403).json({ error: 'Admin access required.' });
    return false;
  }
  return true;
}

// ─── API Routes ───────────────────────────────────────────────────────────────
// GET /api/events
app.get('/api/events', (req, res) => {
  const { search, sentiment, is_read, transcript_status } = req.query;
  const filters = {};
  if (search) filters.search = search;
  if (sentiment) filters.sentiment = sentiment;
  if (transcript_status) filters.transcript_status = transcript_status;
  if (is_read !== undefined) filters.is_read = is_read === 'true';
  const events = getAllEvents(filters);
  res.json(events);
});

// GET /api/kpis
app.get('/api/kpis', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const all = db.prepare(
    "SELECT is_read, transcript_status FROM result_events WHERE result_date = ?"
  ).all(today);

  const total_today = all.length;
  const unread_today = all.filter(r => !r.is_read).length;
  const read_today = all.filter(r => r.is_read).length;
  const transcript_pending = db
    .prepare("SELECT COUNT(*) as c FROM result_events WHERE transcript_status = 'pending'")
    .get().c;
  const transcript_available = db
    .prepare("SELECT COUNT(*) as c FROM result_events WHERE transcript_status = 'available'")
    .get().c;

  res.json({ total_today, unread_today, read_today, transcript_pending, transcript_available });
});

// GET /api/logs
app.get('/api/logs', (req, res) => {
  res.json(stmts.getLogs.all());
});

// PATCH /api/events/:id/read
app.patch('/api/events/:id/read', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const evt = getEventById(req.params.id);
  if (!evt) return res.status(404).json({ error: 'Event not found.' });
  const is_read = req.body.is_read !== undefined ? Boolean(req.body.is_read) : !evt.is_read;
  upsertEvent({ ...evt, is_read });
  res.json(getEventById(req.params.id));
});

// POST /api/poll/screener  (manual trigger — kept as /screener for frontend compat)
app.post('/api/poll/screener', (req, res) => {
  if (!requireAdmin(req, res)) return;
  log('api', 'Manual StockScans poll triggered by admin.');
  pollStockScans().catch(err => logErr('stockscans', err.message));
  res.json({ ok: true, message: 'StockScans poll triggered.' });
});

// POST /api/poll/tijori
app.post('/api/poll/tijori', (req, res) => {
  if (!requireAdmin(req, res)) return;
  log('api', 'Manual Tijori poll triggered by admin.');
  pollTijori().catch(err => logErr('tijori', err.message));
  res.json({ ok: true, message: 'Tijori poll triggered.' });
});

// GET /api/debug/last-poll — raw captured StockScans API responses (admin only)
app.get('/api/debug/last-poll', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(lastPollCapture);
});

// GET /api/me — current session user info (useful for the frontend)
app.get('/api/me', (req, res) => {
  if (!HAS_USERS || req.session?.user) {
    res.json({ user: req.session?.user || 'anonymous', auth_enabled: HAS_USERS });
  } else {
    res.status(401).json({ error: 'Not authenticated.' });
  }
});

// GET /api/admin-token — returns admin key to authenticated users (used by frontend to auto-apply)
app.get('/api/admin-token', (req, res) => {
  if (HAS_USERS && !req.session?.user)
    return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ key: ADMIN_KEY });
});

// GET /userguide — serve the user guide page (must be explicit so SPA fallback doesn't intercept)
app.get('/userguide', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'userguide.html'));
});

// ─── Static Files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback — serve index.html for any non-API, non-file route
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log('server', '━'.repeat(50));
  log('server', `🚀 Results Radar v2 → http://localhost:${PORT}`);
  if (HAS_USERS) {
    log('server', `🔐 Auth ON — users: ${Object.keys(USERS).join(', ')}`);
  } else {
    log('server', '🌐 Auth OFF — dashboard is publicly accessible');
  }
  log('server', `🔑 Admin key: ****${ADMIN_KEY.slice(-4)}`);
  log('server', '━'.repeat(50));
  startPolling();
});
