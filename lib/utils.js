'use strict';

const crypto = require('crypto');
const { MARKET_OPEN_HOUR, MARKET_CLOSE_HOUR } = require('./config');

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
  const istHour     = new Date(Date.now() + istOffsetMs).getUTCHours();
  return istHour >= MARKET_OPEN_HOUR && istHour < MARKET_CLOSE_HOUR;
}

module.exports = { makeEventId, toFloat, isMarketHours };
