'use strict';
const { run, get } = require('../db');
const { newToken, hashToken, unauthorized } = require('./util');

const SESSION_HOURS = 24 * 7;      // riders / guides
const ADMIN_SESSION_HOURS = 12;    // shorter-lived — least-privilege for the CMS

function createSession(subjectType, subjectId) {
  const token = newToken();
  const hours = subjectType === 'admin' ? ADMIN_SESSION_HOURS : SESSION_HOURS;
  const expires = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  run('INSERT INTO sessions (token_hash, subject_type, subject_id, expires_at) VALUES (?,?,?,?)',
    [hashToken(token), subjectType, subjectId, expires]);
  return { token, expires_at: expires };
}

function getSession(token) {
  if (!token) return null;
  const row = get('SELECT * FROM sessions WHERE token_hash = ?', [hashToken(token)]);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  return row;
}

function destroySession(token) {
  if (!token) return;
  run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
}

function tokenFromRequest(req) {
  const header = req.headers['authorization'] || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/** Returns the session for a request, or null. Reads "Authorization: Bearer <token>". */
function sessionFromRequest(req) {
  return getSession(tokenFromRequest(req));
}

/** Wrap a handler so it 401s unless a valid session of the given type is present.
 *  Attaches req.session = { subject_type, subject_id, token }. */
function requireAuth(subjectType, handler) {
  return (req, res) => {
    const session = sessionFromRequest(req);
    if (!session || (subjectType && session.subject_type !== subjectType)) {
      return unauthorized(res, 'Sign in required');
    }
    req.session = session;
    return handler(req, res);
  };
}

/** Admin routes: a real, short-lived admin session (see routes/auth.js
 *  POST /api/admin/login) — replaces the old single shared bearer token. */
function requireAdmin(handler) {
  return requireAuth('admin', handler);
}

module.exports = {
  createSession, getSession, destroySession, sessionFromRequest, tokenFromRequest,
  requireAuth, requireAdmin,
};
