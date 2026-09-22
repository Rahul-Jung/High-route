'use strict';
const { all, get, run } = require('../db');
const { ok, created, badRequest, notFound, unauthorized, verifyPassword } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');
const { resolveDistrict, slugify } = require('../lib/geo');
const { bookingReference } = require('./bookings');

/** Whenever a tour is created (or edited to a new district), this makes
 *  sure that place has a map pin — matching the admin's free-text input
 *  (typos tolerated, see lib/geo.js's resolveDistrict) against Nepal's 77
 *  districts *and* the specific named places under each one (so typing a
 *  town like "Dharan" pins Dharan itself, not just its parent district
 *  "Sunsari"), or adding a coordinate-less placeholder (visible in the
 *  admin Destinations tab, but drawing no pin until someone fills in
 *  lat/lng) when nothing close enough is recognised, rather than silently
 *  doing nothing. A place that already has a destination — matched on
 *  either the raw text or its resolved display name — is left alone; this
 *  never creates duplicate pins. Returns a short status object the caller
 *  can surface to the admin, or null if no destination was needed (or none
 *  could be attempted). Deliberately keyed on `district`, not `region` —
 *  `region` stays a free-text display/filter label and is never used for
 *  map placement. */
function ensureDestinationForDistrict(districtText) {
  if (!districtText) return null;
  const match = resolveDistrict(districtText);
  const displayName = match ? match.name : districtText;

  const existing = get(
    `SELECT id FROM destinations WHERE LOWER(name) = LOWER(?) OR LOWER(name) = LOWER(?)`,
    [districtText, displayName]
  );
  if (existing) return null;

  let slug = slugify(displayName);
  let suffix = 2;
  while (get('SELECT id FROM destinations WHERE slug = ?', [slug])) { slug = slugify(displayName) + '-' + suffix; suffix++; }
  const nextOrder = (get('SELECT MAX(sort_order) m FROM destinations').m || 0) + 1;

  run(
    `INSERT INTO destinations (slug, name, region, description, hero_image_url, lat, lng, sort_order, auto_created) VALUES (?,?,?,?,?,?,?,?,1)`,
    [slug, displayName, match ? match.district : districtText,
     match ? `${match.district} district.` : 'New place — add its coordinates here to place it on the map.',
     null, match ? match.lat : null, match ? match.lng : null, nextOrder]
  );

  return match
    ? { status: 'pinned', message: `Recognised "${districtText}" as ${match.name} (${match.district} district) and added a map pin automatically.` }
    : { status: 'needs_coordinates', message: `"${districtText}" isn't a Nepal district/place we recognise — added it to Destinations without a map pin. Add its lat/lng there to place it.` };
}

/** The flip side of ensureDestinationForDistrict: after any tour is
 *  created, edited or deleted, this removes any auto-created destination
 *  whose place no longer matches ANY tour's current district — so renaming
 *  a tour's district (or deleting the tour) takes its old pin off the map
 *  again instead of leaving an orphaned one behind. Recomputes from every
 *  tour's district each time rather than tracking "the old value", which
 *  stays correct even when several tours share a district. Never touches
 *  a destination the admin added by hand (auto_created = 0). Returns the
 *  list of removed pin names, for the caller to surface to the admin. */
function pruneOrphanedAutoDestinations() {
  const inUse = new Set();
  for (const t of all(`SELECT district FROM tours WHERE district IS NOT NULL AND district != ''`)) {
    const match = resolveDistrict(t.district);
    inUse.add((match ? match.name : t.district).toLowerCase());
  }
  const removed = [];
  for (const d of all('SELECT id, name FROM destinations WHERE auto_created = 1')) {
    if (!inUse.has(d.name.toLowerCase())) {
      run('DELETE FROM destinations WHERE id = ?', [d.id]);
      removed.push(d.name);
    }
  }
  return removed;
}

function register(router) {
  // GET /api/admin/summary — the numbers an operator sees first (brief section 41)
  router.get('/api/admin/summary', requireAdmin((req, res) => {
    const upcomingDepartures = get(`SELECT COUNT(*) n FROM departures WHERE date(start_date) >= date('now') AND status != 'cancelled'`).n;
    const ridersBookedUpcoming = get(
      `SELECT COALESCE(SUM(b.seats),0) n FROM (
         SELECT b.id, COUNT(br.id) AS seats FROM bookings b JOIN booking_riders br ON br.booking_id = b.id
         JOIN departures d ON d.id = b.departure_id WHERE date(d.start_date) >= date('now') AND b.status != 'cancelled'
         GROUP BY b.id
       ) b`).n;
    const revenue = get(`SELECT COALESCE(SUM(amount_paid_cents),0) n FROM bookings`).n;
    const pendingPayments = get(`SELECT COALESCE(SUM(total_cents - amount_paid_cents),0) n FROM bookings WHERE status != 'cancelled'`).n;
    const pendingCustomRequests = get(`SELECT COUNT(*) n FROM custom_requests WHERE status = 'new'`).n;
    const openAlerts = get(`SELECT COUNT(*) n FROM emergency_alerts WHERE status = 'open'`).n;
    const nextDepartures = all(
      `SELECT d.id, d.start_date, d.capacity, d.seats_booked, d.status, t.name AS tour_name
       FROM departures d JOIN tours t ON t.id = d.tour_id
       WHERE date(d.start_date) >= date('now') AND d.status != 'cancelled' ORDER BY d.start_date ASC LIMIT 6`);

    ok(res, {
      upcoming_departures: upcomingDepartures,
      riders_booked_upcoming: ridersBookedUpcoming,
      revenue_collected_cents: revenue,
      pending_payments_cents: pendingPayments,
      pending_custom_requests: pendingCustomRequests,
      open_emergency_alerts: openAlerts,
      next_departures: nextDepartures,
    });
  }));

  // GET /api/admin/analytics — brief section 45
  router.get('/api/admin/analytics', requireAdmin((req, res) => {
    const byTour = all(
      `SELECT t.name, t.slug, COUNT(DISTINCT d.id) AS departures,
              COALESCE(SUM(b.total_cents),0) AS revenue_cents,
              COALESCE(AVG(1.0 * d.seats_booked / d.capacity), 0) AS avg_occupancy
       FROM tours t
       LEFT JOIN departures d ON d.tour_id = t.id
       LEFT JOIN bookings b ON b.departure_id = d.id AND b.status != 'cancelled'
       GROUP BY t.id ORDER BY revenue_cents DESC`);
    const cancellations = get(`SELECT COUNT(*) n FROM bookings WHERE status = 'cancelled'`).n;
    const totalBookings = get(`SELECT COUNT(*) n FROM bookings`).n;
    ok(res, {
      by_tour: byTour.map(r => ({ ...r, avg_occupancy_pct: Math.round(r.avg_occupancy * 1000) / 10 })),
      cancellation_rate_pct: totalBookings ? Math.round((cancellations / totalBookings) * 1000) / 10 : 0,
      total_bookings: totalBookings,
      note: 'Marketing-source and country breakdowns (brief section 45) need real traffic/attribution data — not modelled in this demo.',
    });
  }));

  // POST /api/admin/tours — create a tour (brief section 42)
  router.post('/api/admin/tours', requireAdmin((req, res) => {
    const b = req.body || {};
    const required = ['slug', 'name', 'region', 'summary', 'durationDays', 'difficultyLevel', 'ridingStyle', 'distanceKm', 'elevationGainM', 'maxAltitudeM', 'priceFromCents'];
    for (const f of required) if (b[f] === undefined || b[f] === '') return badRequest(res, 'Missing field: ' + f);
    if (get('SELECT id FROM tours WHERE slug = ?', [b.slug])) return badRequest(res, 'A tour with this slug already exists');
    const id = run(
      `INSERT INTO tours (slug, name, region, district, summary, duration_days, difficulty_level, riding_style, distance_km, elevation_gain_m, max_altitude_m, price_from_cents, currency, image_url, best_season, group_size_min, group_size_max,
                          inclusions_json, exclusions_json, equipment_essential_json, equipment_recommended_json, safety_hazards, safety_preparation, safety_emergency, cancellation_policy)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [b.slug, b.name, b.region, b.district || null, b.summary, b.durationDays, b.difficultyLevel, b.ridingStyle, b.distanceKm,
       b.elevationGainM, b.maxAltitudeM, b.priceFromCents, b.currency || 'EUR', b.imageUrl || null, b.bestSeason || null,
       b.groupSizeMin || 2, b.groupSizeMax || 10,
       JSON.stringify(Array.isArray(b.inclusions) ? b.inclusions : []), JSON.stringify(Array.isArray(b.exclusions) ? b.exclusions : []),
       JSON.stringify(Array.isArray(b.equipmentEssential) ? b.equipmentEssential : []), JSON.stringify(Array.isArray(b.equipmentRecommended) ? b.equipmentRecommended : []),
       b.safetyHazards || null, b.safetyPreparation || null, b.safetyEmergency || null, b.cancellationPolicy || null]
    ).lastInsertRowid;
    const mapPin = ensureDestinationForDistrict(b.district);
    const removedPins = pruneOrphanedAutoDestinations();
    created(res, { ...get('SELECT * FROM tours WHERE id = ?', [id]), map_pin: mapPin, removed_pins: removedPins });
  }));

  // PATCH /api/admin/tours/:id — edit any subset of fields
  router.patch('/api/admin/tours/:id', requireAdmin((req, res) => {
    const tour = get('SELECT * FROM tours WHERE id = ?', [Number(req.params.id)]);
    if (!tour) return notFound(res, 'Tour not found');
    const b = req.body || {};
    const fieldMap = {
      name: 'name', region: 'region', district: 'district', summary: 'summary', durationDays: 'duration_days',
      difficultyLevel: 'difficulty_level', ridingStyle: 'riding_style', distanceKm: 'distance_km',
      elevationGainM: 'elevation_gain_m', maxAltitudeM: 'max_altitude_m', priceFromCents: 'price_from_cents',
      bestSeason: 'best_season', imageUrl: 'image_url', groupSizeMin: 'group_size_min', groupSizeMax: 'group_size_max',
      safetyHazards: 'safety_hazards', safetyPreparation: 'safety_preparation', safetyEmergency: 'safety_emergency',
      cancellationPolicy: 'cancellation_policy',
    };
    // Array fields are stored as JSON text — handled separately from the
    // plain-scalar fieldMap above since they need JSON.stringify first.
    const jsonFieldMap = {
      inclusions: 'inclusions_json', exclusions: 'exclusions_json',
      equipmentEssential: 'equipment_essential_json', equipmentRecommended: 'equipment_recommended_json',
    };
    const sets = [];
    const params = [];
    for (const [key, col] of Object.entries(fieldMap)) {
      if (b[key] !== undefined) { sets.push(col + ' = ?'); params.push(b[key]); }
    }
    for (const [key, col] of Object.entries(jsonFieldMap)) {
      if (b[key] !== undefined) { sets.push(col + ' = ?'); params.push(JSON.stringify(Array.isArray(b[key]) ? b[key] : [])); }
    }
    if (sets.length === 0) return badRequest(res, 'No recognised fields to update');
    params.push(tour.id);
    run(`UPDATE tours SET ${sets.join(', ')} WHERE id = ?`, params);
    // Only re-run the auto-pin add/prune check when this request actually
    // changes the district — an edit to unrelated fields shouldn't re-touch
    // destinations. Pruning runs after adding, so switching straight from
    // one recognised district to another both gains and loses a pin in the
    // same request (add the new one, then remove the now-unused old one).
    let mapPin = null, removedPins = [];
    if (b.district !== undefined) {
      mapPin = ensureDestinationForDistrict(b.district);
      removedPins = pruneOrphanedAutoDestinations();
    }
    ok(res, { ...get('SELECT * FROM tours WHERE id = ?', [tour.id]), map_pin: mapPin, removed_pins: removedPins });
  }));

  // DELETE /api/admin/tours/:id — only if it has no departures (cancel/remove those first)
  router.delete('/api/admin/tours/:id', requireAdmin((req, res) => {
    const tour = get('SELECT * FROM tours WHERE id = ?', [Number(req.params.id)]);
    if (!tour) return notFound(res, 'Tour not found');
    const depCount = get('SELECT COUNT(*) n FROM departures WHERE tour_id = ?', [tour.id]).n;
    if (depCount > 0) return badRequest(res, 'This tour has ' + depCount + ' departure(s) — delete those first.');
    run('DELETE FROM tour_days WHERE tour_id = ?', [tour.id]);
    run('DELETE FROM tours WHERE id = ?', [tour.id]);
    const removedPins = pruneOrphanedAutoDestinations();
    ok(res, { deleted: true, removed_pins: removedPins });
  }));

  // ---------------------------------------------------------------------
  // TOUR DAYS — the day-by-day itinerary shown on a tour's detail page
  // (the elevation chart is synthesised client-side from these fields, the
  // same way Upper Mustang's seeded days already work — see
  // synthesizeProfile() in frontend/main.js). Same CRUD conventions as the
  // tours endpoints above.
  // ---------------------------------------------------------------------

  // POST /api/admin/tours/:id/days
  router.post('/api/admin/tours/:id/days', requireAdmin((req, res) => {
    const tour = get('SELECT id FROM tours WHERE id = ?', [Number(req.params.id)]);
    if (!tour) return notFound(res, 'Tour not found');
    const b = req.body || {};
    const required = ['dayNumber', 'title', 'distanceKm', 'elevationGainM', 'elevationLossM', 'highPointM', 'ridingHours', 'terrain', 'overnightPlace'];
    for (const f of required) if (b[f] === undefined || b[f] === '') return badRequest(res, 'Missing field: ' + f);
    if (get('SELECT id FROM tour_days WHERE tour_id = ? AND day_number = ?', [tour.id, b.dayNumber])) {
      return badRequest(res, 'Day ' + b.dayNumber + ' already exists for this tour — edit or delete it first');
    }
    const id = run(
      `INSERT INTO tour_days (tour_id, day_number, title, distance_km, elevation_gain_m, elevation_loss_m, high_point_m, riding_hours, terrain, overnight_place, overnight_lat, overnight_lng)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [tour.id, b.dayNumber, b.title, b.distanceKm, b.elevationGainM, b.elevationLossM, b.highPointM, b.ridingHours,
       b.terrain, b.overnightPlace, b.overnightLat || null, b.overnightLng || null]
    ).lastInsertRowid;
    created(res, get('SELECT * FROM tour_days WHERE id = ?', [id]));
  }));

  // PATCH /api/admin/tours/:tourId/days/:dayId — edit any subset of fields
  router.patch('/api/admin/tours/:tourId/days/:dayId', requireAdmin((req, res) => {
    const day = get('SELECT * FROM tour_days WHERE id = ? AND tour_id = ?', [Number(req.params.dayId), Number(req.params.tourId)]);
    if (!day) return notFound(res, 'Day not found');
    const b = req.body || {};
    const fieldMap = {
      dayNumber: 'day_number', title: 'title', distanceKm: 'distance_km', elevationGainM: 'elevation_gain_m',
      elevationLossM: 'elevation_loss_m', highPointM: 'high_point_m', ridingHours: 'riding_hours', terrain: 'terrain',
      overnightPlace: 'overnight_place', overnightLat: 'overnight_lat', overnightLng: 'overnight_lng',
    };
    const sets = [];
    const params = [];
    for (const [key, col] of Object.entries(fieldMap)) {
      if (b[key] !== undefined) { sets.push(col + ' = ?'); params.push(b[key]); }
    }
    if (sets.length === 0) return badRequest(res, 'No recognised fields to update');
    params.push(day.id);
    run(`UPDATE tour_days SET ${sets.join(', ')} WHERE id = ?`, params);
    ok(res, get('SELECT * FROM tour_days WHERE id = ?', [day.id]));
  }));

  // DELETE /api/admin/tours/:tourId/days/:dayId
  router.delete('/api/admin/tours/:tourId/days/:dayId', requireAdmin((req, res) => {
    const day = get('SELECT id FROM tour_days WHERE id = ? AND tour_id = ?', [Number(req.params.dayId), Number(req.params.tourId)]);
    if (!day) return notFound(res, 'Day not found');
    run('DELETE FROM tour_days WHERE id = ?', [day.id]);
    ok(res, { deleted: true });
  }));

  // ---------------------------------------------------------------------
  // REVIEWS — moderation. Anyone can read reviews (routes/reviews.js);
  // only an admin can remove one (e.g. abusive content, a mistaken post).
  // ---------------------------------------------------------------------

  // GET /api/admin/reviews — every review across every tour, newest first.
  router.get('/api/admin/reviews', requireAdmin((req, res) => {
    const rows = all(
      `SELECT r.*, t.name AS tour_name, t.slug AS tour_slug
       FROM reviews r LEFT JOIN tours t ON t.id = r.tour_id
       ORDER BY r.created_at DESC`);
    ok(res, { count: rows.length, reviews: rows });
  }));

  // DELETE /api/admin/reviews/:id
  router.delete('/api/admin/reviews/:id', requireAdmin((req, res) => {
    const review = get('SELECT id FROM reviews WHERE id = ?', [Number(req.params.id)]);
    if (!review) return notFound(res, 'Review not found');
    run('DELETE FROM reviews WHERE id = ?', [review.id]);
    ok(res, { deleted: true });
  }));

  // GET /api/admin/bookings — booking management view (brief section 43)
  router.get('/api/admin/bookings', requireAdmin((req, res) => {
    const rows = all(
      `SELECT b.*, t.name AS tour_name, d.start_date,
              lr.id AS requester_id, lr.name AS requester_name, lr.email AS requester_email
       FROM bookings b
       JOIN departures d ON d.id = b.departure_id JOIN tours t ON t.id = d.tour_id
       LEFT JOIN riders lr ON lr.id = b.lead_rider_id
       ORDER BY b.created_at DESC`);
    const withRiders = rows.map(r => ({
      ...r, addons: JSON.parse(r.addons_json),
      addon_items: all('SELECT * FROM booking_addons WHERE booking_id = ?', [r.id]),
      riders: all('SELECT * FROM booking_riders WHERE booking_id = ?', [r.id]),
      booking_reference: bookingReference(r.id),
    }));
    ok(res, { count: withRiders.length, bookings: withRiders });
  }));

  // ---------------------------------------------------------------------
  // USERS (rider accounts) — brief section 17 admin view. Deleting a rider
  // requires the ACTING ADMIN's own password as a step-up confirmation,
  // since it permanently removes a customer's account.
  // ---------------------------------------------------------------------

  // GET /api/admin/riders
  router.get('/api/admin/riders', requireAdmin((req, res) => {
    const rows = all(
      `SELECT r.id, r.name, r.email, r.phone, r.country, r.riding_experience, r.created_at,
              (SELECT COUNT(*) FROM bookings WHERE lead_rider_id = r.id) AS booking_count,
              (SELECT COUNT(*) FROM custom_requests WHERE rider_id = r.id) AS request_count
       FROM riders r ORDER BY r.created_at DESC`);
    ok(res, { count: rows.length, riders: rows });
  }));

  // DELETE /api/admin/riders/:id  { password } — password is the ACTING
  // ADMIN's own login password, re-checked here as step-up confirmation.
  router.delete('/api/admin/riders/:id', requireAdmin((req, res) => {
    const rider = get('SELECT id FROM riders WHERE id = ?', [Number(req.params.id)]);
    if (!rider) return notFound(res, 'User not found');
    const admin = get('SELECT * FROM admins WHERE id = ?', [req.session.subject_id]);
    const { password } = req.body || {};
    if (!admin || !password || !verifyPassword(password, admin.password_hash, admin.password_salt)) {
      return unauthorized(res, 'Your admin password is required to confirm this deletion');
    }
    run('DELETE FROM riders WHERE id = ?', [rider.id]);
    run("DELETE FROM sessions WHERE subject_type = 'rider' AND subject_id = ?", [rider.id]);
    ok(res, { deleted: true });
  }));
}

module.exports = { register };
