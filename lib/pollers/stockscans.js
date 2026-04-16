'use strict';

const puppeteer = require('puppeteer');

const { log, logErr }                                         = require('../logger');
const { getEventById, upsertEvent, addPollingLog }            = require('../db');
const { makeEventId, toFloat }                                = require('../utils');
const { pollTijori }                                          = require('./tijori');

// Stores last StockScans API capture for /api/debug/last-poll
let lastPollCapture = [];

// ─── Main poll ────────────────────────────────────────────────────────────────
async function pollStockScans() {
  const pollTime = new Date().toISOString();
  const today    = new Date().toISOString().slice(0, 10);
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
      const ct  = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
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

    await new Promise(r => setTimeout(r, 3000));
    await page.waitForTimeout?.(1000).catch(() => {});

    // ── Parse captured JSON responses ──────────────────────────────────────
    let rows = [];

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

    // ── DOM fallback ───────────────────────────────────────────────────────
    if (rows.length === 0) {
      log('stockscans', '⚠ No usable JSON captured — falling back to DOM scrape.');
      rows = await page.evaluate(() => {
        const results = [];
        const tables  = document.querySelectorAll('table');
        for (const table of tables) {
          const trs = table.querySelectorAll('tbody tr, tr');
          trs.forEach(tr => {
            const tds   = tr.querySelectorAll('td');
            if (tds.length < 2) return;
            const cells = Array.from(tds).map(td => td.innerText.trim());
            const companyCell = cells.find(c => c && c.length > 2 && isNaN(parseFloat(c)));
            if (companyCell) results.push({ _dom: true, cells, company: companyCell });
          });
        }
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

    // ── Normalize → DB ─────────────────────────────────────────────────────
    log('stockscans', `Normalizing ${rows.length} raw rows…`);
    const normalized = normalizeStockScansRows(rows, today);
    log('stockscans', `  → ${normalized.length} valid companies after normalization`);
    let newCount = 0;

    for (const evt of normalized) {
      const isNew = !(await getEventById(evt.event_id));
      await upsertEvent(evt);
      if (isNew) {
        newCount++;
        log('stockscans', `  + NEW: ${evt.company_name} (${evt.result_date}) — chatter queued (1hr delay)`);
      }
    }

    await addPollingLog({
      source:    'stockscans',
      poll_time: pollTime,
      status:    'ok',
      notes:     `Parsed ${normalized.length} rows, ${newCount} new.`,
    });
    log('stockscans', `✅ Poll done. ${normalized.length} total, ${newCount} new.`);

    if (newCount > 0) {
      pollTijori().catch(err => logErr('tijori', `Post-discovery poll failed: ${err.message}`));
    }
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    await addPollingLog({ source: 'stockscans', poll_time: pollTime, status: 'error', notes: err.message });
    logErr('stockscans', `Poll failed: ${err.message}`);
  }
}

// ─── Normalize raw rows → result_events shape ─────────────────────────────────
function normalizeStockScansRows(rows, today) {
  const results = [];

  for (const row of rows) {
    if (!row._dom) {
      // ── StockScans JSON API path ───────────────────────────────────────────
      const meta  = row.metaRatios || {};
      const rtRaw = row.resultTable || {};
      const docs  = Array.isArray(row.documents) ? row.documents : [];

      const company =
        meta.companyName || meta.company_name || meta.name || meta.Name ||
        meta.Company || meta['Company Name'] ||
        row.company_name || row.companyName || row.name ||
        (row.companyId ? String(row.companyId) : null);
      if (!company) continue;
      if (/^(NSE|BSE|MCX):[A-Z0-9]+$/i.test(company)) continue;

      const resultDate = (
        meta.resultDate || meta.result_date || meta.date ||
        meta['Last Result Date'] || meta['lastResultDate'] || meta['result_date'] ||
        row.resultDate || row.result_date || today
      ).slice(0, 10);

      const pdfDoc   = docs.find(d => (d.type || '').toLowerCase().includes('result') ||
                                      (d.url  || '').toLowerCase().includes('.pdf'));
      const pdfUrl   = pdfDoc?.url || null;
      const sourceUrl = 'https://www.stockscans.in/result-scans';

      // Parse resultTable (array, named-object, or 2D-array keyed by C/S)
      let rt = {};
      if (Array.isArray(rtRaw)) {
        for (const entry of rtRaw) {
          const key = (entry.label || entry.metric || entry.name || entry.key || '').toLowerCase();
          rt[key] = entry;
        }
      } else if (typeof rtRaw === 'object') {
        const fundSource  = (meta['Fundamentals Source'] || meta.fundamentalsSource || '').toUpperCase();
        const rtEntries   = Object.entries(rtRaw);
        const hasBothCS   = rtEntries.some(([k]) => k === 'C') && rtEntries.some(([k]) => k === 'S');
        const entriesToProcess = (hasBothCS && (fundSource === 'C' || fundSource === 'S'))
          ? rtEntries.filter(([k]) => k === fundSource)
          : rtEntries;

        for (const [k, v] of entriesToProcess) {
          if (Array.isArray(v) && v.length > 1 && Array.isArray(v[0])) {
            const headers    = v[0];
            const yoyColIdx  = headers.findIndex(h => String(h).toUpperCase() === 'YOY');
            const currColIdx = headers.findIndex((h, i) => i >= 3 && h && /^\d{6}$/.test(String(h)));
            for (let i = 1; i < v.length; i++) {
              const dataRow = v[i];
              const label   = dataRow[0];
              if (!label) continue;
              rt[String(label).toLowerCase()] = {
                label,
                yoy_pct: yoyColIdx >= 0 ? dataRow[yoyColIdx] : dataRow[1],
                curr:    currColIdx >= 0 ? dataRow[currColIdx] : dataRow[3],
              };
            }
          } else {
            rt[k.toLowerCase()] = v;
          }
        }
      }

      const curr = (entry) => {
        if (!entry) return null;
        return toFloat(entry.curr ?? entry.current ?? entry.value ?? entry.q_curr ?? entry.ttm);
      };
      const yoy = (entry) => {
        if (!entry) return null;
        return toFloat(entry.yoy_pct ?? entry.yoy ?? entry.chg ?? entry.change ?? entry.growth);
      };
      const find = (...keys) => {
        for (const k of keys) {
          const entry = rt[k] || rt[k.toLowerCase()];
          if (entry !== undefined) return entry;
        }
        for (const [k, v] of Object.entries(rt)) {
          for (const key of keys) {
            if (k.includes(key.toLowerCase())) return v;
          }
        }
        return null;
      };

      const salesEntry  = find('revenue', 'sales', 'net sales', 'total revenue', 'net revenue');
      const ebitdaEntry = find('ebitda', 'operating profit', 'op profit', 'ebidta');
      const patEntry    = find('pat', 'net profit', 'profit after tax', 'net income');
      const epsEntry    = find('eps', 'earnings per share');

      const price = toFloat(meta.cmp ?? meta.price ?? meta.ltp ?? meta.CMP ?? meta['CMP'] ?? meta['Price']);
      const mcap  = toFloat(meta.marketCap ?? meta.market_cap ?? meta.mcap ?? meta['Mkt Cap'] ?? meta['Market Capitalization'] ?? meta['MarketCap']);
      const pe    = toFloat(meta.pe ?? meta.PE ?? meta.pe_ratio ?? meta['P/E'] ?? meta['Price To Earnings'] ?? meta['PriceToEarnings']);

      const eventId = makeEventId(company, resultDate, row.companyId || '');

      results.push({
        event_id:       eventId,
        company_name:   String(company).trim(),
        result_date:    resultDate,
        screener_url:   sourceUrl,
        pdf_url:        pdfUrl,
        price,
        market_cap:     mcap,
        pe,
        sales_yoy:      yoy(salesEntry),
        sales_current:  curr(salesEntry),
        ebitda_yoy:     yoy(ebitdaEntry),
        ebitda_current: curr(ebitdaEntry),
        pat_yoy:        yoy(patEntry),
        pat_current:    curr(patEntry),
        eps_yoy:        yoy(epsEntry),
        eps_current:    curr(epsEntry),
        chatter_sentiment:      null,
        chatter_summary:        null,
        top_post_links:         null,
        transcript_status:      'pending',
        transcript_url:         null,
        transcript_summary_url: null,
        transcript_summary_text:null,
        is_read:    false,
        created_at: new Date().toISOString(),
      });
    } else {
      // ── DOM fallback path ────────────────────────────────────────────────
      const company = row.company;
      if (!company || company.length < 2) continue;
      if (/^(NSE|BSE|MCX):[A-Z0-9]+$/i.test(company)) continue;
      const METRIC_LABELS = /^(revenue|operating profit|pat|eps|ebitda|opm|npm|sales|profit|loss|income|expense)\b/i;
      if (METRIC_LABELS.test(company)) continue;

      const eventId = makeEventId(company, today, '');
      const nums    = (row.cells || []).map(c => toFloat(c)).filter(n => n !== null);

      results.push({
        event_id:       eventId,
        company_name:   company.trim(),
        result_date:    today,
        screener_url:   null,
        pdf_url:        null,
        price:          nums[0]  ?? null,
        market_cap:     nums[1]  ?? null,
        pe:             nums[2]  ?? null,
        sales_yoy:      nums[3]  ?? null,
        sales_current:  nums[4]  ?? null,
        ebitda_yoy:     nums[5]  ?? null,
        ebitda_current: nums[6]  ?? null,
        pat_yoy:        nums[7]  ?? null,
        pat_current:    nums[8]  ?? null,
        eps_yoy:        nums[9]  ?? null,
        eps_current:    nums[10] ?? null,
        chatter_sentiment:      null,
        chatter_summary:        null,
        top_post_links:         null,
        transcript_status:      'pending',
        transcript_url:         null,
        transcript_summary_url: null,
        transcript_summary_text:null,
        is_read:    false,
        created_at: new Date().toISOString(),
      });
    }
  }

  return results;
}

module.exports = { pollStockScans, lastPollCapture: () => lastPollCapture };
