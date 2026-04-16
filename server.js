'use strict';

const path    = require('path');
const express = require('express');
const cors    = require('cors');
const session = require('express-session');

const { PORT, SESSION_SECRET, ADMIN_KEY, HAS_USERS, USERS } = require('./lib/config');
const { log }            = require('./lib/logger');
const { sessionGuard }   = require('./middleware/auth');
const authRoutes         = require('./routes/auth');
const apiRoutes          = require('./routes/api');
const { startPolling }   = require('./lib/scheduler');

// ─── Express app ──────────────────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: [
    'https://results-radar.netlify.app',
    /^http:\/\/localhost(:\d+)?$/,
  ],
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(session({
  secret:            SESSION_SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    sameSite: 'lax',
  },
}));

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(sessionGuard);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/', authRoutes);
app.use('/api', apiRoutes);

// Explicit route for user guide (must be before SPA fallback)
app.get('/userguide', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'userguide.html'));
});

// Static files (compiled React frontend)
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback — serve index.html for any non-API, non-file route
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found.' });
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
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
