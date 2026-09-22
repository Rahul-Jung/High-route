'use strict';
const { all, get, run } = require('../db');
const { ok, notFound, unauthorized } = require('../lib/util');
const { requireAdmin, requireAuth } = require('../lib/auth');

function register(router) {
  // GET /api/riders/me/notifications — newest first, with an unread count.
  router.get('/api/riders/me/notifications', requireAuth('rider', (req, res) => {
    const rows = all(
      `SELECT * FROM notifications WHERE recipient_type = 'rider' AND recipient_id = ? ORDER BY created_at DESC LIMIT 50`,
      [req.session.subject_id]);
    const unread = rows.filter(r => !r.read_at).length;
    ok(res, { count: rows.length, unread_count: unread, notifications: rows });
  }));

  router.post('/api/riders/me/notifications/:id/read', requireAuth('rider', (req, res) => {
    const row = get('SELECT * FROM notifications WHERE id = ?', [Number(req.params.id)]);
    if (!row) return notFound(res, 'Notification not found');
    if (row.recipient_type !== 'rider' || row.recipient_id !== req.session.subject_id) {
      return unauthorized(res, 'This notification does not belong to you');
    }
    run("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL", [row.id]);
    ok(res, { read: true });
  }));

  router.post('/api/riders/me/notifications/read-all', requireAuth('rider', (req, res) => {
    run("UPDATE notifications SET read_at = datetime('now') WHERE recipient_type = 'rider' AND recipient_id = ? AND read_at IS NULL",
      [req.session.subject_id]);
    ok(res, { read: true });
  }));

  // Admin notifications are shared across every admin session (recipient_id
  // IS NULL) — see the notifications table comment in schema.sql.
  router.get('/api/admin/notifications', requireAdmin((req, res) => {
    const rows = all(
      `SELECT * FROM notifications WHERE recipient_type = 'admin' AND recipient_id IS NULL ORDER BY created_at DESC LIMIT 50`);
    const unread = rows.filter(r => !r.read_at).length;
    ok(res, { count: rows.length, unread_count: unread, notifications: rows });
  }));

  router.post('/api/admin/notifications/:id/read', requireAdmin((req, res) => {
    const row = get('SELECT * FROM notifications WHERE id = ?', [Number(req.params.id)]);
    if (!row) return notFound(res, 'Notification not found');
    run("UPDATE notifications SET read_at = datetime('now') WHERE id = ? AND read_at IS NULL", [row.id]);
    ok(res, { read: true });
  }));

  router.post('/api/admin/notifications/read-all', requireAdmin((req, res) => {
    run("UPDATE notifications SET read_at = datetime('now') WHERE recipient_type = 'admin' AND recipient_id IS NULL AND read_at IS NULL");
    ok(res, { read: true });
  }));
}

module.exports = { register };
