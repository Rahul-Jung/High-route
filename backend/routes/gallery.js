'use strict';
const { all, get, run } = require('../db');
const { ok, created, badRequest, notFound } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');

function register(router) {
  // GET /api/gallery?category=gallery&tourId=1
  router.get('/api/gallery', (req, res) => {
    const { category, tourId } = req.query;
    let sql = 'SELECT * FROM gallery_images WHERE 1=1';
    const params = [];
    if (category) { sql += ' AND category = ?'; params.push(category); }
    if (tourId) { sql += ' AND tour_id = ?'; params.push(Number(tourId)); }
    sql += ' ORDER BY sort_order ASC, created_at DESC';
    const rows = all(sql, params);
    ok(res, { count: rows.length, images: rows });
  });

  // POST /api/admin/gallery  { imageUrl, caption, category, tourId, sortOrder }
  router.post('/api/admin/gallery', requireAdmin((req, res) => {
    const b = req.body || {};
    if (!b.imageUrl) return badRequest(res, 'imageUrl is required');
    const category = ['hero', 'gallery', 'guide', 'tour'].includes(b.category) ? b.category : 'gallery';
    const id = run(
      `INSERT INTO gallery_images (image_url, caption, category, tour_id, sort_order) VALUES (?,?,?,?,?)`,
      [b.imageUrl, b.caption || null, category, b.tourId || null, b.sortOrder || 0]
    ).lastInsertRowid;
    created(res, get('SELECT * FROM gallery_images WHERE id = ?', [id]));
  }));

  // PATCH /api/admin/gallery/:id  { imageUrl, caption, category, tourId, sortOrder }
  router.patch('/api/admin/gallery/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM gallery_images WHERE id = ?', [Number(req.params.id)]);
    if (!row) return notFound(res, 'Image not found');
    const b = req.body || {};
    if (b.category !== undefined && !['hero', 'gallery', 'guide', 'tour'].includes(b.category)) {
      return badRequest(res, 'category must be one of hero, gallery, guide, tour');
    }
    // tour_id uses an explicit hasOwnProperty check (like departures.js's
    // guideId) rather than COALESCE, so an admin can deliberately unlink an
    // image from a tour by sending tourId: null — COALESCE would just keep
    // the old value since null and "not sent" would look identical.
    const touchesTourId = Object.prototype.hasOwnProperty.call(b, 'tourId');
    run(`UPDATE gallery_images SET image_url=COALESCE(?,image_url), caption=COALESCE(?,caption),
         category=COALESCE(?,category), tour_id=?, sort_order=COALESCE(?,sort_order) WHERE id=?`,
      [b.imageUrl || null, b.caption || null, b.category || null,
       touchesTourId ? (b.tourId || null) : row.tour_id, b.sortOrder ?? null, row.id]);
    ok(res, get('SELECT * FROM gallery_images WHERE id = ?', [row.id]));
  }));

  // DELETE /api/admin/gallery/:id
  router.delete('/api/admin/gallery/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM gallery_images WHERE id = ?', [Number(req.params.id)]);
    if (!row) return notFound(res, 'Image not found');
    run('DELETE FROM gallery_images WHERE id = ?', [row.id]);
    ok(res, { deleted: true });
  }));
}

module.exports = { register };
