'use strict';

const path      = require('path');
const fs        = require('fs');
const puppeteer = require('puppeteer');

const { TIJORI_KEY }                                          = require('../config');
const { log, logErr }                                         = require('../logger');
const { prisma, upsertEvent, addPollingLog, getAllEvents }     = require('../db');

// ─── Name matching helpers ────────────────────────────────────────────────────
function stripSuffix(str) {
  return str.toLowerCase()
    .replace(/\s+(ltd|limited|pvt|private|corp|corporation|inc|co)\.?\s*$/i, '')
    .replace(/-/g, ' ')
    .trim();
}

function concallMatches(concall, evtName) {
  const name     = (concall.company_info?.name || '').toLowerCase().trim();
  const slug     = stripSuffix(concall.company_info?.slug || '');
  const evtClean = stripSuffix(evtName);
  return name === evtName
    || name.includes(evtName) || evtName.includes(name)
    || (slug && (slug === evtClean || slug.includes(evtClean) || evtClean.includes(slug)));
}

// ─── Tijori API fetch (via Puppeteer to bypass Cloudflare) ───────────────────
async function fetchTijoriConcalls(pendingNames = []) {
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
    log('tijori', 'Cloudflare cleared.');

    // Call the concalls API from inside the page context (shares CF cookies)
    const callApi = (params) => page.evaluate(async (key, params) => {
      try {
        const resp = await fetch(`/api/v1/concalls/list?${params}`, {
          headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' },
        });
        return { status: resp.status, body: await resp.text() };
      } catch (e) {
        return { error: e.message };
      }
    }, TIJORI_KEY, params);

    // Step 1: fetch recent bulk list
    log('tijori', 'Calling /api/v1/concalls/list (recent)…');
    const bulkResult = await callApi('page=1&mcap=all&upcoming=false&page_size=20');
    if (bulkResult.error) throw new Error(bulkResult.error);

    log('tijori', `API response: HTTP ${bulkResult.status}`);
    fs.writeFileSync(
      path.join(__dirname, '..', '..', 'concall_api_response.txt'),
      `[${new Date().toISOString()}] HTTP ${bulkResult.status}\n\n${bulkResult.body}\n`,
      'utf8'
    );
    if (bulkResult.status !== 200) {
      logErr('tijori', `Non-200 response: ${bulkResult.body.slice(0, 300)}`);
      await browser.close();
      return [];
    }

    const bulkJson    = JSON.parse(bulkResult.body);
    const allConcalls = [...(bulkJson?.data || [])];
    log('tijori', `✓ Got ${allConcalls.length} concalls from bulk list.`);

    // Step 2: for each pending company not matched in bulk, search individually
    const directMap = new Map(); // originalDbName → concall object

    for (const companyName of pendingNames) {
      const evtName     = companyName.toLowerCase().trim();
      const foundInBulk = allConcalls.some(c => concallMatches(c, evtName));

      if (!foundInBulk) {
        const cleanName = companyName.replace(/\s+(ltd|limited|pvt|private|corp|corporation)\.?\s*$/i, '').trim();
        log('tijori', `  Searching for "${companyName}" (query: "${cleanName}")…`);
        const searchResult = await callApi(
          `company_name=${encodeURIComponent(cleanName)}&upcoming=false&page_size=5`
        );
        if (!searchResult.error && searchResult.status === 200) {
          const searchData = JSON.parse(searchResult.body)?.data || [];
          log('tijori', `  Search returned ${searchData.length} result(s) for "${cleanName}"`);
          if (searchData.length > 0) {
            const bestMatch = searchData.find(c => concallMatches(c, evtName));
            if (bestMatch) {
              directMap.set(companyName, bestMatch);
              allConcalls.push(bestMatch);
            } else {
              log('tijori', `  Search results for "${cleanName}" did not match — skipping`);
            }
          }
        }
      }
    }

    await browser.close();
    browser = null;
    return { bulk: allConcalls, directMap };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw err;
  }
}

// ─── Main poll ────────────────────────────────────────────────────────────────
async function pollTijori() {
  const pollTime = new Date().toISOString();
  const pending  = await getAllEvents({ transcript_status: 'pending' });

  // Also pick up 'available' rows missing a PDF URL or the full AI summary
  const needsRefresh = await prisma.resultEvent.findMany({
    where: {
      transcript_status: 'available',
      OR: [
        { transcript_url: null },
        { transcript_url: { not: { endsWith: '.pdf' } } },
        { ai_summary_json: null },
      ],
    },
  });

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
        await upsertEvent({
          ...evt,
          transcript_status:       'available',
          transcript_url:          `https://www.tijoristack.ai/concalls/${slug}`,
          transcript_summary_url:  `https://www.tijoristack.ai/concalls/${slug}#summary`,
          transcript_summary_text: `[Mock] Key highlights for ${evt.company_name}: Revenue grew 12% YoY. Management guided for continued expansion. Operating margins stable at 18%.`,
        });
        log('tijori', `  [mock] promoted: ${evt.company_name}`);
      }
    }
    await addPollingLog({ source: 'tijori', poll_time: pollTime, status: 'ok', notes: `Mock mode. ${toProcess.length} rows processed.` });
    return;
  }

  try {
    const { bulk: concalls, directMap } = await fetchTijoriConcalls(toProcess.map(e => e.company_name));

    let updated = 0;
    for (const evt of toProcess) {
      const evtName = evt.company_name.toLowerCase().trim();
      const match   = directMap.get(evt.company_name) || concalls.find(c => concallMatches(c, evtName));

      if (!match) {
        log('tijori', `  no match: "${evt.company_name}"`);
        continue;
      }

      const transcriptPdf = match.transcript || null;
      const audioUrl      = match.recording_link || null;
      const highlight     = match.summary_highlight || null;

      // Parse ai_summary to object (may already be string or object)
      let aiSummaryObj = match.ai_summary || null;
      if (typeof aiSummaryObj === 'string') {
        try { aiSummaryObj = JSON.parse(aiSummaryObj); } catch { aiSummaryObj = null; }
      }

      // Full JSON stored verbatim for rich sidebar rendering
      const aiSummaryJson = aiSummaryObj ? JSON.stringify(aiSummaryObj) : null;

      // Short plaintext fallback (used to gate the Bot icon in the table)
      const callSummaryKey = aiSummaryObj && Object.keys(aiSummaryObj).find(k => k.toLowerCase().includes('call summary'));
      const bullets        = callSummaryKey ? (aiSummaryObj[callSummaryKey] || []).slice(0, 3) : [];
      const summaryText    = [highlight, ...bullets].filter(Boolean).join('\n') || null;

      if (!transcriptPdf && !audioUrl && !aiSummaryJson) {
        log('tijori', `  matched "${evt.company_name}" but no recording/summary yet`);
        continue;
      }

      const slug           = match.company_info?.slug || '';
      const concallPageUrl = slug ? `https://www.tijoristack.ai/concalls/${slug}` : null;
      await upsertEvent({
        ...evt,
        transcript_status:       'available',
        transcript_url:          transcriptPdf,
        transcript_summary_url:  concallPageUrl ? `${concallPageUrl}#summary` : null,
        transcript_summary_text: summaryText,
        audio_url:               audioUrl,
        ai_summary_json:         aiSummaryJson,
      });
      updated++;
      log('tijori', `  ✓ updated: "${evt.company_name}" (slug: ${slug})`);
    }

    await addPollingLog({
      source:    'tijori',
      poll_time: pollTime,
      status:    'ok',
      notes:     `Fetched ${concalls.length} concalls. Updated ${updated} of ${toProcess.length} processed.`,
    });
    log('tijori', `✅ Poll done. ${updated}/${toProcess.length} updated.`);
  } catch (err) {
    await addPollingLog({ source: 'tijori', poll_time: pollTime, status: 'error', notes: err.message });
    logErr('tijori', `Poll failed: ${err.message}`);
  }
}

module.exports = { pollTijori, fetchTijoriConcalls };
