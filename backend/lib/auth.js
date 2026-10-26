'use strict';
const { run, get } = require('../db');
const { newToken, hashToken, unauthorized, forbidden } = require('./util');

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

/** Human-readable name for a role, used in the permission message below. */
const ROLE_LABEL = { rider: 'a rider', guide: 'a guide', admin: 'an administrator' };

/** Wrap a handler so it rejects unless a valid session of one of `subjectTypes`
 *  is present. Pass null/[] to accept any signed-in role.
 *  Attaches req.session = { subject_type, subject_id, token }.
 *
 *  401 vs 403 matters here, and used to be conflated: "no session at all" is a
 *  401 (sign in and retry), but "signed in as the wrong role" is a 403 — it is
 *  not fixable by signing in again, and telling a signed-in person to "sign in"
 *  sends them round a loop they can't escape. Dashboards that treat 401 as
 *  "session died, sign out" (see admin.html's api()) would also have logged an
 *  admin out over what was really a permissions mistake. */
function requireRoles(subjectTypes, handler) {
  const allowed = Array.isArray(subjectTypes) ? subjectTypes : (subjectTypes ? [subjectTypes] : []);
  return (req, res) => {
    const session = sessionFromRequest(req);
    if (!session) return unauthorized(res, 'Sign in required');
    if (allowed.length && !allowed.includes(session.subject_type)) {
      const need = allowed.map(r => ROLE_LABEL[r] || r).join(' or ');
      return forbidden(res, `You're signed in, but this needs ${need} account.`);
    }
    req.session = session;
    return handler(req, res);
  };
}

/** Single-role form — the shape every existing call site already uses. */
function requireAuth(subjectType, handler) {
  return requireRoles(subjectType, handler);
}

/** Admin routes: a real, short-lived admin session (see routes/auth.js
 *  POST /api/admin/login) — replaces the old single shared bearer token. */
function requireAdmin(handler) {
  return requireRoles('admin', handler);
}

module.exports = {
  createSession, getSession, destroySession, sessionFromRequest, tokenFromRequest,
  requireAuth, requireRoles, requireAdmin,
};
