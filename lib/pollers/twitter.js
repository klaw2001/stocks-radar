'use strict';

const { X_BEARER_TOKEN, OPENROUTER_API_KEY } = require('../config');
const { log, logErr }                         = require('../logger');
const { addPollingLog, updateChatterData, getPendingChatterEvents, getAllEventsForReanalysis } = require('../db');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const POSITIVE_KEYWORDS = ['beat', 'strong', 'bullish', 'buy', 'outperform', 'raise', 'upgrade', 'record', 'surge'];
const NEGATIVE_KEYWORDS = ['miss', 'weak', 'bearish', 'sell', 'downgrade', 'cut', 'concern', 'disappoint', 'fall'];

const delay = ms => new Promise(res => setTimeout(res, ms));

// ─── Sentiment analysis via OpenRouter (GPT-4o-mini) ─────────────────────────
async function analyzeWithOpenRouter(companyName, tweets) {
  if (!OPENROUTER_API_KEY) {
    // Fallback: keyword counting
    let pos = 0, neg = 0;
    for (const t of tweets) {
      const text = t.text.toLowerCase();
      POSITIVE_KEYWORDS.forEach(k => { if (text.includes(k)) pos++; });
      NEGATIVE_KEYWORDS.forEach(k => { if (text.includes(k)) neg++; });
    }
    const sentiment = pos > neg ? 'good' : neg > pos ? 'bad' : 'neutral';
    return {
      sentiment,
      summary: `${tweets.length} posts found. ${pos} positive signals, ${neg} negative signals. (keyword analysis — set OPENROUTER_API_KEY for AI analysis)`,
    };
  }

  const tweetText = tweets.map((t, i) => `${i + 1}. ${t.text}`).join('\n');

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://results-radar',
        'X-Title': 'Results Radar',
      },
      body: JSON.stringify({
        model: 'openai/gpt-4o-mini',
        max_tokens: 250,
        messages: [
          {
            role: 'system',
            content: 'You analyze Twitter/X posts about Indian stock earnings results. Respond ONLY with valid JSON in this exact format: {"sentiment":"good","summary":"2-3 sentences explaining why"} — where sentiment is one of: good, bad, neutral.',
          },
          {
            role: 'user',
            content: `Company: ${companyName}\n\nTweets:\n${tweetText}`,
          },
        ],
      }),
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`OpenRouter ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content?.trim() ?? '';

    // Strip markdown code fences if present
    const jsonStr = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const parsed = JSON.parse(jsonStr);

    const validSentiments = ['good', 'bad', 'neutral'];
    const sentiment = validSentiments.includes(parsed.sentiment) ? parsed.sentiment : 'neutral';
    const summary = typeof parsed.summary === 'string' ? parsed.summary : 'Analysis complete.';

    return { sentiment, summary };
  } catch (err) {
    logErr('twitter', `OpenRouter analysis failed for "${companyName}": ${err.message}`);
    // Fallback to keyword counting on AI failure
    let pos = 0, neg = 0;
    for (const t of tweets) {
      const text = t.text.toLowerCase();
      POSITIVE_KEYWORDS.forEach(k => { if (text.includes(k)) pos++; });
      NEGATIVE_KEYWORDS.forEach(k => { if (text.includes(k)) neg++; });
    }
    const sentiment = pos > neg ? 'good' : neg > pos ? 'bad' : 'neutral';
    return { sentiment, summary: `${tweets.length} posts analyzed. ${pos} positive, ${neg} negative signals. (AI analysis unavailable)` };
  }
}

// ─── Fetch tweets for a company ───────────────────────────────────────────────
async function fetchTweets(companyName) {
  const cleanName = companyName.replace(/[&()/\\]/g, ' ').replace(/\s+/g, ' ').trim();
  const query = encodeURIComponent(`${cleanName} results -is:retweet lang:en`);
  const resp = await fetch(
    `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=10&tweet.fields=text,public_metrics`,
    { headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` } }
  );

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`X API ${resp.status}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  return data.data || [];
}

// ─── Main: poll pending chatter (called by cron every 15 min) ─────────────────
async function pollPendingChatter() {
  const pollTime = new Date().toISOString();
  const events = await getPendingChatterEvents();

  if (events.length === 0) {
    log('twitter', 'No pending chatter events (all done or still within 1-hour wait).');
    return;
  }

  log('twitter', `Processing chatter for ${events.length} compan${events.length === 1 ? 'y' : 'ies'}…`);

  for (const evt of events) {
    const { event_id: eventId, company_name: companyName } = evt;

    // No X API key — mark done with neutral so we don't keep retrying
    if (!X_BEARER_TOKEN) {
      await updateChatterData(eventId, 'neutral', 'No X API key configured.', null);
      log('twitter', `[no-key] ${companyName} → neutral`);
      await delay(100);
      continue;
    }

    try {
      const tweets = await fetchTweets(companyName);
      log('twitter', `Fetched ${tweets.length} tweets for "${companyName}"`);

      const postLinks = tweets.map(t => `https://twitter.com/i/web/status/${t.id}`);
      const { sentiment, summary } = await analyzeWithOpenRouter(companyName, tweets);

      await updateChatterData(
        eventId,
        sentiment,
        summary,
        postLinks.length > 0 ? JSON.stringify(postLinks.slice(0, 10)) : null
      );

      await addPollingLog({
        source:    'twitter',
        poll_time: pollTime,
        status:    'ok',
        notes:     `${companyName}: ${sentiment} (${tweets.length} tweets)`,
      });

      log('twitter', `✓ "${companyName}" → ${sentiment}`);
    } catch (err) {
      // Leave chatter_fetched=false so it retries next cron tick
      logErr('twitter', `"${companyName}": ${err.message}`);
      await addPollingLog({
        source:    'twitter',
        poll_time: pollTime,
        status:    'error',
        notes:     `${companyName}: ${err.message}`,
      });
    }

    await delay(500);
  }

  log('twitter', 'Chatter poll complete.');
}

// ─── DANGER: Re-analyze chatter for ALL events (overwrites existing data) ────
async function reanalyzeAllChatter() {
  const pollTime = new Date().toISOString();
  const events = await getAllEventsForReanalysis();
  let success = 0, errors = 0;

  log('twitter', `[reanalyze-all] Reanalyzing chatter for ${events.length} events…`);

  for (const evt of events) {
    const { event_id: eventId, company_name: companyName } = evt;

    if (!X_BEARER_TOKEN) {
      await updateChatterData(eventId, 'neutral', 'No X API key configured.', null);
      success++;
      await delay(100);
      continue;
    }

    try {
      const tweets = await fetchTweets(companyName);
      const postLinks = tweets.map(t => `https://twitter.com/i/web/status/${t.id}`);
      const { sentiment, summary } = await analyzeWithOpenRouter(companyName, tweets);

      await updateChatterData(
        eventId,
        sentiment,
        summary,
        postLinks.length > 0 ? JSON.stringify(postLinks.slice(0, 10)) : null
      );

      await addPollingLog({
        source:    'twitter',
        poll_time: pollTime,
        status:    'ok',
        notes:     `[reanalyze] ${companyName}: ${sentiment} (${tweets.length} tweets)`,
      });

      log('twitter', `[reanalyze] ✓ "${companyName}" → ${sentiment}`);
      success++;
    } catch (err) {
      logErr('twitter', `[reanalyze] "${companyName}": ${err.message}`);
      await addPollingLog({
        source:    'twitter',
        poll_time: pollTime,
        status:    'error',
        notes:     `[reanalyze] ${companyName}: ${err.message}`,
      });
      errors++;
    }

    await delay(500);
  }

  log('twitter', `[reanalyze-all] Done. ${success} success, ${errors} errors.`);
  return { processed: events.length, success, errors };
}

module.exports = { pollPendingChatter, reanalyzeAllChatter };
