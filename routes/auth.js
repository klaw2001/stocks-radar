'use strict';

const express           = require('express');
const { USERS, HAS_USERS } = require('../lib/config');
const { log }           = require('../lib/logger');

const router = express.Router();

// GET /login
router.get('/login', (req, res) => {
  if (req.session?.user && HAS_USERS) return res.redirect('/');
  res.sendFile(require('path').join(__dirname, '..', 'public', 'login.html'));
});

// POST /login
router.post('/login', (req, res) => {
  if (!HAS_USERS) return res.redirect('/');
  const { username, password } = req.body || {};
  if (username && USERS[username] && USERS[username] === password) {
    req.session.user = username;
    log('auth', `✓ Login: "${username}"`);
    res.redirect('/');
  } else {
    log('auth', `✗ Failed login attempt: "${username}"`);
    res.redirect('/login?error=1');
  }
});

// POST /logout
router.post('/logout', (req, res) => {
  log('auth', `Logout: "${req.session?.user}"`);
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
