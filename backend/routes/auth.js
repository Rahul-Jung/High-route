'use strict';
const crypto = require('crypto');
const { get, run } = require('../db');
const { ok, created, badRequest, unauthorized, sendJson, hashPassword, verifyPassword, hashToken, rateLimited, clientIp } = require('../lib/util');
const { createSession, destroySession, tokenFromRequest, requireAuth } = require('../lib/auth');
const { sendVerificationEmail } = require('../lib/email');

const VERIFICATION_MINUTES = 15;
const VERIFICATION_MAX_ATTEMPTS = 5;

// Shared brute-force guard for every login endpoint below: 8 attempts per
// 5 minutes per (ip + email). Keyed on the *attempted* email so one IP can't
// lock everyone else out, and cheap enough it doesn't need a real store here.
function loginRateLimited(req, email) {
  return rateLimited('login:' + clientIp(req) + ':' + String(email || '').toLowerCase());
}

/** Generates a fresh 6-digit code for `rider`, replacing any code already
 *  outstanding for them (so an old email/screen never has a code that still
 *  works once a newer one's been issued), and emails it. Shared by register
 *  and the resend endpoint below. */
async function issueVerificationCode(rider) {
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + VERIFICATION_MINUTES * 60 * 1000).toISOString();
  run('DELETE FROM email_verifications WHERE rider_id = ?', [rider.id]);
  run('INSERT INTO email_verifications (rider_id, code_hash, expires_at) VALUES (?,?,?)', [rider.id, hashToken(code), expiresAt]);
  await sendVerificationEmail(rider.email, rider.name, code);
}

function register(router) {
  // POST /api/auth/register  { name, email, password, country, phone }
  // Deliberately does NOT return a session — signup verification is
  // mandatory (see POST /api/auth/verify-email below), so the account exists
  // but can't sign in until the emailed code is entered. This also means a
  // half-finished signup (code never entered) just sits unverified forever;
  // nothing else in the app treats an unverified rider as real (login and
  // every requireAuth('rider') route reject them).
  router.post('/api/auth/register', async (req, res) => {
    const b = req.body || {};
    if (!b.email || !b.password || !b.name) return badRequest(res, 'name, email and password are required');
    if (String(b.password).length < 8) return badRequest(res, 'password must be at least 8 characters');
    if (get('SELECT id FROM riders WHERE email = ?', [b.email])) return badRequest(res, 'An account with this email already exists');
    const { hash, salt } = hashPassword(b.password);
    const id = run(
      `INSERT INTO riders (name, email, phone, country, riding_experience, password_hash, password_salt)
       VALUES (?,?,?,?,?,?,?)`,
      [b.name, b.email, b.phone || null, b.country || null, b.ridingExperience || null, hash, salt]
    ).lastInsertRowid;
    await issueVerificationCode({ id, email: b.email, name: b.name });
    created(res, {
      pending_verification: true, rider: { id, name: b.name, email: b.email },
      message: 'Check your email for a 6-digit verification code to activate your account.',
    });
  });

  // POST /api/auth/verify-email  { email, code }
  router.post('/api/auth/verify-email', (req, res) => {
    const { email, code } = req.body || {};
    if (!email || !code) return badRequest(res, 'email and code are required');
    if (rateLimited('verify:' + clientIp(req) + ':' + String(email).toLowerCase())) {
      return sendJson(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    }
    const rider = get('SELECT * FROM riders WHERE email = ?', [email]);
    if (!rider) return badRequest(res, 'Invalid email or code');
    // Already verified (e.g. they verified in another tab, or replayed an
    // old email) — just let them straight in rather than erroring.
    if (rider.email_verified_at) {
      const session = createSession('rider', rider.id);
      return ok(res, { rider: { id: rider.id, name: rider.name, email: rider.email }, ...session });
    }
    const pending = get('SELECT * FROM email_verifications WHERE rider_id = ? ORDER BY id DESC LIMIT 1', [rider.id]);
    if (!pending) return badRequest(res, 'No verification code is pending for this account — request a new one.');
    if (new Date(pending.expires_at) < new Date()) return badRequest(res, 'This code has expired — request a new one.');
    if (pending.attempts >= VERIFICATION_MAX_ATTEMPTS) return badRequest(res, 'Too many incorrect attempts — request a new code.');
    if (hashToken(String(code)) !== pending.code_hash) {
      run('UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?', [pending.id]);
      return badRequest(res, 'Incorrect code');
    }
    run(`UPDATE riders SET email_verified_at = datetime('now') WHERE id = ?`, [rider.id]);
    run('DELETE FROM email_verifications WHERE rider_id = ?', [rider.id]);
    const session = createSession('rider', rider.id);
    ok(res, { rider: { id: rider.id, name: rider.name, email: rider.email }, ...session });
  });

  // POST /api/auth/resend-verification  { email }
  router.post('/api/auth/resend-verification', async (req, res) => {
    const { email } = req.body || {};
    if (!email) return badRequest(res, 'email is required');
    if (rateLimited('resend-verify:' + clientIp(req) + ':' + String(email).toLowerCase(), { max: 3, windowMs: 15 * 60 * 1000 })) {
      return sendJson(res, 429, { error: 'Too many requests. Try again in a few minutes.' });
    }
    const rider = get('SELECT * FROM riders WHERE email = ?', [email]);
    if (!rider) return badRequest(res, 'No account with this email');
    if (rider.email_verified_at) return badRequest(res, 'This email is already verified — sign in instead.');
    await issueVerificationCode(rider);
    ok(res, { sent: true });
  });

  // POST /api/auth/login  { email, password }
  router.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body || {};
    if (loginRateLimited(req, email)) return res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Too many attempts. Try again in a few minutes.' }));
    const rider = get('SELECT * FROM riders WHERE email = ?', [email || '']);
    if (!rider || !verifyPassword(password || '', rider.password_hash, rider.password_salt)) {
      return unauthorized(res, 'Invalid email or password');
    }
    if (!rider.email_verified_at) {
      return sendJson(res, 403, { error: 'Please verify your email before signing in.', needs_verification: true, email: rider.email });
    }
    const session = createSession('rider', rider.id);
    ok(res, { rider: { id: rider.id, name: rider.name, email: rider.email }, ...session });
  });

  const RIDER_PROFILE_FIELDS = 'id, name, email, phone, country, riding_experience, preferred_style, bike_info, emergency_contact_name, emergency_contact_phone, created_at';

  // GET /api/riders/me — rider dashboard profile + next upcoming trip (brief section 17)
  router.get('/api/riders/me', requireAuth('rider', (req, res) => {
    const rider = get(`SELECT ${RIDER_PROFILE_FIELDS} FROM riders WHERE id = ?`, [req.session.subject_id]);
    const upcoming = get(
      `SELECT b.id AS booking_id, d.start_date, d.end_date, t.name AS tour_name, g.name AS guide_name
       FROM bookings b JOIN departures d ON d.id = b.departure_id JOIN tours t ON t.id = d.tour_id
       LEFT JOIN guides g ON g.id = d.guide_id
       WHERE b.lead_rider_id = ? AND date(d.start_date) >= date('now') AND b.status != 'cancelled'
       ORDER BY d.start_date ASC LIMIT 1`, [rider.id]);
    ok(res, { rider, upcoming_adventure: upcoming || null });
  }));

  // PATCH /api/riders/me — self-service profile edit. Email/password are
  // deliberately not editable here (email is the login identifier; password
  // has its own endpoint below so a current-password check is required).
  router.patch('/api/riders/me', requireAuth('rider', (req, res) => {
    const b = req.body || {};
    const fieldMap = {
      name: 'name', phone: 'phone', country: 'country', ridingExperience: 'riding_experience',
      preferredStyle: 'preferred_style', bikeInfo: 'bike_info',
      emergencyContactName: 'emergency_contact_name', emergencyContactPhone: 'emergency_contact_phone',
    };
    const sets = [];
    const params = [];
    for (const [key, col] of Object.entries(fieldMap)) {
      if (b[key] !== undefined) { sets.push(col + ' = ?'); params.push(b[key] || null); }
    }
    if (b.name !== undefined && !String(b.name).trim()) return badRequest(res, 'name cannot be empty');
    if (sets.length === 0) return badRequest(res, 'No recognised fields to update');
    params.push(req.session.subject_id);
    run(`UPDATE riders SET ${sets.join(', ')} WHERE id = ?`, params);
    ok(res, get(`SELECT ${RIDER_PROFILE_FIELDS} FROM riders WHERE id = ?`, [req.session.subject_id]));
  }));

  // PATCH /api/riders/me/password  { currentPassword, newPassword }
  router.patch('/api/riders/me/password', requireAuth('rider', (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return badRequest(res, 'currentPassword and newPassword are required');
    if (String(newPassword).length < 8) return badRequest(res, 'newPassword must be at least 8 characters');
    const rider = get('SELECT * FROM riders WHERE id = ?', [req.session.subject_id]);
    if (!verifyPassword(currentPassword, rider.password_hash, rider.password_salt)) {
      return unauthorized(res, 'Current password is incorrect');
    }
    const { hash, salt } = hashPassword(newPassword);
    run('UPDATE riders SET password_hash = ?, password_salt = ? WHERE id = ?', [hash, salt, rider.id]);
    ok(res, { updated: true });
  }));

  // POST /api/guide/login  { email, password }
  router.post('/api/guide/login', (req, res) => {
    const { email, password } = req.body || {};
    if (loginRateLimited(req, email)) return res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Too many attempts. Try again in a few minutes.' }));
    const guide = get('SELECT * FROM guides WHERE email = ?', [email || '']);
    if (!guide || !guide.password_hash || !verifyPassword(password || '', guide.password_hash, guide.password_salt)) {
      return unauthorized(res, 'Invalid email or password. (Demo guides have no password set — see README to set one.)');
    }
    const session = createSession('guide', guide.id);
    ok(res, { guide: { id: guide.id, name: guide.name }, ...session });
  });

  // POST /api/admin/login  { email, password } — replaces the old shared static admin token.
  router.post('/api/admin/login', (req, res) => {
    const { email, password } = req.body || {};
    if (loginRateLimited(req, email)) return res.writeHead(429, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Too many attempts. Try again in a few minutes.' }));
    const admin = get('SELECT * FROM admins WHERE email = ?', [email || '']);
    if (!admin || !verifyPassword(password || '', admin.password_hash, admin.password_salt)) {
      return unauthorized(res, 'Invalid email or password');
    }
    const session = createSession('admin', admin.id);
    ok(res, { admin: { id: admin.id, name: admin.name, email: admin.email }, ...session });
  });

  // DELETE /api/auth/session — sign out from any role; invalidates the bearer
  // token server-side immediately instead of letting it sit valid until expiry.
  router.delete('/api/auth/session', (req, res) => {
    destroySession(tokenFromRequest(req));
    ok(res, { signed_out: true });
  });
}

module.exports = { register };
