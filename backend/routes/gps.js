'use strict';
const { all, get, run } = require('../db');
const { ok, created, badRequest, notFound } = require('../lib/util');

// ----------------------------------------------------------------------------
// DEMO / SIMULATION ONLY. Real Himalayan routes have no cellular signal, so a
// production version of this needs satellite hardware (e.g. Garmin inReach /
// Iridium) reporting into this same shape of endpoint, not a phone GPS alone.
// Treat every coordinate served here as illustrative. See README.
// ----------------------------------------------------------------------------

function register(router) {
  // POST /api/gps/ping  { departureId, bookingRiderId?, label?, lat, lng, altitudeM?, speedKmh?, source? }
  router.post('/api/gps/ping', (req, res) => {
    const b = req.body || {};
    const departureId = Number(b.departureId);
    if (!departureId || typeof b.lat !== 'number' || typeof b.lng !== 'number') {
      return badRequest(res, 'departureId, lat and lng are required');
    }
    const dep = get('SELECT id FROM departures WHERE id = ?', [departureId]);
    if (!dep) return notFound(res, 'Departure not found');

    const id = run(
      `INSERT INTO gps_pings (departure_id, booking_rider_id, label, lat, lng, altitude_m, speed_kmh, source)
       VALUES (?,?,?,?,?,?,?,?)`,
      [departureId, b.bookingRiderId || null, b.label || null, b.lat, b.lng,
       b.altitudeM || null, b.speedKmh || null, b.source || 'simulated']
    ).lastInsertRowid;
    created(res, get('SELECT * FROM gps_pings WHERE id = ?', [id]));
  });

  // GET /api/gps/latest?departureId=1 — most recent ping per label/rider (for a live map)
  router.get('/api/gps/latest', (req, res) => {
    const departureId = Number(req.query.departureId);
    if (!departureId) return badRequest(res, 'departureId is required');
    // Grouped by rider label, keyed on MAX(id) rather than MAX(recorded_at): SQLite's
    // datetime('now') only has 1-second resolution, so fast simulated pings can share
    // a timestamp — using the row id instead guarantees exactly one row per rider.
    const rows = all(
      `SELECT g.* FROM gps_pings g
       INNER JOIN (
         SELECT COALESCE(label, 'rider-' || booking_rider_id, 'group') AS grp, MAX(id) AS max_id
         FROM gps_pings WHERE departure_id = ? GROUP BY grp
       ) latest ON g.id = latest.max_id
       WHERE g.departure_id = ? ORDER BY g.recorded_at DESC`,
      [departureId, departureId]);
    ok(res, { count: rows.length, positions: rows });
  });

  // GET /api/gps/track?departureId=1&label=rider-1 — full history, e.g. for offline export
  router.get('/api/gps/track', (req, res) => {
    const departureId = Number(req.query.departureId);
    if (!departureId) return badRequest(res, 'departureId is required');
    let sql = 'SELECT * FROM gps_pings WHERE departure_id = ?';
    const params = [departureId];
    if (req.query.label) { sql += ' AND label = ?'; params.push(req.query.label); }
    sql += ' ORDER BY recorded_at ASC';
    const rows = all(sql, params);
    ok(res, { count: rows.length, track: rows });
  });
}

module.exports = { register };
