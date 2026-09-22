'use strict';
const { all, get, run } = require('../db');
const { ok, created, badRequest, notFound } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');

function register(router) {
  // GET /api/addons — the published, admin-priced add-on catalog. Checkout
  // always reads prices from here, never from a hardcoded frontend value.
  router.get('/api/addons', (req, res) => {
    const rows = all('SELECT * FROM addon_catalog WHERE active = 1 ORDER BY sort_order ASC, label ASC');
    ok(res, { count: rows.length, addons: rows });
  });

  // GET /api/admin/addons — every add-on, including inactive ones, for the
  // admin catalog editor (the public GET /api/addons only returns active=1).
  router.get('/api/admin/addons', requireAdmin((req, res) => {
    const rows = all('SELECT * FROM addon_catalog ORDER BY sort_order ASC, label ASC');
    ok(res, { count: rows.length, addons: rows });
  }));

  // POST /api/admin/addons
  router.post('/api/admin/addons', requireAdmin((req, res) => {
    const b = req.body || {};
    if (!b.key || !b.label || b.priceCents == null) return badRequest(res, 'key, label and priceCents are required');
    if (!/^[a-z0-9_]+$/.test(b.key)) return badRequest(res, 'key must be lowercase letters, numbers and underscores only');
    if (!(Number(b.priceCents) >= 0)) return badRequest(res, 'priceCents must be a non-negative number');
    if (b.unit && !['per_rider', 'per_booking'].includes(b.unit)) return badRequest(res, "unit must be 'per_rider' or 'per_booking'");
    if (get('SELECT id FROM addon_catalog WHERE key = ?', [b.key])) return badRequest(res, 'An add-on with this key already exists');
    const id = run(
      `INSERT INTO addon_catalog (key, label, description, price_cents, unit, active, sort_order) VALUES (?,?,?,?,?,?,?)`,
      [b.key, b.label, b.description || null, Math.round(Number(b.priceCents)), b.unit || 'per_rider',
       b.active === false ? 0 : 1, b.sortOrder || 0]
    ).lastInsertRowid;
    created(res, get('SELECT * FROM addon_catalog WHERE id = ?', [id]));
  }));

  // PATCH /api/admin/addons/:id
  router.patch('/api/admin/addons/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM addon_catalog WHERE id = ?', [Number(req.params.id)]);
    if (!row) return notFound(res, 'Add-on not found');
    const b = req.body || {};
    if (b.priceCents != null && !(Number(b.priceCents) >= 0)) return badRequest(res, 'priceCents must be a non-negative number');
    if (b.unit && !['per_rider', 'per_booking'].includes(b.unit)) return badRequest(res, "unit must be 'per_rider' or 'per_booking'");
    run(`UPDATE addon_catalog SET label=COALESCE(?,label), description=COALESCE(?,description), price_cents=COALESCE(?,price_cents),
         unit=COALESCE(?,unit), active=COALESCE(?,active), sort_order=COALESCE(?,sort_order) WHERE id=?`,
      [b.label || null, b.description || null, b.priceCents != null ? Math.round(Number(b.priceCents)) : null,
       b.unit || null, b.active === undefined ? null : (b.active ? 1 : 0), b.sortOrder ?? null, row.id]);
    ok(res, get('SELECT * FROM addon_catalog WHERE id = ?', [row.id]));
  }));

  // DELETE /api/admin/addons/:id — only if no booking has ever used it, so a
  // past invoice's line items never lose their source row; deactivate
  // (active:false via PATCH) instead to retire one that's already in use.
  router.delete('/api/admin/addons/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM addon_catalog WHERE id = ?', [Number(req.params.id)]);
    if (!row) return notFound(res, 'Add-on not found');
    const inUse = get('SELECT COUNT(*) n FROM booking_addons WHERE addon_key = ?', [row.key]).n;
    if (inUse > 0) return badRequest(res, 'This add-on has been used on ' + inUse + ' booking(s) — deactivate it instead of deleting.');
    run('DELETE FROM addon_catalog WHERE id = ?', [row.id]);
    ok(res, { deleted: true });
  }));
}

module.exports = { register };
