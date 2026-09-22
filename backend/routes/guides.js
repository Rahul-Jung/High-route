'use strict';
const { all, get, run } = require('../db');
const { ok, created, badRequest, notFound, hashPassword } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');

const PUBLIC_FIELDS = 'id, name, role, years_experience, languages, specialties, rating, trips_led, bio, photo_url, qualifications_json, email';

/** Turns a raw `guides` row (selected with PUBLIC_FIELDS) into the shape
 *  every API response actually sends: qualifications_json parsed into a
 *  real `qualifications` array. Verified-only filtering for public display
 *  is a frontend concern (see main.js) — the admin panel needs to see and
 *  edit unverified entries too, so the API itself doesn't drop them. */
function toPublicGuide(row) {
  const { qualifications_json, ...rest } = row;
  let qualifications = [];
  try { qualifications = JSON.parse(qualifications_json || '[]'); } catch { /* malformed — treat as none */ }
  return { ...rest, qualifications };
}

function register(router) {
  // GET /api/guides — public profiles (brief section 35)
  router.get('/api/guides', (req, res) => {
    ok(res, { guides: all(`SELECT ${PUBLIC_FIELDS} FROM guides ORDER BY years_experience DESC`).map(toPublicGuide) });
  });

  // POST /api/admin/guides
  router.post('/api/admin/guides', requireAdmin((req, res) => {
    const b = req.body || {};
    if (!b.name || !b.role) return badRequest(res, 'name and role are required');
    let passHash = null, passSalt = null;
    if (b.password) { const p = hashPassword(b.password); passHash = p.hash; passSalt = p.salt; }
    const id = run(
      `INSERT INTO guides (name, role, years_experience, languages, specialties, rating, trips_led, bio, photo_url, qualifications_json, email, password_hash, password_salt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [b.name, b.role, b.yearsExperience || 0, b.languages || null, b.specialties || null, b.rating || 5.0,
       b.tripsLed || 0, b.bio || null, b.photoUrl || null, JSON.stringify(Array.isArray(b.qualifications) ? b.qualifications : []),
       b.email || null, passHash, passSalt]
    ).lastInsertRowid;
    created(res, toPublicGuide(get(`SELECT ${PUBLIC_FIELDS} FROM guides WHERE id = ?`, [id])));
  }));

  // PATCH /api/admin/guides/:id
  router.patch('/api/admin/guides/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM guides WHERE id = ?', [Number(req.params.id)]);
    if (!row) return notFound(res, 'Guide not found');
    const b = req.body || {};
    run(`UPDATE guides SET name=COALESCE(?,name), role=COALESCE(?,role), years_experience=COALESCE(?,years_experience),
         languages=COALESCE(?,languages), specialties=COALESCE(?,specialties), rating=COALESCE(?,rating),
         trips_led=COALESCE(?,trips_led), bio=COALESCE(?,bio), photo_url=COALESCE(?,photo_url),
         qualifications_json=COALESCE(?,qualifications_json), email=COALESCE(?,email) WHERE id=?`,
      [b.name || null, b.role || null, b.yearsExperience ?? null, b.languages || null, b.specialties || null,
       b.rating ?? null, b.tripsLed ?? null, b.bio || null, b.photoUrl || null,
       Array.isArray(b.qualifications) ? JSON.stringify(b.qualifications) : null, b.email || null, row.id]);
    ok(res, toPublicGuide(get(`SELECT ${PUBLIC_FIELDS} FROM guides WHERE id = ?`, [row.id])));
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

module.exports = { register, PUBLIC_FIELDS, toPublicGuide };
