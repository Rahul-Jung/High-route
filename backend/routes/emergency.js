'use strict';
const { all, get, run } = require('../db');
const { ok, created, badRequest, notFound } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');

// ----------------------------------------------------------------------------
// This models the SOS workflow's data shape only: an alert is logged with a
// location and surfaced to guide/admin views. It intentionally does NOT
// contact real emergency services. Per the brief itself (section 22), the
// actual evacuation/emergency procedure must be designed with qualified
// local safety and medical professionals, not shipped as software alone.
// ----------------------------------------------------------------------------

function register(router) {
  // POST /api/emergency  { departureId, bookingRiderId?, lat, lng, altitudeM?, message? }
  router.post('/api/emergency', (req, res) => {
    const b = req.body || {};
    const departureId = Number(b.departureId);
    if (!departureId || typeof b.lat !== 'number' || typeof b.lng !== 'number') {
      return badRequest(res, 'departureId, lat and lng are required');
    }
    const dep = get(
      `SELECT d.*, g.name AS guide_name, g.email AS guide_email FROM departures d LEFT JOIN guides g ON g.id = d.guide_id WHERE d.id = ?`,
      [departureId]);
    if (!dep) return notFound(res, 'Departure not found');

    const id = run(
      `INSERT INTO emergency_alerts (departure_id, booking_rider_id, lat, lng, altitude_m, message) VALUES (?,?,?,?,?,?)`,
      [departureId, b.bookingRiderId || null, b.lat, b.lng, b.altitudeM || null, b.message || null]
    ).lastInsertRowid;

    created(res, {
      alert: get('SELECT * FROM emergency_alerts WHERE id = ?', [id]),
      dispatched_to: {
        guide: dep.guide_name || 'Unassigned — escalate to operations immediately',
        operations_desk: 'ops@highroutemtb.demo (placeholder — wire to a real 24/7 desk in production)',
      },
      note: 'DEMO ONLY: no real emergency service, satellite messenger, or evacuation provider is contacted by this endpoint.',
    });
  });

  // GET /api/emergency?status=open — guide/admin view of alerts
  router.get('/api/emergency', requireAdmin((req, res) => {
    const { status } = req.query;
    let sql = `SELECT e.*, d.tour_id, t.name AS tour_name FROM emergency_alerts e
               JOIN departures d ON d.id = e.departure_id JOIN tours t ON t.id = d.tour_id WHERE 1=1`;
    const params = [];
    if (status) { sql += ' AND e.status = ?'; params.push(status); }
    sql += ' ORDER BY e.triggered_at DESC';
    ok(res, { count: all(sql, params).length, alerts: all(sql, params) });
  }));

  // PATCH /api/emergency/:id  { status, responder }
  router.patch('/api/emergency/:id', requireAdmin((req, res) => {
    const alert = get('SELECT * FROM emergency_alerts WHERE id = ?', [Number(req.params.id)]);
    if (!alert) return notFound(res, 'Alert not found');
    const { status, responder } = req.body || {};
    const resolvedAt = status === 'resolved' ? new Date().toISOString() : alert.resolved_at;
    run('UPDATE emergency_alerts SET status = COALESCE(?, status), responder = COALESCE(?, responder), resolved_at = ? WHERE id = ?',
      [status || null, responder || null, resolvedAt, alert.id]);
    ok(res, get('SELECT * FROM emergency_alerts WHERE id = ?', [alert.id]));
  }));
}

module.exports = { register };
