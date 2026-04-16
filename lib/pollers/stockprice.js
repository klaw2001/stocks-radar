'use strict';

const { log, logErr }                           = require('../logger');
const { addPollingLog, updatePriceByCompany, getDistinctCompanies } = require('../db');

// ─── Market hours check (IST) ─────────────────────────────────────────────────
function isMarketHours() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const totalMin = ist.getHours() * 60 + ist.getMinutes();
  return totalMin >= (9 * 60 + 15) && totalMin <= (15 * 60 + 30);
}

// ─── Manual ticker overrides (Yahoo search fails for these) ───────────────────
const TICKER_OVERRIDES = {
  'Elecon Engineering Company Ltd':              'ELECON.NS',
  'Tejas Networks Ltd':                          'TEJASNET.NS',
  'ICICI Lombard General Insurance Company Ltd': 'ICICIGI.NS',
  'ICICI Prudential Life Insurance Company Ltd': 'ICICIPRULI.NS',
  'ICICI Prudential Asset Management Co Ltd':    'ICICIPRAMC.NS',
  'Reliance Industrial Infrastructure Ltd':      'RIIL.NS',
  'Nuvoco Vistas Corporation Ltd':               'NUVOCO.NS',
  'HDB Financial Services Ltd':                  'HDBFS.NS',
  'Anand Rathi Share & Stock Brokers Ltd':       'ARSSBL.NS',
  'Kesar India Ltd':                             'KESARIND.NS',
  'Krishana Phoschem Ltd':                       'KRISHANA.NS',
};

// ─── Ticker resolution ────────────────────────────────────────────────────────
const tickerCache = new Map(); // companyName → 'RELIANCE.NS' (only successful lookups cached)

async function resolveTickerFor(companyName) {
  if (TICKER_OVERRIDES[companyName]) return TICKER_OVERRIDES[companyName];
  if (tickerCache.has(companyName)) return tickerCache.get(companyName);

  const encoded = encodeURIComponent(companyName);
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encoded}&quotesCount=5&newsCount=0&enableFuzzyQuery=false&country=India`;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    clearTimeout(timer);

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const quotes = data?.finance?.result?.[0]?.documents ?? data?.quotes ?? [];

    // Prefer .NS (NSE), fallback .BO (BSE)
    const ns = quotes.find(q => q.symbol?.endsWith('.NS'));
    const bo = quotes.find(q => q.symbol?.endsWith('.BO'));
    const ticker = ns?.symbol ?? bo?.symbol ?? null;

    if (ticker) tickerCache.set(companyName, ticker);
    return ticker;
  } catch (err) {
    logErr('stockprice', `Ticker lookup failed for "${companyName}": ${err.message}`);
    return null;
  }
}

// ─── Price fetch ──────────────────────────────────────────────────────────────
async function fetchPrice(ticker) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    clearTimeout(timer);

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice ?? null;
    return typeof price === 'number' ? price : null;
  } catch (err) {
    logErr('stockprice', `Price fetch failed for ${ticker}: ${err.message}`);
    return null;
  }
}

// ─── Delay helper ─────────────────────────────────────────────────────────────
const delay = ms => new Promise(res => setTimeout(res, ms));

// ─── Main poll ────────────────────────────────────────────────────────────────
async function pollStockPrices() {
  const pollTime = new Date().toISOString();

  if (!isMarketHours()) {
    log('stockprice', 'Outside market hours (9:15–15:30 IST), skipping price update.');
    return;
  }

  const companies = await getDistinctCompanies();
  if (companies.length === 0) {
    log('stockprice', 'No companies in DB, skipping.');
    return;
  }

  log('stockprice', `Updating prices for ${companies.length} companies…`);
  let updated = 0;
  let skipped = 0;

  for (const name of companies) {
    const ticker = await resolveTickerFor(name);
    if (!ticker) {
      log('stockprice', `No ticker found for "${name}", skipping.`);
      skipped++;
      await delay(300);
      continue;
    }

    const price = await fetchPrice(ticker);
    if (price !== null) {
      await updatePriceByCompany(name, price);
      log('stockprice', `✓ ${name} (${ticker}) → ₹${price}`);
      updated++;
    } else {
      skipped++;
    }

    await delay(300);
  }

  await addPollingLog({
    source:    'stockprice',
    poll_time: pollTime,
    status:    'ok',
    notes:     `Updated ${updated} / ${companies.length} companies (${skipped} skipped)`,
  });
  log('stockprice', `Done. Updated ${updated}, skipped ${skipped}.`);
}

module.exports = { pollStockPrices };
