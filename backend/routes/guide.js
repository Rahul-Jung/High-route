'use strict';
const { all, get, run } = require('../db');
const { ok, created, badRequest } = require('../lib/util');
const { requireAuth } = require('../lib/auth');

function register(router) {
  // GET /api/guide/today — departures this guide is running "now" (demo: all upcoming/active ones)
  router.get('/api/guide/today', requireAuth('guide', (req, res) => {
    const guideId = req.session.subject_id;
    const departures = all(
      `SELECT d.*, t.name AS tour_name, t.slug AS tour_slug FROM departures d JOIN tours t ON t.id = d.tour_id
       WHERE d.guide_id = ? AND d.status != 'cancelled' AND date(d.end_date) >= date('now') ORDER BY d.start_date ASC`,
      [guideId]);
    const withRiders = departures.map(dep => {
      const riders = all(
        `SELECT br.* FROM booking_riders br JOIN bookings b ON b.id = br.booking_id
         WHERE b.departure_id = ? AND b.status != 'cancelled'`, [dep.id]);
      const lastPings = all(
        `SELECT * FROM gps_pings WHERE departure_id = ? ORDER BY recorded_at DESC LIMIT 5`, [dep.id]);
      return { ...dep, riders, recent_gps: lastPings };
    });
    ok(res, { guide_id: guideId, departures: withRiders });
  }));

  // POST /api/guide/checkin  { departureId, bookingRiderId, message? }
  router.post('/api/guide/checkin', requireAuth('guide', (req, res) => {
    const b = req.body || {};
    if (!b.departureId) return badRequest(res, 'departureId is required');
    const id = run(
      `INSERT INTO trip_updates (departure_id, guide_id, type, booking_rider_id, message) VALUES (?,?,?,?,?)`,
      [Number(b.departureId), req.session.subject_id, 'checkin', b.bookingRiderId || null, b.message || 'Checked in']
    ).lastInsertRowid;
    created(res, get('SELECT * FROM trip_updates WHERE id = ?', [id]));
  }));

  // POST /api/guide/incident  { departureId, bookingRiderId?, message }
  router.post('/api/guide/incident', requireAuth('guide', (req, res) => {
    const b = req.body || {};
    if (!b.departureId || !b.message) return badRequest(res, 'departureId and message are required');
    const id = run(
      `INSERT INTO trip_updates (departure_id, guide_id, type, booking_rider_id, message) VALUES (?,?,?,?,?)`,
      [Number(b.departureId), req.session.subject_id, 'incident', b.bookingRiderId || null, b.message]
    ).lastInsertRowid;
    created(res, get('SELECT * FROM trip_updates WHERE id = ?', [id]));
  }));

  // POST /api/guide/status  { departureId, message, photoUrl? }  — e.g. "Day 3 briefing"
  router.post('/api/guide/status', requireAuth('guide', (req, res) => {
    const b = req.body || {};
    if (!b.departureId || !b.message) return badRequest(res, 'departureId and message are required');
    const id = run(
      `INSERT INTO trip_updates (departure_id, guide_id, type, message, photo_url) VALUES (?,?,?,?,?)`,
      [Number(b.departureId), req.session.subject_id, b.photoUrl ? 'photo' : 'status', b.message, b.photoUrl || null]
    ).lastInsertRowid;
    created(res, get('SELECT * FROM trip_updates WHERE id = ?', [id]));
  }));

  // GET /api/departures/:id/updates — public trip feed (rider dashboard consumes this)
  router.get('/api/departures/:id/updates', (req, res) => {
    const rows = all(
      `SELECT tu.*, g.name AS guide_name FROM trip_updates tu LEFT JOIN guides g ON g.id = tu.guide_id
       WHERE tu.departure_id = ? ORDER BY tu.created_at DESC`, [Number(req.params.id)]);
    ok(res, { count: rows.length, updates: rows });
  });
}

module.exports = { register };
