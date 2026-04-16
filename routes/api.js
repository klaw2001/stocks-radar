'use strict';

const express = require('express');

const { prisma, getEventById, upsertEvent, getAllEvents } = require('../lib/db');
const { log, logErr }          = require('../lib/logger');
const { ADMIN_KEY, HAS_USERS } = require('../lib/config');
const { requireAdmin }         = require('../middleware/auth');
const { pollStockScans, lastPollCapture } = require('../lib/pollers/stockscans');
const { pollTijori }           = require('../lib/pollers/tijori');
const { pollStockPrices }      = require('../lib/pollers/stockprice');
const { reanalyzeAllChatter }  = require('../lib/pollers/twitter');

const router = express.Router();

// GET /api/events
router.get('/events', async (req, res) => {
  try {
    const { search, sentiment, is_read, transcript_status } = req.query;
    const filters = {};
    if (search)             filters.search = search;
    if (sentiment)          filters.sentiment = sentiment;
    if (transcript_status)  filters.transcript_status = transcript_status;
    if (is_read !== undefined) filters.is_read = is_read === 'true';
    res.json(await getAllEvents(filters));
  } catch (e) {
    logErr('api', e.message);
    res.status(500).json({ error: 'Failed to fetch events.' });
  }
});

// GET /api/kpis
router.get('/kpis', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const [todayEvents, transcript_pending, transcript_available] = await Promise.all([
      prisma.resultEvent.findMany({
        where:  { result_date: today },
        select: { is_read: true, transcript_status: true },
      }),
      prisma.resultEvent.count({ where: { transcript_status: 'pending' } }),
      prisma.resultEvent.count({ where: { transcript_status: 'available' } }),
    ]);
    res.json({
      total_today:          todayEvents.length,
      unread_today:         todayEvents.filter(r => !r.is_read).length,
      read_today:           todayEvents.filter(r => r.is_read).length,
      transcript_pending,
      transcript_available,
    });
  } catch (e) {
    logErr('api', e.message);
    res.status(500).json({ error: 'Failed to fetch KPIs.' });
  }
});

// GET /api/logs
router.get('/logs', async (req, res) => {
  try {
    const logs = await prisma.pollingLog.findMany({
      orderBy: { id: 'desc' },
      take: 100,
    });
    res.json(logs);
  } catch (e) {
    logErr('api', e.message);
    res.status(500).json({ error: 'Failed to fetch logs.' });
  }
});

// PATCH /api/events/:id/read
router.patch('/events/:id/read', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const evt = await getEventById(req.params.id);
    if (!evt) return res.status(404).json({ error: 'Event not found.' });
    const is_read = req.body.is_read !== undefined ? Boolean(req.body.is_read) : !evt.is_read;
    await upsertEvent({ ...evt, is_read });
    res.json(await getEventById(req.params.id));
  } catch (e) {
    logErr('api', e.message);
    res.status(500).json({ error: 'Failed to update event.' });
  }
});

// POST /api/poll/screener
router.post('/poll/screener', (req, res) => {
  if (!requireAdmin(req, res)) return;
  log('api', 'Manual StockScans poll triggered by admin.');
  pollStockScans().catch(err => logErr('stockscans', err.message));
  res.json({ ok: true, message: 'StockScans poll triggered.' });
});

// POST /api/poll/tijori
router.post('/poll/tijori', (req, res) => {
  if (!requireAdmin(req, res)) return;
  log('api', 'Manual Tijori poll triggered by admin.');
  pollTijori().catch(err => logErr('tijori', err.message));
  res.json({ ok: true, message: 'Tijori poll triggered.' });
});

// POST /api/poll/chatter/reanalyze-all  ⚠️  DANGER: overwrites all chatter data
router.post('/poll/chatter/reanalyze-all', (req, res) => {
  if (!requireAdmin(req, res)) return;
  log('api', 'DANGER: Full chatter re-analysis triggered by admin.');
  reanalyzeAllChatter().catch(err => logErr('twitter', `reanalyze-all failed: ${err.message}`));
  res.json({ ok: true, message: 'Full chatter re-analysis started for all events. Check /api/logs for progress.' });
});

// POST /api/poll/stockprice
router.post('/poll/stockprice', (req, res) => {
  if (!requireAdmin(req, res)) return;
  log('api', 'Manual stock price poll triggered by admin.');
  pollStockPrices().catch(err => logErr('stockprice', err.message));
  res.json({ ok: true, message: 'Stock price poll triggered.' });
});

// GET /api/debug/last-poll
router.get('/debug/last-poll', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(lastPollCapture());
});

// GET /api/me
router.get('/me', (req, res) => {
  if (!HAS_USERS || req.session?.user) {
    res.json({ user: req.session?.user || 'anonymous', auth_enabled: HAS_USERS });
  } else {
    res.status(401).json({ error: 'Not authenticated.' });
  }
});

// GET /api/admin-token
router.get('/admin-token', (req, res) => {
  if (HAS_USERS && !req.session?.user)
    return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ key: ADMIN_KEY });
});

module.exports = router;
