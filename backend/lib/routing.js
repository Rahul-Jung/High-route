'use strict';
/* ===========================================================================
   ROUTING — turns two pinned coordinates into a line that follows real roads
   and trails, instead of a straight line across the mountains.

   This is what makes the tour route map behave like a consumer maps app: the
   admin drops pins 1-2-3-4 and the drawn route between them is snapped to
   the ways that actually exist in OpenStreetMap.

   Engine: the public OSRM instance FOSSGIS runs for openstreetmap.org's own
   routing tab. Chosen because it needs no API key or account, and it offers
   a `bike` profile, which matters here — a car profile would refuse the
   jeep tracks and singletrack these tours are actually ridden on.

   Deliberately server-side, not in the browser:
     - the result is cached in tour_route_legs, so a tour page never waits on
       (or depends on) a third-party service,
     - one page view would otherwise fire a routing request per leg,
     - and the admin gets a single clear "snap the route" action rather than
       the map silently hammering an endpoint while they drag a pin.

   Everything here fails soft. If the service is down, slow, or has no data
   for a stretch of Nepal, the caller gets a status it can show honestly and
   the map falls back to a clearly-marked dashed straight line. A route map
   that is missing one leg is fine; one that invents a leg is not.
   =========================================================================== */

// Overridable for a self-hosted engine or a different profile. The public
// instance is rate-limited and run on donated hardware, so a deployment
// doing this at volume should point at its own.
const { haversineKm } = require('./geo');

const BASE = (process.env.ROUTING_BASE_URL || 'https://routing.openstreetmap.de').replace(/\/+$/, '');
const PROFILE = process.env.ROUTING_PROFILE || 'bike';          // bike | foot | car
const PROVIDER = 'osrm/' + (process.env.ROUTING_PROVIDER_LABEL || 'fossgis');
const TIMEOUT_MS = Number(process.env.ROUTING_TIMEOUT_MS || 20000);
// OSRM snaps each endpoint to the nearest routable way NO MATTER HOW FAR
// AWAY it is, and then confidently returns a route between those snapped
// points. Two pins in the middle of the Pacific come back as a successful
// 0 km route with the endpoints moved ~1,500 km; a pin on Everest's summit
// snaps 23 km down the valley. Without a ceiling those are indistinguishable
// from a real result, so a mis-dropped pin would draw a route that has
// nothing to do with the itinerary.
//
// 5 km is deliberately generous: a legitimate pin on a Mustang village
// centroid can sit 1–2 km from the nearest mapped track and still route
// correctly along the right valley. Anything beyond this is treated as "no
// usable road near this pin" rather than silently accepted.
const MAX_SNAP_M = Number(process.env.ROUTING_MAX_SNAP_M || 5000);
// Below the ceiling but still worth telling the admin about: the drawn line
// will start this far from their pin.
const SNAP_WARN_M = Number(process.env.ROUTING_SNAP_WARN_M || 500);
// A second way OSRM returns a confident-but-useless answer: when there is no
// through route between two points it will happily go the long way round.
// Dhunche to Syabrubesi is about 6 km apart; with no direct mapped bike route
// the engine returned 153 km via an enormous detour, and a 12 km Langtang leg
// came back as 203 km. Those are not the route anyone rides.
//
// Judged on the ratio to the straight line AND an absolute excess, because
// each alone gives false positives: a legitimate mountain road doubles the
// straight-line distance routinely (so ratio alone is too strict), and a long
// valley road can legitimately add 50 km (so excess alone is too strict).
// Both have to be exceeded.
const MAX_DETOUR_RATIO = Number(process.env.ROUTING_MAX_DETOUR_RATIO || 4);
const MAX_DETOUR_EXCESS_KM = Number(process.env.ROUTING_MAX_DETOUR_EXCESS_KM || 15);
// Set ROUTING_DISABLED=1 to turn snapping off entirely (offline dev, or a
// deployment that would rather not call out). Pins and straight-line
// fallbacks keep working; nothing else changes.
const DISABLED = process.env.ROUTING_DISABLED === '1';

// OSRM's own profile endpoints are named routed-<profile>, and all of them
// are addressed through the /driving/ path regardless of profile — that part
// of the URL is OSRM's service name, not a vehicle choice.
function urlFor(a, b, profile) {
  const coords = `${a.lng},${a.lat};${b.lng},${b.lat}`;
  return `${BASE}/routed-${profile}/route/v1/driving/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
}

/** Perpendicular distance from point p to the segment a-b, in metres.
 *  Equirectangular approximation — at the scale of a few km, well inside
 *  the error of a hand-placed pin. */
function perpDistM(p, a, b) {
  const R = 6371008.8;
  const toX = (lng, lat) => (lng * Math.PI / 180) * R * Math.cos(lat * Math.PI / 180);
  const toY = lat => (lat * Math.PI / 180) * R;
  const latRef = a[0];
  const px = toX(p[1], latRef), py = toY(p[0]);
  const ax = toX(a[1], latRef), ay = toY(a[0]);
  const bx = toX(b[1], latRef), by = toY(b[0]);
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Ramer–Douglas–Peucker. OSRM's full geometry for a single 25 km leg runs
 *  to well over a thousand points; at tour-page zoom that detail is
 *  invisible but it would bloat every tour payload. Iterative rather than
 *  recursive so a pathological geometry can't blow the stack. */
function simplify(points, toleranceM) {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxD = -1, idx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = perpDistM(points[i], points[first], points[last]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > toleranceM && idx > 0) {
      keep[idx] = 1;
      stack.push([first, idx], [idx, last]);
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

const round5 = n => Math.round(n * 1e5) / 1e5;

/** Routes one leg.
 *
 *  Always resolves — never throws — with a `status` the caller can store and
 *  display: 'routed', 'no_route' (the engine ran but found nothing
 *  connecting the two points) or 'error' (service down, timeout, junk
 *  response). Callers draw a dashed straight line and say so for the
 *  latter two. */
async function routeLeg(a, b, opts = {}) {
  const profile = opts.profile || PROFILE;
  if (DISABLED) {
    return { status: 'error', error: 'Route snapping is disabled on this server (ROUTING_DISABLED=1)', profile, provider: PROVIDER };
  }
  // Two pins in the same place is a legitimate itinerary (a rest day at the
  // previous night's stop). There is no route to draw, and asking the engine
  // for one wastes a request on a guaranteed zero.
  if (round5(a.lat) === round5(b.lat) && round5(a.lng) === round5(b.lng)) {
    return {
      status: 'routed', profile, provider: PROVIDER,
      distance_m: 0, duration_s: 0, snap_from_m: 0, snap_to_m: 0,
      coordinates: [[round5(a.lat), round5(a.lng)]],
    };
  }

  let res, body;
  try {
    res = await fetch(urlFor(a, b, profile), {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        // The public instance's usage policy asks for an identifiable agent.
        'User-Agent': 'HighRouteMTB/1.0 (tour route map; self-hosted site)',
        'Accept': 'application/json',
      },
    });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return {
      status: 'error', profile, provider: PROVIDER,
      error: timedOut ? `Routing service did not answer within ${Math.round(TIMEOUT_MS / 1000)}s` : `Could not reach the routing service (${e && e.message})`,
    };
  }
  if (!res.ok) {
    return { status: 'error', profile, provider: PROVIDER, error: `Routing service returned HTTP ${res.status}` };
  }
  try {
    body = await res.json();
  } catch {
    return { status: 'error', profile, provider: PROVIDER, error: 'Routing service returned a response that was not JSON' };
  }

  if (body.code === 'NoRoute') {
    return { status: 'no_route', profile, provider: PROVIDER, error: 'No road or trail in OpenStreetMap connects these two pins' };
  }
  if (body.code !== 'Ok' || !Array.isArray(body.routes) || !body.routes.length) {
    return { status: 'error', profile, provider: PROVIDER, error: 'Routing service said: ' + (body.code || 'unknown error') };
  }

  const route = body.routes[0];
  const coords = route.geometry && Array.isArray(route.geometry.coordinates) ? route.geometry.coordinates : [];
  if (!coords.length) {
    return { status: 'error', profile, provider: PROVIDER, error: 'Routing service returned a route with no shape' };
  }
  // GeoJSON is [lng, lat]; everything in this project is [lat, lng].
  const latLng = coords.map(c => [c[1], c[0]]);
  const simplified = simplify(latLng, Number(opts.toleranceM || 20))
    .map(c => [round5(c[0]), round5(c[1])]);

  // How far the engine had to move each end to reach a routable way. Big
  // numbers mean the pin isn't on a mapped road, so the drawn line won't
  // actually touch it — worth telling the admin about rather than hiding.
  const wp = Array.isArray(body.waypoints) ? body.waypoints : [];
  const snapFrom = wp[0] && Number.isFinite(wp[0].distance) ? wp[0].distance : null;
  const snapTo = wp[1] && Number.isFinite(wp[1].distance) ? wp[1].distance : null;

  // See MAX_SNAP_M: a "successful" route whose endpoints were dragged tens
  // or hundreds of km to find a road is not a route along this itinerary.
  const worstSnap = Math.max(snapFrom === null ? 0 : snapFrom, snapTo === null ? 0 : snapTo);
  if (worstSnap > MAX_SNAP_M) {
    const km = (worstSnap / 1000).toFixed(worstSnap >= 10000 ? 0 : 1);
    return {
      status: 'no_route', profile, provider: PROVIDER,
      snap_from_m: snapFrom, snap_to_m: snapTo,
      error: `The nearest road or trail in OpenStreetMap is ${km} km from one of these pins, `
           + 'so a snapped route would not follow the itinerary. Move the pin onto a mapped track, '
           + 'or leave this leg as a straight line.',
    };
  }

  // See MAX_DETOUR_RATIO: a route that goes the long way round because no
  // direct way is mapped is worse than no route at all, because it looks
  // authoritative and lands a wrong distance on a tour page.
  const straightKm = haversineKm(a, b);
  const routedKm = route.distance / 1000;
  if (straightKm !== null && straightKm > 0.2) {
    const ratio = routedKm / straightKm;
    const excess = routedKm - straightKm;
    if (ratio > MAX_DETOUR_RATIO && excess > MAX_DETOUR_EXCESS_KM) {
      return {
        status: 'no_route', profile, provider: PROVIDER,
        snap_from_m: snapFrom, snap_to_m: snapTo,
        error: `The only route the engine could find between these pins is ${routedKm.toFixed(0)} km `
             + `for a ${straightKm.toFixed(1)} km gap (${ratio.toFixed(0)}x), which means there is no direct `
             + 'mapped trail here and it went the long way round. Left as a straight line instead.',
      };
    }
  }

  return {
    status: 'routed', profile, provider: PROVIDER,
    distance_m: route.distance,
    duration_s: route.duration,
    snap_from_m: snapFrom,
    snap_to_m: snapTo,
    snap_warning: worstSnap > SNAP_WARN_M,
    coordinates: simplified,
  };
}

module.exports = { routeLeg, simplify, PROFILE, PROVIDER, BASE, DISABLED, MAX_SNAP_M, SNAP_WARN_M,
  MAX_DETOUR_RATIO, MAX_DETOUR_EXCESS_KM };
