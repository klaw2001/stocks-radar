'use strict';

const cron = require('node-cron');

const { STOCKSCANS_CRON, TIJORI_CRON, STOCKPRICE_CRON } = require('./config');
const { log, logErr }                                    = require('./logger');
const { pollStockScans }                                 = require('./pollers/stockscans');
const { pollTijori }                                     = require('./pollers/tijori');
const { pollStockPrices }                                = require('./pollers/stockprice');
const { pollPendingChatter }                             = require('./pollers/twitter');

let pollingStarted = false;

function startPolling() {
  if (pollingStarted) return;
  pollingStarted = true;

  log('polling', 'Running initial polls on startup…');
  // StockScans first so new companies are in DB before Tijori matches them
  pollStockScans()
    .then(() => pollTijori())
    .catch(err => logErr('polling', `Startup poll failed: ${err.message}`));

  // StockScans every 10 minutes
  cron.schedule(STOCKSCANS_CRON, () => {
    log('polling', `Cron (${STOCKSCANS_CRON}) — triggering StockScans poll…`);
    pollStockScans().catch(err => logErr('polling', err.message));
  });

  // Tijori every 30 minutes
  cron.schedule(TIJORI_CRON, () => {
    log('polling', `Cron (${TIJORI_CRON}) — triggering Tijori poll…`);
    pollTijori().catch(err => logErr('polling', err.message));
  });

  // Live stock prices every 10 minutes (market-hours check inside poller)
  cron.schedule(STOCKPRICE_CRON, () => {
    log('polling', `Cron (${STOCKPRICE_CRON}) — triggering stock price update…`);
    pollStockPrices().catch(err => logErr('stockprice', err.message));
  });

  // Twitter chatter check every 15 minutes (1-hour delay enforced inside poller)
  cron.schedule('*/15 * * * *', () => {
    log('polling', 'Cron (*/15) — checking pending chatter…');
    pollPendingChatter().catch(err => logErr('twitter', err.message));
  });

  log('polling', `Scheduled: StockScans ${STOCKSCANS_CRON}, Tijori ${TIJORI_CRON}, StockPrice ${STOCKPRICE_CRON}, Chatter */15.`);
}

module.exports = { startPolling };
