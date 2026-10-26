'use strict';
/**
 * Simulates two riders moving along the Upper Mustang route and posts real
 * GPS pings to the running server (http://localhost:4000 by default), so
 * /tracker.html has something live to show.
 *
 * DEMO ONLY — see README "GPS & safety disclaimer". This interpolates in a
 * straight line between overnight villages; it is not a real trail path.
 *
 * POST /api/gps/ping is guide/admin-only (it used to be open to anyone, which
 * meant any stranger could write positions into a live tracking feed), so this
 * script signs in first. It uses the same ADMIN_EMAIL/ADMIN_PASSWORD the server
 * bootstraps with, or --email=/--password= if you'd rather pass a guide's.
 *
 * Usage:  node simulate-gps.js [--base=http://localhost:4000] [--speed=1]
 *                              [--email=... --password=...]
 */
const arg = (name, fallback) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const BASE = arg('base', 'http://localhost:4000');
const SPEED = Number(arg('speed', '1')); // pings/sec
const EMAIL = arg('email', process.env.ADMIN_EMAIL || '');
const PASSWORD = arg('password', process.env.ADMIN_PASSWORD || '');

const KATHMANDU = { lat: 27.7172, lng: 85.3240, alt: 1400 };

let authHeader = null;

/** Signs in as an admin (or, if --email looks like a guide's, falls back to the
 *  guide login) and keeps the bearer token for every later ping. */
async function signIn() {
  if (!EMAIL || !PASSWORD) {
    throw new Error([
      'Posting GPS pings needs a guide or admin session.',
      '  Set ADMIN_EMAIL and ADMIN_PASSWORD (the same ones server.js uses), or pass',
      '  --email=you@example.com --password=... for a guide account.',
    ].join('\n'));
  }
  for (const path of ['/api/admin/login', '/api/guide/login']) {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    if (res.ok) {
      const data = await res.json();
      authHeader = { Authorization: 'Bearer ' + data.token };
      console.log(`Signed in via ${path} as ${EMAIL}.`);
      return;
    }
  }
  throw new Error(`Could not sign in as ${EMAIL} — check the email/password, then try again.`);
}

async function main() {
  await signIn();
  console.log('Looking up the Upper Mustang tour and its next departure...');
  const tourRes = await fetch(`${BASE}/api/tours/upper-mustang`);
  if (!tourRes.ok) throw new Error('Could not reach the API at ' + BASE + ' — is server.js running?');
  const tour = await tourRes.json();
  const departure = tour.departures[0];
  if (!departure) throw new Error('No departures found for upper-mustang — did seed.js run?');
  console.log(`Simulating departure #${departure.id} (${departure.start_date}) with ${tour.days.length} route days.`);

  const waypoints = [KATHMANDU, ...tour.days.map(d => ({ lat: d.overnight_lat, lng: d.overnight_lng, alt: d.high_point_m }))];

  const riders = [
    { label: 'rider-1', offsetLat: 0, offsetLng: 0 },
    { label: 'rider-2', offsetLat: 0.004, offsetLng: -0.003 },
  ];

  const STEPS_PER_LEG = 24;
  console.log(`Posting pings every ${Math.round(1000 / SPEED)}ms. Ctrl+C to stop. Open /tracker.html?departureId=${departure.id} to watch.`);

  while (true) {
    for (let leg = 0; leg < waypoints.length - 1; leg++) {
      const a = waypoints[leg], b = waypoints[leg + 1];
      for (let step = 0; step <= STEPS_PER_LEG; step++) {
        const t = step / STEPS_PER_LEG;
        const lat = a.lat + (b.lat - a.lat) * t;
        const lng = a.lng + (b.lng - a.lng) * t;
        const alt = Math.round(a.alt + (b.alt - a.alt) * t);
        const speed = Math.round(8 + Math.random() * 10);

        await Promise.all(riders.map(r => postPing(departure.id, r.label, lat + r.offsetLat, lng + r.offsetLng, alt, speed)));
        await sleep(1000 / SPEED);
      }
    }
    console.log('Reached the end of the route — looping back to Kathmandu for a continuous demo.');
  }
}

async function postPing(departureId, label, lat, lng, altitudeM, speedKmh) {
  try {
    const res = await fetch(`${BASE}/api/gps/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader },
      body: JSON.stringify({ departureId, label, lat, lng, altitudeM, speedKmh, source: 'simulated' }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error(`Ping rejected (${res.status}): ${body.error || res.statusText}`);
    }
  } catch (e) {
    console.error('Ping failed:', e.message);
  }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error(err.message); process.exit(1); });
