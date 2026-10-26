'use strict';
const { all, get, run } = require('../db');
const { ok, created, badRequest, notFound, sendJson, validateNumbers } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');
const { haversineKm } = require('../lib/geo');
const routing = require('../lib/routing');

// The pin types an admin can choose. Kept in sync with the CHECK constraint
// on tour_waypoints.kind in schema.sql — if you add one here, add it there
// too or the INSERT fails with a constraint error instead of a clear 400.
const KINDS = ['start', 'waypoint', 'pass', 'viewpoint', 'overnight', 'hazard', 'finish'];

/** Rounds to one decimal place, or returns null for a null input — so a
 *  missing distance stays missing rather than becoming 0.0 (which would
 *  read as "these two pins are in the same place"). */
function round1(v) {
  return v === null || v === undefined ? null : Math.round(v * 10) / 10;
}

/** Loads the cached road/trail-following legs for a tour, keyed by the pin
 *  pair they join. A leg is only valid for the exact pin positions it was
 *  computed from (see tour_route_legs in schema.sql): if a pin has been
 *  dragged since, its cached geometry no longer joins its pins, so it is
 *  treated as not computed rather than drawn in the wrong place. */
function legIndex(tourId) {
  const rows = all('SELECT * FROM tour_route_legs WHERE tour_id = ?', [tourId]);
  const byPair = new Map();
  for (const r of rows) byPair.set(r.from_waypoint_id + ':' + r.to_waypoint_id, r);
  return byPair;
}

const sameCoord = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-5;

function legMatchesPins(leg, from, to) {
  return !!leg
    && sameCoord(leg.from_lat, from.lat) && sameCoord(leg.from_lng, from.lng)
    && sameCoord(leg.to_lat, to.lat) && sameCoord(leg.to_lng, to.lng);
}

/** Decorates an ordered waypoint list with everything the map needs to draw
 *  the leg from each pin to the NEXT one, and to label it on hover:
 *
 *    next_name            - the next pin's name
 *    straight_km_to_next  - great-circle distance. Always present (it needs
 *                           nothing but the two coordinates), and used as
 *                           the fallback when no road route is available.
 *    route                - the snapped road/trail leg, or null if it has
 *                           never been computed. `status` is 'routed',
 *                           'no_route' or 'error'; `km` and `geometry` are
 *                           only meaningful when 'routed'.
 *
 *  Both numbers are carried deliberately. The routed distance is the real
 *  one to show a rider; the straight line is what the map falls back to
 *  drawing when OpenStreetMap has no way between two pins, and conflating
 *  them would mean quietly presenting one as the other. */
function withLegs(rows, byPair) {
  return rows.map((w, i) => {
    const next = rows[i + 1] || null;
    const straight = next ? haversineKm(w, next) : null;
    let route = null;
    if (next) {
      const leg = byPair ? byPair.get(w.id + ':' + next.id) : null;
      if (legMatchesPins(leg, w, next)) {
        let geometry = null;
        if (leg.geometry_json) {
          try { geometry = JSON.parse(leg.geometry_json); } catch { geometry = null; }
        }
        route = {
          status: leg.status,
          km: leg.distance_m === null || leg.distance_m === undefined ? null : round1(leg.distance_m / 1000),
          duration_s: leg.duration_s,
          geometry: geometry,
          snap_from_m: leg.snap_from_m,
          snap_to_m: leg.snap_to_m,
          profile: leg.profile,
          provider: leg.provider,
          error: leg.error,
          computed_at: leg.computed_at,
        };
      }
    }
    return {
      ...w,
      next_name: next ? next.name : null,
      straight_km_to_next: round1(straight),
      route,
    };
  });
}

/** Totals for the figures under the map and in the admin summary.
 *
 *  Kept as two separate numbers that are never added together: road distance
 *  for the legs that actually routed, straight-line for the ones that did
 *  not. `legs_unrouted` says how many fell back, so a partially-snapped
 *  route reports itself honestly instead of presenting a mixed total as if
 *  it were all road distance. */
function routeTotals(decorated) {
  const legs = decorated.slice(0, -1);
  const routed = legs.filter(l => l.route && l.route.status === 'routed' && l.route.km !== null);
  const straight = legs.filter(l => l.straight_km_to_next !== null);
  return {
    total_route_km: routed.length ? round1(routed.reduce((s, l) => s + l.route.km, 0)) : null,
    total_straight_km: straight.length ? round1(straight.reduce((s, l) => s + l.straight_km_to_next, 0)) : null,
    legs_total: legs.length,
    legs_routed: routed.length,
    legs_unrouted: legs.length - routed.length,
    legs_missing_coords: legs.length - straight.length,
    routing_profile: routing.PROFILE,
    routing_available: !routing.DISABLED,
  };
}

/** The one read path. Used by the public tour payload, the public waypoints
 *  endpoint and the admin editor alike, so all three agree on ordering, on
 *  the computed legs and on the totals. Ordered by seq then id: seq is
 *  intentionally not UNIQUE (see schema.sql), so `id` breaks ties stably. */
function waypointsForTour(tourId) {
  const rows = all(
    'SELECT * FROM tour_waypoints WHERE tour_id = ? ORDER BY seq ASC, id ASC',
    [tourId]
  );
  const decorated = withLegs(rows, legIndex(tourId));
  return { waypoints: decorated, ...routeTotals(decorated) };
}

/** Recomputes the snapped route for a tour, leg by leg, and caches it.
 *
 *  Only fetches what it has to: a leg whose two pins have not moved since it
 *  was computed is reused, so adding an eleventh pin to a ten-pin route
 *  costs one routing request, not ten. `force` re-fetches everything (for
 *  when OpenStreetMap itself has improved, or the profile changed).
 *
 *  Requests go out one at a time with a small gap. The routing instance is a
 *  free service on donated hardware; firing a whole tour's legs at it in
 *  parallel is how you get rate-limited and deserve it. */
async function snapRoute(tourId, { force = false, profile = null } = {}) {
  const rows = all('SELECT * FROM tour_waypoints WHERE tour_id = ? ORDER BY seq ASC, id ASC', [tourId]);
  const byPair = legIndex(tourId);
  const useProfile = profile || routing.PROFILE;

  // Any cached leg that is no longer between two consecutive pins is dead
  // weight after a reorder or a delete — drop it so the table does not grow
  // a tail of geometry nothing references.
  const live = new Set();
  for (let i = 0; i < rows.length - 1; i++) live.add(rows[i].id + ':' + rows[i + 1].id);
  for (const [key, leg] of byPair) {
    if (!live.has(key)) run('DELETE FROM tour_route_legs WHERE id = ?', [leg.id]);
  }

  const summary = { legs: Math.max(0, rows.length - 1), routed: 0, reused: 0, no_route: 0, errors: 0, warnings: [] };

  for (let i = 0; i < rows.length - 1; i++) {
    const from = rows[i], to = rows[i + 1];
    const cached = byPair.get(from.id + ':' + to.id);
    if (!force && legMatchesPins(cached, from, to) && cached.profile === useProfile && cached.status === 'routed') {
      summary.reused++;
      continue;
    }

    const res = await routing.routeLeg(
      { lat: from.lat, lng: from.lng },
      { lat: to.lat, lng: to.lng },
      { profile: useProfile }
    );

    run('DELETE FROM tour_route_legs WHERE from_waypoint_id = ? AND to_waypoint_id = ?', [from.id, to.id]);
    run(
      `INSERT INTO tour_route_legs
         (tour_id, from_waypoint_id, to_waypoint_id, status, provider, profile,
          distance_m, duration_s, snap_from_m, snap_to_m,
          from_lat, from_lng, to_lat, to_lng, geometry_json, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [tourId, from.id, to.id, res.status, res.provider || null, res.profile || useProfile,
       res.distance_m === undefined ? null : res.distance_m,
       res.duration_s === undefined ? null : res.duration_s,
       res.snap_from_m === undefined ? null : res.snap_from_m,
       res.snap_to_m === undefined ? null : res.snap_to_m,
       from.lat, from.lng, to.lat, to.lng,
       res.coordinates ? JSON.stringify(res.coordinates) : null,
       res.error || null]
    );

    const arrow = ' → ';
    if (res.status === 'routed') {
      summary.routed++;
      if (res.snap_warning) {
        const worst = Math.max(res.snap_from_m || 0, res.snap_to_m || 0);
        summary.warnings.push(
          from.name + arrow + to.name + ': the nearest mapped track is ' + Math.round(worst)
          + ' m from one of these pins, so the drawn route starts slightly off the pin.'
          + ' Drag the pin onto the trail for a closer fit.'
        );
      }
    } else if (res.status === 'no_route') {
      summary.no_route++;
      summary.warnings.push(from.name + arrow + to.name + ': ' + res.error);
    } else {
      summary.errors++;
      summary.warnings.push(from.name + arrow + to.name + ': ' + res.error);
    }

    // Courtesy gap between requests to a shared public service.
    if (i < rows.length - 2) await new Promise(r => setTimeout(r, 350));
  }

  return summary;
}

/** Shared validation for create and edit. `partial` mode (used by PATCH)
 *  only checks the fields that were actually sent, so editing just a pin's
 *  name doesn't demand its coordinates again. */
function validateWaypoint(b, { partial = false } = {}) {
  const has = key => b[key] !== undefined;

  if (!partial || has('name')) {
    const name = String(b.name ?? '').trim();
    if (!name) return { error: 'Every pin needs a name — it\'s what riders see when they hover it' };
    if (name.length > 120) return { error: 'Pin name is too long (120 characters max)' };
  }
  if (!partial || has('kind')) {
    if (b.kind !== undefined && b.kind !== null && b.kind !== '' && !KINDS.includes(b.kind)) {
      return { error: 'kind must be one of ' + KINDS.join(', ') };
    }
  }
  // lat/lng are REAL NOT NULL with a CHECK range in the table. Validating
  // here turns "SQLite constraint failed" (a bare 500) into a sentence that
  // says which coordinate was wrong, and catches the Nepal-plausibility
  // case the CHECK can't.
  // On create both coordinates are mandatory — a pin with half a position
  // can't be plotted. On a PATCH, each is checked only if it was sent, so
  // nudging a pin's latitude doesn't require restating its longitude, and
  // neither can be blanked out to NULL (the column is NOT NULL).
  const blank = v => v === undefined || v === null || v === '';
  if (!partial) {
    if (blank(b.lat)) return { error: 'lat is required — click the map to place the pin, or type a latitude' };
    if (blank(b.lng)) return { error: 'lng is required — click the map to place the pin, or type a longitude' };
  } else {
    if (has('lat') && blank(b.lat)) return { error: 'lat cannot be cleared — a pin needs a position. Delete the pin instead.' };
    if (has('lng') && blank(b.lng)) return { error: 'lng cannot be cleared — a pin needs a position. Delete the pin instead.' };
  }
  const nums = validateNumbers({
    lat: [b.lat, { min: -90, max: 90, integer: false }],
    lng: [b.lng, { min: -180, max: 180, integer: false }],
    // Nepal's lowest point is ~60 m (Kechana Kalan) and its highest is
    // 8,849 m (Everest), so anything outside this is a typo, not a place.
    elevationM: [b.elevationM, { min: -500, max: 9000 }],
    dayNumber: [b.dayNumber, { min: 1, max: 60 }],
    seq: [b.seq, { min: 1, max: 10000 }],
  });
  if (nums.error) return { error: nums.error };

  return { values: nums.values };
}

/** Next free position at the end of a tour's route. */
function nextSeq(tourId) {
  const row = get('SELECT MAX(seq) AS m FROM tour_waypoints WHERE tour_id = ?', [tourId]);
  return (row && row.m ? row.m : 0) + 1;
}

function tourOr404(res, idOrSlug) {
  const byId = Number(idOrSlug);
  const tour = Number.isInteger(byId) && byId > 0
    ? get('SELECT id, name, slug FROM tours WHERE id = ?', [byId])
    : get('SELECT id, name, slug FROM tours WHERE slug = ?', [String(idOrSlug)]);
  if (!tour) { notFound(res, 'Tour not found'); return null; }
  return tour;
}

function register(router) {
  // -------------------------------------------------------------------
  // PUBLIC READ — GET /api/tours/:slug/waypoints
  // The same data is already embedded in GET /api/tours/:slug (see
  // routes/tours.js), so the tour page needs no extra request. This
  // standalone endpoint exists for the admin editor, which reloads just
  // the pin list after every edit rather than refetching a whole tour.
  // -------------------------------------------------------------------
  router.get('/api/tours/:slug/waypoints', (req, res) => {
    const tour = tourOr404(res, req.params.slug);
    if (!tour) return;
    const payload = waypointsForTour(tour.id);
    ok(res, { tour_id: tour.id, tour_name: tour.name, count: payload.waypoints.length, ...payload });
  });

  // -------------------------------------------------------------------
  // ADMIN WRITE
  // -------------------------------------------------------------------

  // POST /api/admin/tours/:id/waypoints — drop a new pin at the end of the
  // route. The admin panel calls this on every map click.
  router.post('/api/admin/tours/:id/waypoints', requireAdmin((req, res) => {
    const tour = tourOr404(res, req.params.id);
    if (!tour) return;
    const b = req.body || {};
    const v = validateWaypoint(b);
    if (v.error) return badRequest(res, v.error);
    if (v.values.dayNumber !== null) {
      // A pin can belong to no day at all, but if it names one, that day
      // should exist — otherwise the tour page groups it under a heading
      // that isn't there.
      const day = get('SELECT id FROM tour_days WHERE tour_id = ? AND day_number = ?', [tour.id, v.values.dayNumber]);
      if (!day) return badRequest(res, 'This tour has no day ' + v.values.dayNumber + ' yet — add that day first, or leave the day blank');
    }
    const seq = v.values.seq !== null ? v.values.seq : nextSeq(tour.id);
    const id = run(
      `INSERT INTO tour_waypoints (tour_id, seq, day_number, name, kind, lat, lng, elevation_m, notes)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [tour.id, seq, v.values.dayNumber, String(b.name).trim(), b.kind || 'waypoint',
       v.values.lat, v.values.lng, v.values.elevationM, b.notes ? String(b.notes).trim() : null]
    ).lastInsertRowid;
    created(res, get('SELECT * FROM tour_waypoints WHERE id = ?', [id]));
  }));

  // PATCH /api/admin/tours/:tourId/waypoints/:wpId — edit any subset. Used
  // both by the pin's edit form and by dragging an existing pin to a new
  // position on the map (which sends just lat/lng).
  router.patch('/api/admin/tours/:tourId/waypoints/:wpId', requireAdmin((req, res) => {
    const tour = tourOr404(res, req.params.tourId);
    if (!tour) return;
    const wp = get('SELECT * FROM tour_waypoints WHERE id = ? AND tour_id = ?', [Number(req.params.wpId), tour.id]);
    if (!wp) return notFound(res, 'Pin not found on this tour');
    const b = req.body || {};
    const v = validateWaypoint(b, { partial: true });
    if (v.error) return badRequest(res, v.error);
    if (b.dayNumber !== undefined && v.values.dayNumber !== null) {
      const day = get('SELECT id FROM tour_days WHERE tour_id = ? AND day_number = ?', [tour.id, v.values.dayNumber]);
      if (!day) return badRequest(res, 'This tour has no day ' + v.values.dayNumber + ' yet — add that day first, or leave the day blank');
    }

    const sets = [];
    const params = [];
    const put = (col, val) => { sets.push(col + ' = ?'); params.push(val); };
    if (b.name !== undefined) put('name', String(b.name).trim());
    if (b.kind !== undefined) put('kind', b.kind || 'waypoint');
    if (b.lat !== undefined) put('lat', v.values.lat);
    if (b.lng !== undefined) put('lng', v.values.lng);
    if (b.elevationM !== undefined) put('elevation_m', v.values.elevationM);
    if (b.dayNumber !== undefined) put('day_number', v.values.dayNumber);
    if (b.seq !== undefined) put('seq', v.values.seq);
    if (b.notes !== undefined) put('notes', b.notes ? String(b.notes).trim() : null);
    if (!sets.length) return badRequest(res, 'No recognised fields to update');

    params.push(wp.id);
    run(`UPDATE tour_waypoints SET ${sets.join(', ')} WHERE id = ?`, params);
    ok(res, get('SELECT * FROM tour_waypoints WHERE id = ?', [wp.id]));
  }));

  // POST /api/admin/tours/:id/waypoints/reorder  { ids: [3,1,2] }
  // Renumbers seq to match the order of `ids`. The admin panel's up/down
  // arrows send the whole reordered list, so one request leaves the route
  // in a consistent state — no intermediate order is ever persisted.
  router.post('/api/admin/tours/:id/waypoints/reorder', requireAdmin((req, res) => {
    const tour = tourOr404(res, req.params.id);
    if (!tour) return;
    const ids = (req.body || {}).ids;
    if (!Array.isArray(ids) || !ids.length) return badRequest(res, 'ids must be a non-empty array of pin ids in their new order');
    const owned = all('SELECT id FROM tour_waypoints WHERE tour_id = ?', [tour.id]).map(r => r.id);
    const asNumbers = ids.map(Number);
    if (asNumbers.some(n => !Number.isInteger(n))) return badRequest(res, 'ids must all be pin ids (whole numbers)');
    if (new Set(asNumbers).size !== asNumbers.length) return badRequest(res, 'ids contains the same pin twice');
    // Refuse a partial list outright. Renumbering a subset would interleave
    // it with the untouched pins' old seq values and silently scramble the
    // route — far worse than an error message.
    const missing = owned.filter(id => !asNumbers.includes(id));
    const foreign = asNumbers.filter(id => !owned.includes(id));
    if (foreign.length) return badRequest(res, 'These pins are not on this tour: ' + foreign.join(', '));
    if (missing.length) return badRequest(res, 'ids must list every pin on this tour — missing: ' + missing.join(', '));

    asNumbers.forEach((id, i) => run('UPDATE tour_waypoints SET seq = ? WHERE id = ? AND tour_id = ?', [i + 1, id, tour.id]));
    ok(res, { reordered: asNumbers.length, ...waypointsForTour(tour.id) });
  }));

  // DELETE /api/admin/tours/:tourId/waypoints/:wpId
  // Closes the seq gap afterwards so the route stays 1..n and the numbers
  // the admin sees match the pin labels on the map.
  router.delete('/api/admin/tours/:tourId/waypoints/:wpId', requireAdmin((req, res) => {
    const tour = tourOr404(res, req.params.tourId);
    if (!tour) return;
    const wp = get('SELECT id FROM tour_waypoints WHERE id = ? AND tour_id = ?', [Number(req.params.wpId), tour.id]);
    if (!wp) return notFound(res, 'Pin not found on this tour');
    run('DELETE FROM tour_waypoints WHERE id = ?', [wp.id]);
    all('SELECT id FROM tour_waypoints WHERE tour_id = ? ORDER BY seq ASC, id ASC', [tour.id])
      .forEach((r, i) => run('UPDATE tour_waypoints SET seq = ? WHERE id = ?', [i + 1, r.id]));
    ok(res, { deleted: true, ...waypointsForTour(tour.id) });
  }));

  // POST /api/admin/tours/:id/route/snap  { force?, profile? }
  // Snaps the straight pin-to-pin line onto real roads and trails — the
  // button that turns a set of dropped pins into a route that follows the
  // ground, the way a consumer maps app does.
  //
  // Synchronous on purpose: an admin needs to know whether it worked, and
  // which legs had no road data, before they walk away from the page. It
  // reuses unchanged legs, so the common case (one pin added) is a single
  // routing request even on a long route.
  router.post('/api/admin/tours/:id/route/snap', requireAdmin(async (req, res) => {
    const tour = tourOr404(res, req.params.id);
    if (!tour) return;
    const b = req.body || {};
    if (b.profile !== undefined && b.profile !== null && b.profile !== ''
        && !['bike', 'foot', 'car'].includes(b.profile)) {
      return badRequest(res, 'profile must be one of bike, foot, car');
    }
    const count = get('SELECT COUNT(*) n FROM tour_waypoints WHERE tour_id = ?', [tour.id]).n;
    if (count < 2) {
      return badRequest(res, 'A route needs at least two pins before it can be snapped to roads — '
        + 'click the map to add another.');
    }
    let summary;
    try {
      summary = await snapRoute(tour.id, { force: !!b.force, profile: b.profile || null });
    } catch (e) {
      // routeLeg never throws, so reaching here means something structural
      // (a DB write failing mid-run). Report it rather than leaving the
      // admin staring at a spinner.
      return sendJson(res, 502, { error: 'Snapping the route failed partway through: ' + e.message });
    }
    ok(res, { ...summary, ...waypointsForTour(tour.id) });
  }));

  // DELETE /api/admin/tours/:id/route/snap — throw away the snapped
  // geometry and go back to plain straight lines between pins. Useful when
  // OpenStreetMap's data for an area is worse than the straight line, which
  // in parts of the high Himalaya it genuinely is.
  router.delete('/api/admin/tours/:id/route/snap', requireAdmin((req, res) => {
    const tour = tourOr404(res, req.params.id);
    if (!tour) return;
    const n = get('SELECT COUNT(*) n FROM tour_route_legs WHERE tour_id = ?', [tour.id]).n;
    run('DELETE FROM tour_route_legs WHERE tour_id = ?', [tour.id]);
    ok(res, { cleared: n, ...waypointsForTour(tour.id) });
  }));

  // POST /api/admin/tours/:id/waypoints/import-days
  // One-click start for a tour that already has an itinerary: copies the
  // overnight stops the admin has ALREADY entered in tour_days (real data,
  // nothing invented) into pins, so they don't retype coordinates they've
  // typed once. Days with no coordinates are skipped and reported by name.
  // Refuses if the route already has pins, so it can't silently duplicate
  // a route someone has already drawn.
  router.post('/api/admin/tours/:id/waypoints/import-days', requireAdmin((req, res) => {
    const tour = tourOr404(res, req.params.id);
    if (!tour) return;
    const existing = get('SELECT COUNT(*) n FROM tour_waypoints WHERE tour_id = ?', [tour.id]).n;
    if (existing > 0) {
      return badRequest(res, 'This tour already has ' + existing + ' pin(s) — delete them first if you want to re-import from the itinerary');
    }
    const days = all('SELECT * FROM tour_days WHERE tour_id = ? ORDER BY day_number ASC', [tour.id]);
    if (!days.length) return badRequest(res, 'This tour has no day-by-day itinerary yet — add days first, or just click the map to place pins');
    const usable = days.filter(d => d.overnight_lat !== null && d.overnight_lng !== null);
    const skipped = days.filter(d => d.overnight_lat === null || d.overnight_lng === null);
    if (!usable.length) {
      return badRequest(res, 'None of this tour\'s ' + days.length + ' day(s) have overnight coordinates recorded, so there is nothing to import — click the map to place pins instead');
    }
    usable.forEach((d, i) => {
      run(
        `INSERT INTO tour_waypoints (tour_id, seq, day_number, name, kind, lat, lng, elevation_m, notes)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [tour.id, i + 1, d.day_number, d.overnight_place,
         i === 0 ? 'start' : i === usable.length - 1 ? 'finish' : 'overnight',
         d.overnight_lat, d.overnight_lng, d.high_point_m || null,
         'Imported from day ' + d.day_number + ' of the itinerary.']
      );
    });
    created(res, {
      imported: usable.length,
      skipped: skipped.map(d => ({ day_number: d.day_number, overnight_place: d.overnight_place })),
      ...waypointsForTour(tour.id),
    });
  }));
}

module.exports = { register, waypointsForTour, snapRoute, KINDS };
