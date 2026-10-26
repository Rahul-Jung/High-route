'use strict';
const crypto = require('crypto');

/** Read and parse a JSON request body. Resolves {} for empty bodies. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    const MAX = 1024 * 1024; // 1MB guard
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX) { reject(new Error('Body too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  });
  res.end(payload);
}

function ok(res, body) { sendJson(res, 200, body); }
function created(res, body) { sendJson(res, 201, body); }
function badRequest(res, message) { sendJson(res, 400, { error: message || 'Bad request' }); }
function unauthorized(res, message) { sendJson(res, 401, { error: message || 'Unauthorized' }); }
function forbidden(res, message) { sendJson(res, 403, { error: message || 'Forbidden' }); }
function notFound(res, message) { sendJson(res, 404, { error: message || 'Not found' }); }
function serverError(res, err) {
  console.error(err);
  sendJson(res, 500, { error: 'Internal server error' });
}

/** Password hashing via scrypt (Node core, no dependency). */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, hash, salt) {
  const check = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

/** SHA-256 of a token, hex-encoded — what we store for session lookups so the
 *  raw bearer token is never sitting in the database (see schema.sql). */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/** Tiny in-memory rate limiter for login endpoints (per key, e.g. "ip:email").
 *  Not shared across processes — fine for this single-process demo server;
 *  a real multi-instance deployment needs a shared store (Redis etc). */
const rateLimitHits = new Map();
function rateLimited(key, { max = 8, windowMs = 5 * 60 * 1000 } = {}) {
  const now = Date.now();
  const entry = rateLimitHits.get(key);
  if (!entry || now - entry.start > windowMs) {
    rateLimitHits.set(key, { count: 1, start: now });
    return false;
  }
  entry.count++;
  return entry.count > max;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// INPUT VALIDATORS
//
// Every one of these exists because an unvalidated value used to reach a bound
// SQLite parameter and surface as an opaque 500 ("datatype mismatch",
// "CHECK constraint failed", "Invalid time value") instead of a 400 the caller
// could actually act on. Rule of thumb for this codebase: a number, date or
// slug coming from a query string or request body is validated here *before*
// it is interpolated, bound or passed to Date arithmetic — never after.
// ---------------------------------------------------------------------------

// Deliberately pragmatic rather than RFC-5322 exhaustive: enough to catch the
// real failure mode (a typo'd address that silently swallows the signup
// verification code and locks the account out forever) without rejecting
// legitimate addresses.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/;
function isEmail(value) {
  return EMAIL_RE.test(String(value ?? '').trim());
}

/** True only for a real calendar date in 'YYYY-MM-DD' form — the single date
 *  format this app stores. Rejects both malformed text ('not-a-date') and
 *  impossible dates ('2026-02-31'), either of which previously reached
 *  computeEndDate() and threw a RangeError from toISOString(). */
function isIsoDate(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** URL-safe lowercase slug ('upper-mustang'). A slug ends up in public links
 *  (tour-detail.html?slug=…), so anything with whitespace or a path separator
 *  silently truncates the link at the first space and produces a dead page. */
function isSlug(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value ?? ''));
}

/** Validates one optional numeric field. Returns { value } — null when the
 *  field was absent — or { error } with a message naming the field. Never
 *  returns NaN, which is the whole point: NaN bound into SQLite raises
 *  "datatype mismatch" as a 500 rather than telling the caller what was wrong. */
function numericField(raw, label, { min = null, max = null, integer = true } = {}) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { error: `${label} must be a number` };
  if (integer && !Number.isInteger(n)) return { error: `${label} must be a whole number` };
  if (min !== null && n < min) return { error: `${label} must be ${min} or more` };
  if (max !== null && n > max) return { error: `${label} must be ${max} or less` };
  return { value: n };
}

/** Runs several numericField checks in one go.
 *  `specs` is { label: [rawValue, options] }. Returns { error } on the first
 *  failure, otherwise { values: { label: number|null } }. */
function validateNumbers(specs) {
  const values = {};
  for (const [label, [raw, options]] of Object.entries(specs)) {
    const result = numericField(raw, label, options);
    if (result.error) return { error: result.error };
    values[label] = result.value;
  }
  return { values };
}

/** Shape-checks a demo card and rejects an expiry that has already passed.
 *  There is no real payment gateway behind this (see README section 7), so
 *  these checks are the only thing standing between a typo and a "successful"
 *  charge — an expired card used to sail straight through. Returns
 *  { error } or { last4 }. */
function validateCard(card) {
  const c = card || {};
  const number = String(c.number || '').replace(/[\s-]+/g, '');
  if (!/^\d{13,19}$/.test(number)) return { error: 'Enter a valid card number' };
  const expiry = String(c.expiry || '').trim();
  const match = /^(0[1-9]|1[0-2])\/(\d{2})$/.exec(expiry);
  if (!match) return { error: 'Enter a valid expiry date (MM/YY)' };
  if (!/^\d{3,4}$/.test(String(c.cvv || '').trim())) return { error: 'Enter a valid CVV' };
  // A 2-digit year is read as 20xx — the same assumption every card form
  // makes. A card is valid through the *end* of its expiry month.
  const expMonth = Number(match[1]);
  const expYear = 2000 + Number(match[2]);
  const now = new Date();
  const lastValid = new Date(Date.UTC(expYear, expMonth, 1)); // first instant of the following month
  if (lastValid <= now) return { error: 'That card has expired — check the expiry date' };
  return { last4: number.slice(-4) };
}

module.exports = {
  readJsonBody, sendJson, ok, created, badRequest, unauthorized, forbidden, notFound, serverError,
  hashPassword, verifyPassword, newToken, hashToken, rateLimited, clientIp,
  isEmail, isIsoDate, isSlug, numericField, validateNumbers, validateCard,
};
