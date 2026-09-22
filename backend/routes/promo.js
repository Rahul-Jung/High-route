'use strict';
const { all, get, run } = require('../db');
const { ok, created, badRequest, notFound } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');

/** The single source of truth for whether a promo code applies and how much
 *  it's worth — used by both the pre-checkout preview endpoint below AND
 *  routes/bookings.js at actual booking creation, so a discount is never
 *  computed differently (or trusted from the client) at the two call sites.
 *  subtotalCents is the caller's own server-computed base+addons total —
 *  never a client-supplied number when called from booking creation. */
function evaluatePromoCode(code, { tourId, riderCount, subtotalCents }) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return { valid: false, error: 'Enter a promo code' };
  const promo = get('SELECT * FROM promo_codes WHERE code = ?', [normalized]);
  if (!promo || !promo.active) return { valid: false, error: 'This promo code doesn\'t exist or is no longer active' };
  const now = new Date();
  if (promo.valid_from && now < new Date(promo.valid_from)) return { valid: false, error: 'This promo code isn\'t active yet' };
  if (promo.valid_until && now > new Date(promo.valid_until)) return { valid: false, error: 'This promo code has expired' };
  if (promo.max_uses != null && promo.used_count >= promo.max_uses) return { valid: false, error: 'This promo code has reached its usage limit' };
  if (promo.min_riders != null && riderCount < promo.min_riders) {
    return { valid: false, error: `This promo code needs at least ${promo.min_riders} rider(s) on the booking` };
  }
  if (promo.tour_id != null && promo.tour_id !== tourId) {
    return { valid: false, error: 'This promo code isn\'t valid for this tour' };
  }
  const discountCents = promo.discount_type === 'percent'
    ? Math.round(subtotalCents * (promo.discount_value / 100))
    : Math.min(promo.discount_value, subtotalCents);
  return { valid: true, promo, discount_cents: Math.max(0, discountCents) };
}

function register(router) {
  // POST /api/promo/validate  { code, tourId, riderCount, subtotalCents }
  // A preview only — nothing is redeemed/incremented here. Public (no auth
  // required) since it's read-only and a rider may want to check a code
  // before signing in. The real, binding calculation happens again from
  // scratch inside POST /api/bookings using the server's own subtotal.
  router.post('/api/promo/validate', (req, res) => {
    const b = req.body || {};
    const result = evaluatePromoCode(b.code, {
      tourId: b.tourId ? Number(b.tourId) : null,
      riderCount: Number(b.riderCount) || 1,
      subtotalCents: Number(b.subtotalCents) || 0,
    });
    if (!result.valid) return badRequest(res, result.error);
    ok(res, { valid: true, code: result.promo.code, description: result.promo.description, discount_cents: result.discount_cents });
  });

  // GET /api/admin/promo-codes
  router.get('/api/admin/promo-codes', requireAdmin((req, res) => {
    const rows = all(
      `SELECT pc.*, t.name AS tour_name FROM promo_codes pc LEFT JOIN tours t ON t.id = pc.tour_id ORDER BY pc.created_at DESC`);
    ok(res, { count: rows.length, promo_codes: rows });
  }));

  // POST /api/admin/promo-codes
  router.post('/api/admin/promo-codes', requireAdmin((req, res) => {
    const b = req.body || {};
    if (!b.code || !b.discountType || b.discountValue == null) {
      return badRequest(res, 'code, discountType and discountValue are required');
    }
    if (!['percent', 'fixed'].includes(b.discountType)) return badRequest(res, "discountType must be 'percent' or 'fixed'");
    const value = Number(b.discountValue);
    if (b.discountType === 'percent' && !(value > 0 && value <= 100)) return badRequest(res, 'A percent discount must be between 1 and 100');
    if (b.discountType === 'fixed' && !(value > 0)) return badRequest(res, 'A fixed discount must be a positive number of cents');
    const code = String(b.code).trim().toUpperCase();
    if (get('SELECT id FROM promo_codes WHERE code = ?', [code])) return badRequest(res, 'A promo code with this code already exists');
    const id = run(
      `INSERT INTO promo_codes (code, description, discount_type, discount_value, max_uses, min_riders, tour_id, valid_from, valid_until, active)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [code, b.description || null, b.discountType, Math.round(value), b.maxUses || null, b.minRiders || null,
       b.tourId || null, b.validFrom || null, b.validUntil || null, b.active === false ? 0 : 1]
    ).lastInsertRowid;
    created(res, get('SELECT * FROM promo_codes WHERE id = ?', [id]));
  }));

  // PATCH /api/admin/promo-codes/:id
  router.patch('/api/admin/promo-codes/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM promo_codes WHERE id = ?', [Number(req.params.id)]);
    if (!row) return notFound(res, 'Promo code not found');
    const b = req.body || {};
    if (b.discountType && !['percent', 'fixed'].includes(b.discountType)) return badRequest(res, "discountType must be 'percent' or 'fixed'");
    run(`UPDATE promo_codes SET description=COALESCE(?,description), discount_type=COALESCE(?,discount_type),
         discount_value=COALESCE(?,discount_value), max_uses=CASE WHEN ? THEN ? ELSE max_uses END,
         min_riders=CASE WHEN ? THEN ? ELSE min_riders END, tour_id=CASE WHEN ? THEN ? ELSE tour_id END,
         valid_from=COALESCE(?,valid_from), valid_until=COALESCE(?,valid_until), active=COALESCE(?,active) WHERE id=?`,
      [b.description || null, b.discountType || null, b.discountValue != null ? Math.round(Number(b.discountValue)) : null,
       Object.prototype.hasOwnProperty.call(b, 'maxUses') ? 1 : 0, b.maxUses ?? null,
       Object.prototype.hasOwnProperty.call(b, 'minRiders') ? 1 : 0, b.minRiders ?? null,
       Object.prototype.hasOwnProperty.call(b, 'tourId') ? 1 : 0, b.tourId ?? null,
       b.validFrom || null, b.validUntil || null, b.active === undefined ? null : (b.active ? 1 : 0), row.id]);
    ok(res, get('SELECT * FROM promo_codes WHERE id = ?', [row.id]));
  }));

  // DELETE /api/admin/promo-codes/:id — only if never redeemed, so a
  // booking that already used it keeps a resolvable promo_code_id; retire
  // an in-use code with PATCH { active: false } instead.
  router.delete('/api/admin/promo-codes/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM promo_codes WHERE id = ?', [Number(req.params.id)]);
    if (!row) return notFound(res, 'Promo code not found');
    if (row.used_count > 0) return badRequest(res, 'This code has already been used on ' + row.used_count + ' booking(s) — deactivate it instead of deleting.');
    run('DELETE FROM promo_codes WHERE id = ?', [row.id]);
    ok(res, { deleted: true });
  }));
}

module.exports = { register, evaluatePromoCode };
