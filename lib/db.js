'use strict';

const { PrismaClient } = require('@prisma/client');
const { log } = require('./logger');

// ─── Init ─────────────────────────────────────────────────────────────────────
const prisma = new PrismaClient();
log('db', 'Prisma PostgreSQL client initialized.');

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getEventById(id) {
  const result = await prisma.resultEvent.findUnique({ where: { event_id: id } });
  return result ?? null;
}

async function upsertEvent(evt) {
  const now      = new Date().toISOString();
  const existing = await prisma.resultEvent.findUnique({ where: { event_id: evt.event_id } });

  // Replicate SQLite COALESCE(excluded.x, stored_x): prefer new non-null value, else keep existing
  const coalesce = (newVal, oldVal) => (newVal != null ? newVal : (oldVal ?? null));

  const base = {
    event_id:      evt.event_id,
    company_name:  evt.company_name,
    result_date:   evt.result_date,
    screener_url:  coalesce(evt.screener_url,  existing?.screener_url),
    pdf_url:       coalesce(evt.pdf_url,       existing?.pdf_url),
    price:         coalesce(evt.price,         existing?.price),
    market_cap:    coalesce(evt.market_cap,    existing?.market_cap),
    pe:            coalesce(evt.pe,            existing?.pe),
    sales_yoy:     coalesce(evt.sales_yoy,     existing?.sales_yoy),
    sales_current: coalesce(evt.sales_current, existing?.sales_current),
    ebitda_yoy:    coalesce(evt.ebitda_yoy,    existing?.ebitda_yoy),
    ebitda_current:coalesce(evt.ebitda_current,existing?.ebitda_current),
    pat_yoy:       coalesce(evt.pat_yoy,       existing?.pat_yoy),
    pat_current:   coalesce(evt.pat_current,   existing?.pat_current),
    eps_yoy:       coalesce(evt.eps_yoy,       existing?.eps_yoy),
    eps_current:   coalesce(evt.eps_current,   existing?.eps_current),

    // CASE: if chatter already fetched, never overwrite sentiment/summary/links
    chatter_sentiment: existing?.chatter_fetched
      ? existing.chatter_sentiment
      : coalesce(evt.chatter_sentiment, existing?.chatter_sentiment),
    chatter_summary: existing?.chatter_fetched
      ? existing.chatter_summary
      : coalesce(evt.chatter_summary, existing?.chatter_summary),
    top_post_links: existing?.chatter_fetched
      ? existing.top_post_links
      : coalesce(evt.top_post_links, existing?.top_post_links),

    // CASE: transcript_status only promotes to 'available', never demotes
    transcript_status: evt.transcript_status === 'available'
      ? 'available'
      : (existing?.transcript_status ?? evt.transcript_status ?? 'pending'),

    transcript_url:          coalesce(evt.transcript_url,          existing?.transcript_url),
    transcript_summary_url:  coalesce(evt.transcript_summary_url,  existing?.transcript_summary_url),
    transcript_summary_text: coalesce(evt.transcript_summary_text, existing?.transcript_summary_text),
    audio_url:               coalesce(evt.audio_url,               existing?.audio_url),
    ai_summary_json:         coalesce(evt.ai_summary_json,         existing?.ai_summary_json),

    is_read:         Boolean(evt.is_read),
    chatter_fetched: existing?.chatter_fetched ?? false,
    created_at:      existing?.created_at || evt.created_at || now,
    updated_at:      now,
  };

  return prisma.resultEvent.upsert({
    where:  { event_id: evt.event_id },
    create: base,
    update: base,
  });
}

async function addPollingLog(entry) {
  return prisma.pollingLog.create({
    data: {
      source:    entry.source    || null,
      poll_time: entry.poll_time || null,
      status:    entry.status    || null,
      notes:     entry.notes     || null,
    },
  });
}

async function getAllEvents(filters = {}) {
  const where = {};
  if (filters.search)            where.company_name = { contains: filters.search, mode: 'insensitive' };
  if (filters.sentiment)         where.chatter_sentiment = filters.sentiment;
  if (filters.transcript_status) where.transcript_status = filters.transcript_status;
  if (filters.is_read !== undefined) where.is_read = Boolean(filters.is_read);

  return prisma.resultEvent.findMany({
    where,
    orderBy: [{ result_date: 'desc' }, { company_name: 'asc' }],
  });
}

async function updatePriceByCompany(companyName, price) {
  return prisma.resultEvent.updateMany({
    where: { company_name: companyName },
    data:  { price, updated_at: new Date().toISOString() },
  });
}

async function getDistinctCompanies() {
  const rows = await prisma.resultEvent.findMany({
    select:   { company_name: true },
    distinct: ['company_name'],
  });
  return rows.map(r => r.company_name);
}

async function updateChatterData(eventId, sentiment, summary, postLinks) {
  return prisma.resultEvent.update({
    where: { event_id: eventId },
    data: {
      chatter_sentiment: sentiment,
      chatter_summary:   summary,
      top_post_links:    postLinks,
      chatter_fetched:   true,
      updated_at:        new Date().toISOString(),
    },
  });
}

async function getPendingChatterEvents() {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  return prisma.resultEvent.findMany({
    where: {
      chatter_fetched: false,
      created_at: { lte: oneHourAgo },
    },
  });
}

async function getAllEventsForReanalysis() {
  return prisma.resultEvent.findMany({
    select:  { event_id: true, company_name: true },
    orderBy: { created_at: 'desc' },
  });
}

module.exports = {
  prisma,
  getEventById,
  upsertEvent,
  addPollingLog,
  getAllEvents,
  updatePriceByCompany,
  getDistinctCompanies,
  updateChatterData,
  getPendingChatterEvents,
  getAllEventsForReanalysis,
};
