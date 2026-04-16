'use strict';

const { HAS_USERS, ADMIN_KEY } = require('../lib/config');

// ─── Session guard ────────────────────────────────────────────────────────────
// Skips auth entirely when no USERS are configured (public mode).
function sessionGuard(req, res, next) {
  if (!HAS_USERS) return next();

  const publicPaths = ['/login', '/logout', '/userguide.html'];
  if (publicPaths.includes(req.path)) return next();

  if (req.session?.user) return next();

  // Admin key alone is sufficient (no session required)
  const adminKey = req.headers['x-admin-key'] || req.query.admin_key;
  if (adminKey && adminKey === ADMIN_KEY) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  }

  res.redirect('/login');
}

// ─── Admin key check ──────────────────────────────────────────────────────────
// Returns true if valid, sends 403 and returns false otherwise.
function requireAdmin(req, res) {
  const key = req.headers['x-admin-key'] || req.query.admin_key;
  if (key !== ADMIN_KEY) {
    res.status(403).json({ error: 'Admin access required.' });
    return false;
  }
  return true;
}

module.exports = { sessionGuard, requireAdmin };
