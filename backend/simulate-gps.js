'use strict';
/**
 * Simulates two riders moving along the Upper Mustang route and posts real
 * GPS pings to the running server (http://localhost:4000 by default), so
 * /tracker.html has something live to show.
 *
 * DEMO ONLY — see README "GPS & safety disclaimer". This interpolates in a
 * straight line between overnight villages; it is not a real trail path.
 *
 * Usage:  node simulate-gps.js [--base http://localhost:4000] [--speed 1]
 */
const BASE = (process.argv.find(a => a.startsWith('--base=')) || '--base=http://localhost:4000').split('=')[1];
const SPEED = Number((process.argv.find(a => a.startsWith('--speed=')) || '--speed=1').split('=')[1]); // pings/sec

const KATHMANDU = { lat: 27.7172, lng: 85.3240, alt: 1400 };

async function main() {
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
    await fetch(`${BASE}/api/gps/ping`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ departureId, label, lat, lng, altitudeM, speedKmh, source: 'simulated' }),
    });
  } catch (e) {
    console.error('Ping failed:', e.message);
  }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error(err.message); process.exit(1); });
