'use strict';
const { all, get, run } = require('../db');
const { ok, created, badRequest, notFound } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');

function register(router) {
  // GET /api/destinations — public, powers the homepage map
  router.get('/api/destinations', (req, res) => {
    const rows = all('SELECT * FROM destinations ORDER BY sort_order ASC, name ASC');
    ok(res, { count: rows.length, destinations: rows });
  });

  // POST /api/admin/destinations
  router.post('/api/admin/destinations', requireAdmin((req, res) => {
    const b = req.body || {};
    if (!b.slug || !b.name) return badRequest(res, 'slug and name are required');
    const id = run(
      `INSERT INTO destinations (slug, name, region, description, hero_image_url, lat, lng, sort_order) VALUES (?,?,?,?,?,?,?,?)`,
      [b.slug, b.name, b.region || null, b.description || null, b.heroImageUrl || null, b.lat ?? null, b.lng ?? null, b.sortOrder || 0]
    ).lastInsertRowid;
    created(res, get('SELECT * FROM destinations WHERE id = ?', [id]));
  }));

  // PATCH /api/admin/destinations/:id
  router.patch('/api/admin/destinations/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM destinations WHERE id = ?', [Number(req.params.id)]);
    if (!row) return notFound(res, 'Destination not found');
    const b = req.body || {};
    run(`UPDATE destinations SET name=COALESCE(?,name), region=COALESCE(?,region), description=COALESCE(?,description),
         hero_image_url=COALESCE(?,hero_image_url), lat=COALESCE(?,lat), lng=COALESCE(?,lng), sort_order=COALESCE(?,sort_order) WHERE id=?`,
      [b.name || null, b.region || null, b.description || null, b.heroImageUrl || null, b.lat ?? null, b.lng ?? null, b.sortOrder ?? null, row.id]);
    ok(res, get('SELECT * FROM destinations WHERE id = ?', [row.id]));
  }));

  // DELETE /api/admin/destinations/:id
  router.delete('/api/admin/destinations/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM destinations WHERE id = ?', [Number(req.params.id)]);
    if (!row) return notFound(res, 'Destination not found');
    run('DELETE FROM destinations WHERE id = ?', [row.id]);
    ok(res, { deleted: true });
  }));
}

module.exports = { register };
