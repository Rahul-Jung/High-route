'use strict';
const { all, get, run } = require('../db');
const { ok, created, badRequest, notFound, sendJson, rateLimited, clientIp } = require('../lib/util');
const { requireAdmin, sessionFromRequest } = require('../lib/auth');

// ----------------------------------------------------------------------------
// This models the SOS workflow's data shape only: an alert is logged with a
// location and surfaced to guide/admin views. It intentionally does NOT
// contact real emergency services. Per the brief itself (section 22), the
// actual evacuation/emergency procedure must be designed with qualified
// local safety and medical professionals, not shipped as software alone.
// ----------------------------------------------------------------------------

function register(router) {
  // POST /api/emergency  { departureId, bookingRiderId?, lat, lng, altitudeM?, message? }
  //
  // Deliberately NOT behind auth, unlike POST /api/gps/ping. An SOS is the one
  // action that must still work when the person pressing it can't sign in —
  // wrong phone, expired session, someone else's handset, a bystander. Putting
  // a login in front of a panic button is a worse failure than a false alarm.
  //
  // What it does have is a per-IP throttle, so "anyone can raise an alarm"
  // doesn't also mean "anyone can bury the real alarms under a thousand fake
  // ones". The limit is deliberately loose: a genuine repeat press, or several
  // riders in one group reporting the same incident, must never be blocked.
  router.post('/api/emergency', (req, res) => {
    const b = req.body || {};
    if (rateLimited('sos:' + clientIp(req), { max: 20, windowMs: 5 * 60 * 1000 })) {
      return sendJson(res, 429, {
        error: 'Too many alerts raised from this connection in the last few minutes. '
          + 'If this is a real emergency, call your guide or the operations desk directly now.',
      });
    }
    const departureId = Number(b.departureId);
    if (!Number.isInteger(departureId) || departureId < 1
        || typeof b.lat !== 'number' || typeof b.lng !== 'number'
        || !Number.isFinite(b.lat) || !Number.isFinite(b.lng)) {
      return badRequest(res, 'departureId, lat and lng are required (lat/lng as numbers)');
    }
    if (b.lat < -90 || b.lat > 90 || b.lng < -180 || b.lng > 180) {
      return badRequest(res, 'lat must be between -90 and 90, lng between -180 and 180');
    }
    const dep = get(
      `SELECT d.*, g.name AS guide_name, g.email AS guide_email FROM departures d LEFT JOIN guides g ON g.id = d.guide_id WHERE d.id = ?`,
      [departureId]);
    if (!dep) return notFound(res, 'Departure not found');

    // Records who raised it when we actually know, so the ops desk can tell a
    // signed-in rider's alert apart from an anonymous one without the alert
    // itself ever being gated on being signed in.
    const session = sessionFromRequest(req);
    const reporter = session
      ? `${session.subject_type} #${session.subject_id}`
      : 'anonymous (not signed in)';
    const message = [b.message || null, `[raised by: ${reporter}]`].filter(Boolean).join(' ');

    const id = run(
      `INSERT INTO emergency_alerts (departure_id, booking_rider_id, lat, lng, altitude_m, message) VALUES (?,?,?,?,?,?)`,
      [departureId, b.bookingRiderId || null, b.lat, b.lng, b.altitudeM || null, message]
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
    const alerts = all(sql, params); // ran twice before — once for the count, once for the rows
    ok(res, { count: alerts.length, alerts });
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
