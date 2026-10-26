'use strict';
const { all, get, run } = require('../db');
const { ok, created, badRequest, notFound, unauthorized, verifyPassword, isSlug, validateNumbers } = require('../lib/util');
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

    // Chart data: last six calendar months (empty months included so the axis never skips).
    const monthRows = all(
      `SELECT strftime('%Y-%m', created_at) AS m, COUNT(*) AS bookings, COALESCE(SUM(amount_paid_cents),0) AS paid_cents
       FROM bookings WHERE status != 'cancelled' AND created_at >= date('now','start of month','-5 months') GROUP BY m`);
    const byMonth = [];
    for (let i = 5; i >= 0; i--) {
      const key = get(`SELECT strftime('%Y-%m', date('now','start of month','-${i} months')) AS k`).k;
      const r = monthRows.find(x => x.m === key);
      byMonth.push({ month: key, bookings: r ? r.bookings : 0, paid_cents: r ? r.paid_cents : 0 });
    }
    const bookingStatus = all(`SELECT status, COUNT(*) AS n FROM bookings GROUP BY status`);
    const requestPipeline = all(`SELECT status, COUNT(*) AS n FROM custom_requests GROUP BY status`);
    const newEnquiries = get(`SELECT COUNT(*) n FROM enquiries WHERE status = 'new'`).n;
    const holdsExpiring = get(`SELECT COUNT(*) n FROM bookings WHERE status = 'pending' AND payment_due_at IS NOT NULL AND datetime(payment_due_at) <= datetime('now','+24 hours')`).n;
    const unpaidBookings = get(`SELECT COUNT(*) n FROM bookings WHERE status IN ('pending','deposit_paid','balance_due')`).n;
    const topTours = all(
      `SELECT t.name, COUNT(b.id) AS bookings, COALESCE(SUM(b.total_cents),0) AS revenue_cents
       FROM tours t LEFT JOIN departures d ON d.tour_id = t.id
       LEFT JOIN bookings b ON b.departure_id = d.id AND b.status != 'cancelled'
       GROUP BY t.id ORDER BY revenue_cents DESC, bookings DESC LIMIT 6`);

    ok(res, {
      bookings_by_month: byMonth,
      booking_status: bookingStatus,
      request_pipeline: requestPipeline,
      new_enquiries: newEnquiries,
      holds_expiring_24h: holdsExpiring,
      unpaid_bookings: unpaidBookings,
      top_tours: topTours,
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

  /** Validates whatever tour fields are present in `b`, for both create and
   *  edit. Returns an error message string, or null when everything's fine.
   *
   *  Every bound below was reachable before this existed: difficulty_level
   *  has a `CHECK (BETWEEN 1 AND 5)` in schema.sql, so difficultyLevel: 99
   *  surfaced as a bare 500 instead of a message; price_from_cents had no
   *  check at all, so a negative price created a tour that was publicly
   *  listed and bookable for €0; durationDays: 0 produced a departure whose
   *  end date fell before its start; and a slug with a space or slash ends up
   *  in tour-detail.html?slug=… where it silently truncates to a dead link. */
  function validateTourFields(b) {
    if (b.slug !== undefined && !isSlug(b.slug)) {
      return 'slug must be lowercase letters, numbers and single hyphens only (e.g. upper-mustang) — it becomes part of the tour\'s public web address';
    }
    for (const field of ['name', 'region', 'summary', 'ridingStyle']) {
      if (b[field] !== undefined && !String(b[field]).trim()) return `${field} cannot be empty`;
    }
    const nums = validateNumbers({
      durationDays: [b.durationDays, { min: 1, max: 60 }],
      difficultyLevel: [b.difficultyLevel, { min: 1, max: 5 }],
      distanceKm: [b.distanceKm, { min: 1, max: 10000, integer: false }],
      elevationGainM: [b.elevationGainM, { min: 0, max: 100000 }],
      maxAltitudeM: [b.maxAltitudeM, { min: 0, max: 9000 }],
      priceFromCents: [b.priceFromCents, { min: 1 }],
      groupSizeMin: [b.groupSizeMin, { min: 1, max: 100 }],
      groupSizeMax: [b.groupSizeMax, { min: 1, max: 100 }],
    });
    if (nums.error) return nums.error;
    const { groupSizeMin, groupSizeMax } = nums.values;
    if (groupSizeMin !== null && groupSizeMax !== null && groupSizeMin > groupSizeMax) {
      return 'groupSizeMin cannot be greater than groupSizeMax';
    }

    /* ---- universal adventure model fields ----
       Validated here rather than in a second function, so an edit and a
       create cannot diverge — the comment above about a tour being created
       valid and then patched into an invalid state applies just as much to
       an unknown activity or a difficulty dimension of 9. */
    const {
      isKnownActivity, TRIP_FORMATS, ACCOMMODATION_TYPES, validateActivityData,
    } = require('../lib/adventures');

    if (b.activity !== undefined) {
      if (!isKnownActivity(b.activity)) {
        return `Unknown activity "${b.activity}". Add it under Activities first, or pick an existing one.`;
      }
    }
    if (b.tripFormat !== undefined && !TRIP_FORMATS.some(f => f.key === b.tripFormat)) {
      return `tripFormat must be one of: ${TRIP_FORMATS.map(f => f.key).join(', ')}`;
    }
    if (b.accommodationType !== undefined && !ACCOMMODATION_TYPES.some(a => a.key === b.accommodationType)) {
      return `accommodationType must be one of: ${ACCOMMODATION_TYPES.map(a => a.key).join(', ')}`;
    }
    if (b.destinationSlug !== undefined && b.destinationSlug) {
      if (!get('SELECT id FROM destinations WHERE slug = ?', [b.destinationSlug])) {
        return `No destination with slug "${b.destinationSlug}"`;
      }
    }

    const extraNums = validateNumbers({
      elevationLossM: [b.elevationLossM, { min: 0, max: 100000 }],
      depositCents: [b.depositCents, { min: 0 }],
      difficultyFitness: [b.difficultyFitness, { min: 1, max: 5 }],
      difficultyTechnical: [b.difficultyTechnical, { min: 1, max: 5 }],
      difficultyAltitude: [b.difficultyAltitude, { min: 1, max: 5 }],
    });
    if (extraNums.error) return extraNums.error;

    // A deposit larger than the trip price would pass a simple min check and
    // is nonsense; catch it against whichever price this request ends up with.
    const priceNow = b.priceFromCents !== undefined ? Number(b.priceFromCents) : null;
    const depositNow = extraNums.values.depositCents;
    if (depositNow !== null && priceNow !== null && depositNow > priceNow) {
      return 'depositCents cannot be more than priceFromCents';
    }

    for (const field of ['highlights', 'mandatoryCharges', 'optionalExtras', 'faqs']) {
      if (b[field] === undefined) continue;
      if (!Array.isArray(b[field])) return `${field} must be a list`;
    }
    // FAQ entries are objects, not strings, so they get their own shape check
    // rather than being stringified into something the tour page cannot read.
    if (Array.isArray(b.faqs)) {
      for (const f of b.faqs) {
        if (!f || typeof f !== 'object' || !String(f.question || '').trim() || !String(f.answer || '').trim()) {
          return 'Each FAQ needs both a question and an answer';
        }
      }
    }

    if (b.activityData !== undefined) {
      // Validated against the activity this request will leave the tour on,
      // not against whatever it was before — otherwise changing activity and
      // its fields in one save would check the new fields against the old
      // activity's definitions and reject every one of them.
      const activity = b.activity || (b._currentActivity) || 'mountain-biking';
      const result = validateActivityData(activity, b.activityData);
      if (!result.ok) return result.error;
    }
    if (b.impact !== undefined && (typeof b.impact !== 'object' || Array.isArray(b.impact))) {
      return 'impact must be an object';
    }

    return null;
  }

  /* The universal-model columns, as two maps the create and edit handlers
     both build their SQL from. Kept next to validateTourFields so that
     adding a field means touching one place rather than three. */
  const UNIVERSAL_SCALARS = {
    activity: 'activity', destinationSlug: 'destination_slug', descriptionFull: 'description_full',
    tripFormat: 'trip_format', accommodationType: 'accommodation_type', accommodationNotes: 'accommodation_notes',
    elevationLossM: 'elevation_loss_m', depositCents: 'deposit_cents',
    difficultyFitness: 'difficulty_fitness', difficultyTechnical: 'difficulty_technical',
    difficultyAltitude: 'difficulty_altitude',
    suitabilityFitness: 'suitability_fitness', suitabilityTechnical: 'suitability_technical',
    suitabilityAltitude: 'suitability_altitude', suitabilityExperience: 'suitability_experience',
    suitabilityDaily: 'suitability_daily',
    bookingInsurance: 'booking_insurance', bookingVisa: 'booking_visa',
    bookingHealth: 'booking_health', bookingAge: 'booking_age',
  };
  const UNIVERSAL_JSON = {
    highlights: 'highlights_json', mandatoryCharges: 'mandatory_charges_json',
    optionalExtras: 'optional_extras_json', faqs: 'faqs_json',
  };

  // POST /api/admin/tours — create a tour (brief section 42)
  router.post('/api/admin/tours', requireAdmin((req, res) => {
    const b = req.body || {};
    const required = ['slug', 'name', 'region', 'summary', 'durationDays', 'difficultyLevel', 'ridingStyle', 'distanceKm', 'elevationGainM', 'maxAltitudeM', 'priceFromCents'];
    for (const f of required) if (b[f] === undefined || b[f] === '') return badRequest(res, 'Missing field: ' + f);
    const invalid = validateTourFields(b);
    if (invalid) return badRequest(res, invalid);
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
    // The universal-model fields, applied as a follow-up UPDATE rather than
    // being threaded into the INSERT above. The INSERT has 25 positional
    // parameters already and adding twenty more would make a single
    // misplaced comma a very expensive bug; every one of these columns has a
    // usable default from the migration, so the row is valid either way.
    applyUniversalFields(id, b);

    const mapPin = ensureDestinationForDistrict(b.district);
    const removedPins = pruneOrphanedAutoDestinations();
    created(res, { ...get('SELECT * FROM tours WHERE id = ?', [id]), map_pin: mapPin, removed_pins: removedPins });
  }));

  /** Writes whichever universal-model fields are present in `b` onto a tour.
   *  Shared by create and edit, and a no-op when none are sent. */
  function applyUniversalFields(tourId, b) {
    const sets = [];
    const params = [];
    for (const [key, col] of Object.entries(UNIVERSAL_SCALARS)) {
      if (b[key] === undefined) continue;
      sets.push(col + ' = ?');
      params.push(b[key] === '' ? null : b[key]);
    }
    for (const [key, col] of Object.entries(UNIVERSAL_JSON)) {
      if (b[key] === undefined) continue;
      sets.push(col + ' = ?');
      params.push(JSON.stringify(Array.isArray(b[key]) ? b[key] : []));
    }
    if (b.activityData !== undefined) {
      const { validateActivityData } = require('../lib/adventures');
      const current = get('SELECT activity FROM tours WHERE id = ?', [tourId]);
      const activity = b.activity || (current && current.activity) || 'mountain-biking';
      const result = validateActivityData(activity, b.activityData);
      // Already validated in validateTourFields; this call is what converts
      // and trims the values that get stored.
      if (result.ok) { sets.push('activity_data_json = ?'); params.push(JSON.stringify(result.value)); }
    }
    if (b.impact !== undefined) {
      sets.push('impact_json = ?');
      params.push(JSON.stringify(b.impact && typeof b.impact === 'object' ? b.impact : {}));
    }
    if (b.published !== undefined) { sets.push('published = ?'); params.push(b.published ? 1 : 0); }

    if (!sets.length) return false;
    // Every write through this helper stamps updated_at, which is the only
    // thing that touches that column — so "last edited" on the admin list
    // means what it says.
    sets.push("updated_at = datetime('now')");
    params.push(tourId);
    run(`UPDATE tours SET ${sets.join(', ')} WHERE id = ?`, params);
    return true;
  }

  // PATCH /api/admin/tours/:id — edit any subset of fields
  router.patch('/api/admin/tours/:id', requireAdmin((req, res) => {
    const tour = get('SELECT * FROM tours WHERE id = ?', [Number(req.params.id)]);
    if (!tour) return notFound(res, 'Tour not found');
    const b = req.body || {};
    // Edits go through exactly the same checks as creation — otherwise a tour
    // could be created valid and then patched into a state (difficulty 99,
    // negative price) that create would have refused.
    //
    // _currentActivity lets validateTourFields check activityData against the
    // tour's existing activity when this request does not change it. Set here
    // rather than read from the database inside the validator, so the
    // validator stays a pure function of its input.
    b._currentActivity = tour.activity;
    const invalid = validateTourFields(b);
    if (invalid) return badRequest(res, invalid);
    // A deposit must also be checked against the price already stored, not
    // only against one sent in the same request.
    if (b.depositCents !== undefined && b.priceFromCents === undefined) {
      if (Number(b.depositCents) > tour.price_from_cents) {
        return badRequest(res, 'depositCents cannot be more than this tour\'s price (' + tour.price_from_cents + ' cents)');
      }
    }
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
    // The universal-model fields are written by the shared helper, so a
    // request that only touches them (say, just the difficulty dimensions) is
    // a valid edit rather than "no recognised fields".
    const wroteUniversal = applyUniversalFields(tour.id, b);
    if (sets.length === 0 && !wroteUniversal) return badRequest(res, 'No recognised fields to update');
    if (sets.length) {
      params.push(tour.id);
      run(`UPDATE tours SET ${sets.join(', ')} WHERE id = ?`, params);
    }
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

  /** Shared validation for a tour day, so a create and an edit can't drift
   *  apart. Every numeric field used to go into SQLite raw: a distance of
   *  "abc" became NaN and surfaced as a bare 500, and a negative elevation
   *  gain was stored as-is and then rendered as "+-200 m" on the tour page.
   *
   *  `partial` (used by PATCH) only checks what was actually sent, so
   *  correcting one figure doesn't demand the whole row again. */
  function validateTourDay(b, { partial = false } = {}) {
    const has = k => b[k] !== undefined;
    const text = [['title', 'Title'], ['ridingHours', 'Riding hours'], ['terrain', 'Terrain'], ['overnightPlace', 'Overnight place']];
    for (const [key, label] of text) {
      if (!partial || has(key)) {
        if (!String(b[key] ?? '').trim()) return { error: label + ' is required' };
        if (String(b[key]).length > 400) return { error: label + ' is too long (400 characters max)' };
      }
    }
    if (!partial && (b.dayNumber === undefined || b.dayNumber === null || b.dayNumber === '')) {
      return { error: 'Day number is required' };
    }
    const nums = validateNumbers({
      dayNumber: [b.dayNumber, { min: 1, max: 60 }],
      // 0 km is a legitimate rest day, so the floor is 0 rather than 1.
      distanceKm: [b.distanceKm, { min: 0, max: 500, integer: false }],
      elevationGainM: [b.elevationGainM, { min: 0, max: 20000 }],
      elevationLossM: [b.elevationLossM, { min: 0, max: 20000 }],
      // Nepal's highest point is 8,849 m; below sea level is not a thing here.
      highPointM: [b.highPointM, { min: 0, max: 9000 }],
      overnightLat: [b.overnightLat, { min: -90, max: 90, integer: false }],
      overnightLng: [b.overnightLng, { min: -180, max: 180, integer: false }],
    });
    if (nums.error) return { error: nums.error };
    if (!partial) {
      for (const [key, label] of [['distanceKm', 'Distance'], ['elevationGainM', 'Elevation gain'],
                                  ['elevationLossM', 'Elevation loss'], ['highPointM', 'High point']]) {
        if (nums.values[key] === null) return { error: label + ' is required' };
      }
    }
    return { values: nums.values };
  }

  /** GET /api/admin/tours/:id/days — the itinerary plus its totals.
   *
   *  The admin panel used to rebuild its day list by fetching /api/tours
   *  (every tour) purely to turn an id into a slug, then fetching that whole
   *  tour payload (departures, reviews, gallery, guides and all) to read the
   *  `days` array off it. Two requests and a lot of unrelated JSON after
   *  every single save. This is the one it actually wanted.
   *
   *  Totals are computed here rather than in the browser so the admin panel
   *  and any other consumer can't disagree about them. Rest days (0 km) are
   *  counted separately from riding days, and `climb_complete` says whether
   *  every riding day has a climb figure — a partial sum presented as a trip
   *  total would understate the trip. */
  router.get('/api/admin/tours/:id/days', requireAdmin((req, res) => {
    const tour = get(
      'SELECT id, name, slug, duration_days, distance_km, elevation_gain_m, max_altitude_m FROM tours WHERE id = ?',
      [Number(req.params.id)]);
    if (!tour) return notFound(res, 'Tour not found');
    const days = all('SELECT * FROM tour_days WHERE tour_id = ? ORDER BY day_number ASC', [tour.id]);
    const riding = days.filter(d => Number(d.distance_km) > 0);
    const round1 = v => Math.round(v * 10) / 10;
    ok(res, {
      tour_id: tour.id,
      tour_name: tour.name,
      tour_slug: tour.slug,
      // Flagged so the panel can point out an itinerary that doesn't match
      // the duration the tour is sold as.
      duration_days: tour.duration_days,
      days_entered: days.length,
      matches_duration: days.length === tour.duration_days,
      rest_days: days.length - riding.length,
      total_distance_km: riding.length ? round1(riding.reduce((s, d) => s + Number(d.distance_km || 0), 0)) : 0,
      total_climb_m: riding.reduce((s, d) => s + Number(d.elevation_gain_m || 0), 0),
      total_descent_m: riding.reduce((s, d) => s + Number(d.elevation_loss_m || 0), 0),
      climb_complete: riding.length > 0 && riding.every(d => Number(d.elevation_gain_m) > 0),
      highest_point_m: days.length ? Math.max(...days.map(d => Number(d.high_point_m || 0))) : 0,
      // Any gap or duplicate in the day numbering, which is what makes an
      // itinerary read wrong on the tour page.
      numbering_gaps: (() => {
        const nums = days.map(d => d.day_number);
        const gaps = [];
        for (let i = 1; i <= days.length; i++) if (!nums.includes(i)) gaps.push(i);
        return gaps;
      })(),
      // Cross-check against the figures the tour advertises in its own
      // fields, which are what the hero and overview paragraph on the tour
      // page print. When these disagree the page contradicts itself — it can
      // say "max altitude 3,800 m" above an itinerary whose high point is
      // 4,527 m, which is exactly the kind of thing a rider notices and an
      // operator doesn't. Reported rather than auto-corrected: which number
      // is right is a judgement about the tour, not arithmetic.
      stats_check: (() => {
        if (!days.length) return null;
        const itinKm = riding.length ? round1(riding.reduce((s, d) => s + Number(d.distance_km || 0), 0)) : 0;
        const itinClimb = riding.reduce((s, d) => s + Number(d.elevation_gain_m || 0), 0);
        const itinHigh = Math.max(...days.map(d => Number(d.high_point_m || 0)));
        const mismatches = [];
        // Thresholds are deliberately loose: an itinerary legitimately
        // differs a little from a rounded headline figure. These catch
        // contradictions, not rounding.
        if (tour.distance_km && Math.abs(itinKm - tour.distance_km) > Math.max(15, tour.distance_km * 0.2)) {
          mismatches.push({ field: 'distance', itinerary: itinKm, tour: tour.distance_km, unit: 'km' });
        }
        if (tour.elevation_gain_m && Math.abs(itinClimb - tour.elevation_gain_m) > Math.max(1500, tour.elevation_gain_m * 0.3)) {
          mismatches.push({ field: 'total climb', itinerary: itinClimb, tour: tour.elevation_gain_m, unit: 'm' });
        }
        if (tour.max_altitude_m && Math.abs(itinHigh - tour.max_altitude_m) > 400) {
          mismatches.push({ field: 'highest point', itinerary: itinHigh, tour: tour.max_altitude_m, unit: 'm' });
        }
        return { itinerary_distance_km: itinKm, itinerary_climb_m: itinClimb, itinerary_high_m: itinHigh,
                 tour_distance_km: tour.distance_km, tour_climb_m: tour.elevation_gain_m,
                 tour_high_m: tour.max_altitude_m, mismatches };
      })(),
      days,
    });
  }));

  /** POST /api/admin/tours/:id/days/reorder  { ids: [...] }
   *
   *  Renumbers the itinerary to match the order of `ids` — what the up/down
   *  arrows in the panel send. Needed because tour_days has
   *  UNIQUE(tour_id, day_number): swapping two days by PATCHing them one at
   *  a time hits that constraint halfway through and fails, leaving the
   *  itinerary half-renumbered.
   *
   *  Done in two passes through a temporary negative range, which can't
   *  collide with any real day number, so the table is never in a state
   *  where two days share one number. Requires the full list for the same
   *  reason the waypoint reorder does: renumbering a subset would interleave
   *  it with the untouched days. */
  router.post('/api/admin/tours/:id/days/reorder', requireAdmin((req, res) => {
    const tour = get('SELECT id FROM tours WHERE id = ?', [Number(req.params.id)]);
    if (!tour) return notFound(res, 'Tour not found');
    const ids = (req.body || {}).ids;
    if (!Array.isArray(ids) || !ids.length) return badRequest(res, 'ids must be a non-empty array of day ids in their new order');
    const asNumbers = ids.map(Number);
    if (asNumbers.some(n => !Number.isInteger(n))) return badRequest(res, 'ids must all be day ids (whole numbers)');
    if (new Set(asNumbers).size !== asNumbers.length) return badRequest(res, 'ids contains the same day twice');
    const owned = all('SELECT id FROM tour_days WHERE tour_id = ?', [tour.id]).map(r => r.id);
    const foreign = asNumbers.filter(id => !owned.includes(id));
    const missing = owned.filter(id => !asNumbers.includes(id));
    if (foreign.length) return badRequest(res, 'These days are not on this tour: ' + foreign.join(', '));
    if (missing.length) return badRequest(res, 'ids must list every day on this tour — missing: ' + missing.join(', '));

    asNumbers.forEach((id, i) => run('UPDATE tour_days SET day_number = ? WHERE id = ? AND tour_id = ?', [-(i + 1), id, tour.id]));
    asNumbers.forEach((id, i) => run('UPDATE tour_days SET day_number = ? WHERE id = ? AND tour_id = ?', [i + 1, id, tour.id]));
    ok(res, { reordered: asNumbers.length });
  }));

  // POST /api/admin/tours/:id/days
  /** The optional per-day text fields (migration 005). Empty means "not
   *  recorded" and is stored as NULL, never as an empty string the trip page
   *  would then have to second-guess. */
  function dayExtras(b) {
    const LIMITS = { description: 2000, accommodation: 300, meals: 120, notes: 1000 };
    const values = {};
    for (const [k, max] of Object.entries(LIMITS)) {
      if (b[k] === undefined || b[k] === null) { values[k] = null; continue; }
      const s = String(b[k]).trim();
      if (s.length > max) return { error: k + ' is ' + max + ' characters at most' };
      values[k] = s || null;
    }
    return { values };
  }

  router.post('/api/admin/tours/:id/days', requireAdmin((req, res) => {
    const tour = get('SELECT id FROM tours WHERE id = ?', [Number(req.params.id)]);
    if (!tour) return notFound(res, 'Tour not found');
    const b = req.body || {};
    const v = validateTourDay(b);
    if (v.error) return badRequest(res, v.error);
    if (get('SELECT id FROM tour_days WHERE tour_id = ? AND day_number = ?', [tour.id, v.values.dayNumber])) {
      return badRequest(res, 'Day ' + v.values.dayNumber + ' already exists for this tour — edit it, or renumber with the arrows.');
    }
    const extra = dayExtras(b);
    if (extra.error) return badRequest(res, extra.error);
    const id = run(
      `INSERT INTO tour_days (tour_id, day_number, title, distance_km, elevation_gain_m, elevation_loss_m, high_point_m, riding_hours, terrain, overnight_place, overnight_lat, overnight_lng,
                              description, accommodation, meals, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [tour.id, v.values.dayNumber, String(b.title).trim(), v.values.distanceKm, v.values.elevationGainM,
       v.values.elevationLossM, v.values.highPointM, String(b.ridingHours).trim(),
       String(b.terrain).trim(), String(b.overnightPlace).trim(),
       v.values.overnightLat, v.values.overnightLng,
       extra.values.description, extra.values.accommodation, extra.values.meals, extra.values.notes]
    ).lastInsertRowid;
    created(res, get('SELECT * FROM tour_days WHERE id = ?', [id]));
  }));

  // PATCH /api/admin/tours/:tourId/days/:dayId — edit any subset of fields
  router.patch('/api/admin/tours/:tourId/days/:dayId', requireAdmin((req, res) => {
    const day = get('SELECT * FROM tour_days WHERE id = ? AND tour_id = ?', [Number(req.params.dayId), Number(req.params.tourId)]);
    if (!day) return notFound(res, 'Day not found');
    const b = req.body || {};
    const v = validateTourDay(b, { partial: true });
    if (v.error) return badRequest(res, v.error);
    // Moving a day onto a number another day already holds would hit
    // UNIQUE(tour_id, day_number) as a bare 500. Use the reorder endpoint
    // for shuffling; this just refuses the collision clearly.
    if (b.dayNumber !== undefined && v.values.dayNumber !== null && v.values.dayNumber !== day.day_number) {
      const clash = get('SELECT id FROM tour_days WHERE tour_id = ? AND day_number = ? AND id != ?',
        [day.tour_id, v.values.dayNumber, day.id]);
      if (clash) return badRequest(res, 'Day ' + v.values.dayNumber + ' already exists on this tour — use the up/down arrows to reorder instead.');
    }
    const extra = dayExtras(b);
    if (extra.error) return badRequest(res, extra.error);
    const fieldMap = {
      dayNumber: 'day_number', title: 'title', distanceKm: 'distance_km', elevationGainM: 'elevation_gain_m',
      elevationLossM: 'elevation_loss_m', highPointM: 'high_point_m', ridingHours: 'riding_hours', terrain: 'terrain',
      overnightPlace: 'overnight_place', overnightLat: 'overnight_lat', overnightLng: 'overnight_lng',
    };
    // The four optional text fields from migration 005. An empty string
    // clears one (stored as NULL), so a day can go back to having no notes.
    for (const [key, col] of [['description', 'description'], ['accommodation', 'accommodation'], ['meals', 'meals'], ['notes', 'notes']]) {
      if (b[key] === undefined) continue;
      fieldMap['__' + key] = col;
    }
    // Numeric fields take the validated value; text fields are trimmed.
    const numeric = new Set(['dayNumber', 'distanceKm', 'elevationGainM', 'elevationLossM', 'highPointM', 'overnightLat', 'overnightLng']);
    const sets = [];
    const params = [];
    for (const [key, col] of Object.entries(fieldMap)) {
      if (key.startsWith('__')) {
        sets.push(col + ' = ?');
        params.push(extra.values[key.slice(2)]);
        continue;
      }
      if (b[key] === undefined) continue;
      sets.push(col + ' = ?');
      params.push(numeric.has(key) ? v.values[key] : String(b[key]).trim());
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
    // "You forgot to confirm" and "that confirmation was wrong" are different
    // problems and used to return the same 401 and the same sentence, so the
    // admin panel couldn't tell the admin which one had happened.
    if (!password) return badRequest(res, 'Enter your own admin password to confirm this deletion.');
    if (!admin || !verifyPassword(password, admin.password_hash, admin.password_salt)) {
      return unauthorized(res, 'That admin password is incorrect — this account was not deleted.');
    }
    run('DELETE FROM riders WHERE id = ?', [rider.id]);
    run("DELETE FROM sessions WHERE subject_type = 'rider' AND subject_id = ?", [rider.id]);
    ok(res, { deleted: true });
  }));
}

module.exports = { register };
