'use strict';
const { get, run } = require('../db');
const { created, badRequest } = require('../lib/util');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function register(router) {
  // POST /api/newsletter  { email } — homepage "Don't miss a departure" signup
  router.post('/api/newsletter', (req, res) => {
    const email = String((req.body || {}).email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return badRequest(res, 'A valid email is required');
    if (!get('SELECT id FROM newsletter_subscribers WHERE email = ?', [email])) {
      run('INSERT INTO newsletter_subscribers (email) VALUES (?)', [email]);
    }
    created(res, { subscribed: true });
  });
}

module.exports = { register };
