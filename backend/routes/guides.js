'use strict';
const { all, get, run } = require('../db');
const { ok, created, badRequest, notFound, hashPassword, isEmail, validateNumbers } = require('../lib/util');
const { requireAdmin, sessionFromRequest } = require('../lib/auth');

// What an anonymous visitor is allowed to see about a guide. Note what is NOT
// here: `email`. It used to be, which meant the completely public
// GET /api/guides handed every visitor each guide's real work address — which
// is also the identifier half of their login (see POST /api/guide/login).
const PUBLIC_FIELDS = 'id, name, role, years_experience, languages, specialties, rating, trips_led, bio, photo_url, qualifications_json';
// The admin panel genuinely needs the email (to show and edit it) and the
// unverified qualifications (to review them) — so it gets its own, wider
// selection, behind an admin session.
const ADMIN_FIELDS = PUBLIC_FIELDS + ', email';

/** Turns a raw `guides` row into the shape the API sends: qualifications_json
 *  parsed into a real `qualifications` array.
 *
 *  Unverified qualifications are dropped unless the caller is an admin. The
 *  frontend has always filtered them out at render time, but they were still
 *  sitting in the public JSON — so an unverified claim an admin had recorded
 *  but not yet checked was one devtools Network tab away from being readable,
 *  which is the opposite of the point of having a `verified` flag. */
function toGuide(row, { includeUnverified = false } = {}) {
  const { qualifications_json, ...rest } = row;
  let qualifications = [];
  try { qualifications = JSON.parse(qualifications_json || '[]'); } catch { /* malformed — treat as none */ }
  if (!includeUnverified) qualifications = qualifications.filter(q => q && q.verified);
  return { ...rest, qualifications };
}

/** Back-compat alias: routes/tours.js embeds guide profiles on a public tour
 *  page, so it wants the public (verified-only, no email) shape. */
function toPublicGuide(row) {
  return toGuide(row, { includeUnverified: false });
}

function register(router) {
  // GET /api/guides — public profiles (brief section 35). An admin session
  // gets the fuller admin shape from the same URL, so the admin panel's
  // guides tab and the public site don't need two different endpoints.
  router.get('/api/guides', (req, res) => {
    const session = sessionFromRequest(req);
    const isAdmin = session && session.subject_type === 'admin';
    const fields = isAdmin ? ADMIN_FIELDS : PUBLIC_FIELDS;
    const rows = all(`SELECT ${fields} FROM guides ORDER BY years_experience DESC`);
    ok(res, { guides: rows.map(r => toGuide(r, { includeUnverified: isAdmin })) });
  });

  // POST /api/admin/guides
  router.post('/api/admin/guides', requireAdmin((req, res) => {
    const b = req.body || {};
    if (!b.name || !b.role) return badRequest(res, 'name and role are required');
    // guides.languages is NOT NULL in schema.sql, so omitting it used to pass
    // `null` straight through and surface as a bare 500 instead of saying
    // which field was missing. Same reason the numbers below are range-checked
    // rather than handed to SQLite as-is.
    if (!String(b.languages || '').trim()) return badRequest(res, 'languages is required (e.g. "Nepali, English")');
    if (b.email !== undefined && b.email !== null && b.email !== '' && !isEmail(b.email)) {
      return badRequest(res, 'That guide email address doesn\'t look right');
    }
    if (b.email && get('SELECT id FROM guides WHERE email = ? COLLATE NOCASE', [String(b.email).trim()])) {
      return badRequest(res, 'Another guide already uses this email address');
    }
    const nums = validateNumbers({
      yearsExperience: [b.yearsExperience, { min: 0, max: 80 }],
      tripsLed: [b.tripsLed, { min: 0, max: 100000 }],
      rating: [b.rating, { min: 0, max: 5, integer: false }],
    });
    if (nums.error) return badRequest(res, nums.error);
    let passHash = null, passSalt = null;
    if (b.password) { const p = hashPassword(b.password); passHash = p.hash; passSalt = p.salt; }
    const id = run(
      `INSERT INTO guides (name, role, years_experience, languages, specialties, rating, trips_led, bio, photo_url, qualifications_json, email, password_hash, password_salt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [b.name, b.role, nums.values.yearsExperience ?? 0, String(b.languages).trim(), b.specialties || null,
       nums.values.rating ?? 5.0, nums.values.tripsLed ?? 0, b.bio || null, b.photoUrl || null,
       JSON.stringify(Array.isArray(b.qualifications) ? b.qualifications : []),
       b.email ? String(b.email).trim() : null, passHash, passSalt]
    ).lastInsertRowid;
    created(res, toGuide(get(`SELECT ${ADMIN_FIELDS} FROM guides WHERE id = ?`, [id]), { includeUnverified: true }));
  }));

  // PATCH /api/admin/guides/:id
  router.patch('/api/admin/guides/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM guides WHERE id = ?', [Number(req.params.id)]);
    if (!row) return notFound(res, 'Guide not found');
    const b = req.body || {};
    // An edit goes through the same checks as a create — COALESCE already
    // protects languages from being nulled out, but the numeric ranges and
    // the email format/uniqueness need checking here too.
    if (b.languages !== undefined && !String(b.languages || '').trim()) {
      return badRequest(res, 'languages cannot be empty');
    }
    if (b.email !== undefined && b.email !== null && b.email !== '' && !isEmail(b.email)) {
      return badRequest(res, 'That guide email address doesn\'t look right');
    }
    if (b.email) {
      const clash = get('SELECT id FROM guides WHERE email = ? COLLATE NOCASE AND id != ?', [String(b.email).trim(), row.id]);
      if (clash) return badRequest(res, 'Another guide already uses this email address');
    }
    const nums = validateNumbers({
      yearsExperience: [b.yearsExperience, { min: 0, max: 80 }],
      tripsLed: [b.tripsLed, { min: 0, max: 100000 }],
      rating: [b.rating, { min: 0, max: 5, integer: false }],
    });
    if (nums.error) return badRequest(res, nums.error);
    run(`UPDATE guides SET name=COALESCE(?,name), role=COALESCE(?,role), years_experience=COALESCE(?,years_experience),
         languages=COALESCE(?,languages), specialties=COALESCE(?,specialties), rating=COALESCE(?,rating),
         trips_led=COALESCE(?,trips_led), bio=COALESCE(?,bio), photo_url=COALESCE(?,photo_url),
         qualifications_json=COALESCE(?,qualifications_json), email=COALESCE(?,email) WHERE id=?`,
      [b.name || null, b.role || null, nums.values.yearsExperience, b.languages || null, b.specialties || null,
       nums.values.rating, nums.values.tripsLed, b.bio || null, b.photoUrl || null,
       Array.isArray(b.qualifications) ? JSON.stringify(b.qualifications) : null,
       b.email ? String(b.email).trim() : null, row.id]);
    ok(res, toGuide(get(`SELECT ${ADMIN_FIELDS} FROM guides WHERE id = ?`, [row.id]), { includeUnverified: true }));
  }));

  // DELETE /api/admin/guides/:id
  router.delete('/api/admin/guides/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM guides WHERE id = ?', [Number(req.params.id)]);
    if (!row) return notFound(res, 'Guide not found');
    const inUse = get('SELECT COUNT(*) n FROM departures WHERE guide_id = ?', [row.id]).n;
    if (inUse > 0) return badRequest(res, 'This guide is assigned to ' + inUse + ' departure(s) — reassign those first.');
    run('DELETE FROM guides WHERE id = ?', [row.id]);
    ok(res, { deleted: true });
  }));
}

module.exports = { register, PUBLIC_FIELDS, ADMIN_FIELDS, toGuide, toPublicGuide };
