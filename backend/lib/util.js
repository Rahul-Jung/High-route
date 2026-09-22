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

module.exports = {
  readJsonBody, sendJson, ok, created, badRequest, unauthorized, forbidden, notFound, serverError,
  hashPassword, verifyPassword, newToken, hashToken, rateLimited, clientIp,
};
