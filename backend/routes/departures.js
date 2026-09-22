'use strict';
const { all, get, run } = require('../db');
const { ok, notFound, badRequest } = require('../lib/util');
const { requireAdmin, sessionFromRequest } = require('../lib/auth');

function statusLabel(status) {
  return { open: 'Open', few_spaces: 'Few spaces', full: 'Full', request_only: 'Request-only', cancelled: 'Cancelled' }[status] || status;
}

/** A departure's end date is never set directly — it's always derived from
 *  its tour's fixed duration_days, so the trip length can't drift out of
 *  sync with what the tour itself promises. Dates are plain 'YYYY-MM-DD'
 *  strings throughout this app, so date arithmetic is done in UTC to avoid
 *  local-timezone off-by-one shifts. */
function computeEndDate(startDate, durationDays) {
  const start = new Date(startDate + 'T00:00:00Z');
  start.setUTCDate(start.getUTCDate() + (Number(durationDays) - 1));
  return start.toISOString().slice(0, 10);
}

/** The inverse of computeEndDate — how many days a departure's OWN actual
 *  start/end span covers. For a normal catalogue departure this always
 *  equals its tour's duration_days (since that's exactly how its end_date
 *  was computed), so using this instead of joining tours.duration_days is a
 *  no-op there. For an is_custom departure (see schema.sql) it's often
 *  genuinely different — a proposal's negotiated duration_days, not the
 *  base tour's default — so tours.duration_days must never be trusted as
 *  "this departure's length" anywhere a real departure row is involved. */
function actualDurationDays(startDate, endDate) {
  const start = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  return Math.round((end - start) / 86400000) + 1;
}

/** A guide can only lead one departure at a time — find any other
 *  non-cancelled departure of theirs whose dates overlap the given range.
 *  excludeDepartureId lets an edit check against every OTHER departure
 *  without tripping over the row being edited. */
function findGuideConflict(guideId, startDate, endDate, excludeDepartureId) {
  if (!guideId) return null;
  const rows = all(
    `SELECT d.id, d.start_date, d.end_date, t.name AS tour_name FROM departures d
     JOIN tours t ON t.id = d.tour_id
     WHERE d.guide_id = ? AND d.status != 'cancelled' AND d.id != ?`,
    [guideId, excludeDepartureId || 0]);
  return rows.find(r => startDate <= r.end_date && r.start_date <= endDate) || null;
}

function register(router) {
  // GET /api/departures?month=2026-09 — the admin panel and calendar.html use
  // this bare, expecting every departure (including past/cancelled) so they
  // can manage or grey them out. GET /api/departures?upcoming=1&limit=6 is
  // the public "what can I actually book" view — the homepage's departures
  // table uses this so it only ever shows real, bookable, admin-entered dates.
  router.get('/api/departures', (req, res) => {
    const { month, tourId, upcoming, limit } = req.query;
    const session = sessionFromRequest(req);
    const isAdmin = session && session.subject_type === 'admin';
    const riderId = session && session.subject_type === 'rider' ? session.subject_id : null;
    let sql = `SELECT d.*, t.name AS tour_name, t.slug AS tour_slug, t.region, t.duration_days, t.difficulty_level,
                      g.name AS guide_name
               FROM departures d JOIN tours t ON t.id = d.tour_id LEFT JOIN guides g ON g.id = d.guide_id WHERE 1=1`;
    const params = [];
    // A custom-request-originated departure (see is_custom in schema.sql) is
    // a private reservation for one specific group — hidden from everyone
    // except an admin (the Departures tab) and the one rider it actually
    // belongs to (so their own confirmed trip still shows up on their own
    // calendar.html view, signed in). Everyone else, including an anonymous
    // calendar.html visitor or the homepage, never learns it exists here.
    if (!isAdmin) {
      if (riderId) {
        sql += ` AND (d.is_custom = 0 OR d.custom_request_id IN (SELECT id FROM custom_requests WHERE rider_id = ?))`;
        params.push(riderId);
      } else {
        sql += ' AND d.is_custom = 0';
      }
    }
    if (month) { sql += " AND strftime('%Y-%m', d.start_date) = ?"; params.push(month); }
    if (tourId) { sql += ' AND d.tour_id = ?'; params.push(Number(tourId)); }
    if (upcoming) { sql += " AND date(d.start_date) >= date('now') AND d.status != 'cancelled'"; }
    sql += ' ORDER BY d.start_date ASC';
    if (limit) { sql += ' LIMIT ?'; params.push(Number(limit)); }
    const rows = all(sql, params).map(r => ({
      ...r,
      // Overrides the joined tours.duration_days (still useful elsewhere as
      // "what this tour is normally") with this departure's own real span —
      // see actualDurationDays above. Was previously always the tour's
      // default, silently wrong for any custom trip proposed at a different
      // length than its base tour.
      duration_days: actualDurationDays(r.start_date, r.end_date),
      spaces_left: Math.max(0, r.capacity - r.seats_booked),
      status_label: statusLabel(r.status),
    }));
    ok(res, { count: rows.length, departures: rows });
  });

  // GET /api/departures/:id — used both by the admin panel and by
  // trip.html's "view this date and book" mode (no booking made yet), so the
  // guide fields here match what GET /api/bookings/:id returns once a
  // booking exists — same shape, whichever mode trip.html is in.
  router.get('/api/departures/:id', (req, res) => {
    const dep = get(
      `SELECT d.*, t.name AS tour_name, t.slug AS tour_slug,
              g.name AS guide_name, g.role AS guide_role, g.bio AS guide_bio, g.photo_url AS guide_photo_url,
              g.years_experience AS guide_years_experience, g.languages AS guide_languages,
              g.trips_led AS guide_trips_led, g.rating AS guide_rating
       FROM departures d JOIN tours t ON t.id = d.tour_id LEFT JOIN guides g ON g.id = d.guide_id
       WHERE d.id = ?`, [Number(req.params.id)]);
    if (!dep) return notFound(res, 'Departure not found');
    // Same privacy rule as the list endpoint above — a stranger guessing IDs
    // can't view or attempt to book someone else's private custom trip. Its
    // owner views it through GET /api/bookings/:id instead (trip.html?booking=),
    // which already enforces real ownership rather than "logged in as anyone".
    if (dep.is_custom) {
      const session = sessionFromRequest(req);
      if (!session || session.subject_type !== 'admin') return notFound(res, 'Departure not found');
    }
    const riders = all(
      `SELECT br.id, br.name, br.riding_experience FROM booking_riders br
       JOIN bookings b ON b.id = br.booking_id WHERE b.departure_id = ? AND b.status != 'cancelled'`,
      [dep.id]);
    ok(res, {
      ...dep, duration_days: actualDurationDays(dep.start_date, dep.end_date),
      spaces_left: Math.max(0, dep.capacity - dep.seats_booked), status_label: statusLabel(dep.status), riders,
    });
  });

  // PATCH /api/departures/:id/availability  { status }  — used by the admin dashboard demo
  router.patch('/api/departures/:id/availability', requireAdmin((req, res) => {
    const { status } = req.body || {};
    const allowed = ['open', 'few_spaces', 'full', 'request_only', 'cancelled'];
    if (!allowed.includes(status)) return badRequest(res, 'status must be one of ' + allowed.join(', '));
    run('UPDATE departures SET status = ? WHERE id = ?', [status, Number(req.params.id)]);
    ok(res, { updated: true });
  }));
  // POST /api/admin/departures — add a new date for a tour. Only the start
  // (departure) date is ever supplied — the end date is always derived from
  // the tour's own duration_days, never taken from the client.
  router.post('/api/admin/departures', requireAdmin((req, res) => {
    const b = req.body || {};
    if (!b.tourId || !b.startDate || !b.capacity) {
      return badRequest(res, 'tourId, startDate and capacity are required');
    }
    const tour = get('SELECT id, duration_days FROM tours WHERE id = ?', [Number(b.tourId)]);
    if (!tour) return notFound(res, 'Tour not found');
    const endDate = computeEndDate(b.startDate, tour.duration_days);
    const guideId = b.guideId ? Number(b.guideId) : null;
    if (guideId) {
      const conflict = findGuideConflict(guideId, b.startDate, endDate, 0);
      if (conflict) {
        const guide = get('SELECT name FROM guides WHERE id = ?', [guideId]);
        return badRequest(res, `${guide ? guide.name : 'This guide'} is already leading ${conflict.tour_name} ` +
          `from ${conflict.start_date} to ${conflict.end_date} — pick a different guide or date`);
      }
    }
    const id = run(
      `INSERT INTO departures (tour_id, guide_id, start_date, end_date, capacity, seats_booked, status) VALUES (?,?,?,?,?,0,?)`,
      [Number(b.tourId), guideId, b.startDate, endDate, Number(b.capacity), b.status || 'open']
    ).lastInsertRowid;
    ok(res, get('SELECT * FROM departures WHERE id = ?', [id]));
  }));

  // PATCH /api/admin/departures/:id — edit the departure date, capacity,
  // guide and/or status. The end date is never accepted from the client:
  // changing startDate always recomputes end_date from the departure's OWN
  // current actual length (see actualDurationDays) — NOT the tour's default
  // duration_days. Those two agree for a normal catalogue departure (its
  // end_date was computed from the tour's duration_days in the first place),
  // but for an is_custom departure they can genuinely differ — using the
  // tour's default here used to silently shrink/stretch a custom trip's real
  // negotiated length back to the base tour's every time its date moved.
  router.patch('/api/admin/departures/:id', requireAdmin((req, res) => {
    const row = get(
      `SELECT d.*, t.name AS tour_name FROM departures d
       JOIN tours t ON t.id = d.tour_id WHERE d.id = ?`, [Number(req.params.id)]);
    if (!row) return notFound(res, 'Departure not found');
    const b = req.body || {};

    const startDate = b.startDate || row.start_date;
    const endDate = b.startDate ? computeEndDate(b.startDate, actualDurationDays(row.start_date, row.end_date)) : row.end_date;
    // guideId is nullable (unassign), so its presence — not its truthiness —
    // decides whether this request touches it at all.
    const touchesGuideId = Object.prototype.hasOwnProperty.call(b, 'guideId');
    const guideId = touchesGuideId ? (b.guideId || null) : row.guide_id;

    // Only re-check for a scheduling conflict when this request actually
    // moves the date or reassigns the guide. Otherwise an unrelated edit
    // (capacity, status) against a departure that already has some other
    // pre-existing conflict in the data would become permanently stuck —
    // including the one edit an admin most needs in that situation:
    // cancelling it.
    if (guideId && (touchesGuideId || b.startDate)) {
      const conflict = findGuideConflict(guideId, startDate, endDate, row.id);
      if (conflict) {
        const guide = get('SELECT name FROM guides WHERE id = ?', [guideId]);
        return badRequest(res, `${guide ? guide.name : 'This guide'} is already leading ${conflict.tour_name} ` +
          `from ${conflict.start_date} to ${conflict.end_date} — pick a different guide or date`);
      }
    }

    run(`UPDATE departures SET start_date=?, end_date=?, capacity=COALESCE(?,capacity), guide_id=?, status=COALESCE(?,status) WHERE id=?`,
      [startDate, endDate, b.capacity ?? null, guideId, b.status || null, row.id]);
    ok(res, get('SELECT * FROM departures WHERE id = ?', [row.id]));
  }));

  // DELETE /api/admin/departures/:id — only if nobody's booked on it
  router.delete('/api/admin/departures/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM departures WHERE id = ?', [Number(req.params.id)]);
    if (!row) return notFound(res, 'Departure not found');
    if (row.seats_booked > 0) return badRequest(res, 'Cannot delete a departure with bookings — cancel it instead (PATCH status=cancelled)');
    run('DELETE FROM departures WHERE id = ?', [row.id]);
    ok(res, { deleted: true });
  }));
}

module.exports = { register, computeEndDate, actualDurationDays };
