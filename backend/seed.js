'use strict';
const crypto = require('crypto');
const { run, get, all } = require('./db');
const { hashPassword } = require('./lib/util');

// Demo-only credential, printed at seed time and documented in README.
// Every seeded guide shares this password so /guide.html is usable immediately.
const DEMO_GUIDE_PASSWORD = 'ride-nepal-2026';

// ----------------------------------------------------------------------------
// Admin bootstrap. Runs on every startup (not just first seed) and is a no-op
// once an admin exists. This replaces the old single shared ADMIN_TOKEN env
// var: set ADMIN_EMAIL/ADMIN_PASSWORD yourself for a known login, or let it
// generate a random one-time password (printed once, never stored in plain
// text — only its scrypt hash is saved).
// ----------------------------------------------------------------------------
function ensureAdmin() {
  if (get('SELECT COUNT(*) n FROM admins').n > 0) return;
  const email = process.env.ADMIN_EMAIL || 'admin@highroutemtb.demo';
  const usingEnvPassword = !!process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const { hash, salt } = hashPassword(password);
  run('INSERT INTO admins (name, email, password_hash, password_salt) VALUES (?,?,?,?)',
    ['Operations Admin', email, hash, salt]);
  console.log('Created admin account — sign in at /admin.html');
  console.log('  email:    ' + email);
  console.log('  password: ' + (usingEnvPassword ? '(the one from your ADMIN_PASSWORD env var)' : password + '   <-- generated, save it now, it will not be shown again'));
}

// ----------------------------------------------------------------------------
// Add-on catalog bootstrap. Runs on every startup, same as ensureAdmin — a
// one-time INSERT of the published add-on list (this used to be a hardcoded
// price object in routes/bookings.js; now it's an admin-editable table, see
// routes/addons.js). No-ops once any row exists, so an admin's later price
// edits are never overwritten by a restart.
// ----------------------------------------------------------------------------
function ensureAddonCatalog() {
  if (get('SELECT COUNT(*) n FROM addon_catalog').n > 0) return;
  const addon = (key, label, priceCents, unit, order, description) => run(
    `INSERT INTO addon_catalog (key, label, description, price_cents, unit, sort_order) VALUES (?,?,?,?,?,?)`,
    [key, label, description, priceCents, unit, order]);
  addon('bike_rental', 'Bike rental', 18000, 'per_rider', 1, 'A full-suspension trail/enduro bike sized and serviced for you.');
  addon('e_bike', 'E-bike upgrade', 32000, 'per_rider', 2, 'Ride an e-MTB instead of a standard rental for this trip.');
  addon('airport_transfer', 'Airport transfer', 3500, 'per_rider', 3, 'Private transfer between Kathmandu airport and your hotel.');
  addon('extra_hotel_night', 'Extra hotel night', 6000, 'per_rider', 4, 'One additional night before or after the tour.');
  addon('extra_riding_day', 'Extra riding day', 12000, 'per_rider', 5, 'A guided bonus day added to the itinerary.');
  addon('porter', 'Porter', 15000, 'per_rider', 6, 'A porter to carry your main bag between overnight stops.');
  addon('photography', 'Photography package', 22000, 'per_rider', 7, 'A dedicated photographer for part of the trip, edited photos after.');
  addon('gopro_video', 'GoPro / video package', 9000, 'per_rider', 8, 'On-trail action footage, edited into a short video.');
  addon('private_guide', 'Private guide', 45000, 'per_booking', 9, 'A dedicated guide for your group instead of joining the shared departure guide.');
  addon('single_room', 'Single room upgrade', 21000, 'per_rider', 10, 'Your own room instead of twin-share accommodation.');
  addon('insurance_assistance', 'Insurance assistance', 4000, 'per_rider', 11, 'Help arranging suitable travel/medical insurance for the trip.');
}

// ----------------------------------------------------------------------------
// Cancellation refund tiers. Demo defaults an admin can edit/replace from the
// admin panel's Refunds tab (see routes/bookings.js's computeRefundPercent
// and routes/admin.js's cancellation-rules CRUD) — never presented to riders
// as fixed/unchangeable.
// ----------------------------------------------------------------------------
function ensureCancellationRules() {
  if (get('SELECT COUNT(*) n FROM cancellation_rules').n > 0) return;
  const rule = (days, pct) => run('INSERT INTO cancellation_rules (min_days_before_departure, refund_percent) VALUES (?,?)', [days, pct]);
  rule(30, 90);
  rule(14, 50);
  rule(7, 25);
  rule(0, 0);
}

// ----------------------------------------------------------------------------
// NOTE ON COORDINATES: the lat/lng values below are approximate placements of
// real Nepal villages/regions, hand-typed for this demo. They are NOT surveyed
// GPX waypoints and must not be used for real navigation, route-finding, or
// emergency response. See README.md → "GPS & safety disclaimer".
//
// NOTE ON IMAGES: image URLs point at real, freely-licensed Unsplash trail/
// mountain-biking photography (not random picsum.photos placeholders), each
// one picked to actually match its tour/destination/caption. Swap for your
// own photography via the admin gallery/tour forms whenever you have it.
// ----------------------------------------------------------------------------

function seed() {
  ensureAdmin();
  ensureAddonCatalog();
  ensureCancellationRules();

  const tourCount = get('SELECT COUNT(*) AS n FROM tours').n;
  if (tourCount > 0) {
    console.log('Database already seeded — skipping. Delete data/highroute.db to reseed.');
    return;
  }

  console.log('Seeding database...');

  // --- Guides -------------------------------------------------------------
  const guidePw = hashPassword(DEMO_GUIDE_PASSWORD);

  const tashi = run(`INSERT INTO guides (name, role, years_experience, languages, specialties, rating, trips_led, bio, photo_url, email, password_hash, password_salt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['Tashi Sherpa', 'Lead MTB Guide', 12, 'Nepali, English, French', 'Enduro, high-altitude expeditions',
     4.9, 140, 'Wilderness First Responder certified. Grew up riding the Kathmandu valley rim.',
     'https://images.unsplash.com/photo-1758244241019-4092edcdba35?auto=format&fit=crop&w=800&q=80', 'tashi@highroutemtb.demo', guidePw.hash, guidePw.salt]).lastInsertRowid;

  const pemba = run(`INSERT INTO guides (name, role, years_experience, languages, specialties, rating, trips_led, bio, photo_url, email, password_hash, password_salt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['Pemba Gurung', 'Technical Trail Guide', 8, 'Nepali, English, Hindi', 'Downhill, technical descents',
     4.8, 95, 'Former downhill racer turned expedition guide.', 'https://images.unsplash.com/photo-1673969694327-7f54454a0d86?auto=format&fit=crop&w=800&q=80', 'pemba@highroutemtb.demo', guidePw.hash, guidePw.salt]).lastInsertRowid;

  // --- Tours ----------------------------------------------------------------
  const tour = (slug, name, region, summary, days, level, style, dist, gain, alt, price, season, gmin, gmax, img) => run(
    `INSERT INTO tours (slug, name, region, summary, duration_days, difficulty_level, riding_style, distance_km, elevation_gain_m, max_altitude_m, price_from_cents, currency, image_url, best_season, group_size_min, group_size_max)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [slug, name, region, summary, days, level, style, dist, gain, alt, price, 'EUR', img, season, gmin, gmax]).lastInsertRowid;

  const mustangId = tour('upper-mustang', 'Upper Mustang — Kingdom of Dirt', 'Mustang',
    "Ten days of canyon singletrack, riverbed gravel and high alpine passes through Nepal's former forbidden kingdom, finishing inside the walled city of Lo Manthang.",
    10, 5, 'Enduro', 320, 8000, 4200, 185000, 'Sep – Nov', 6, 10, 'https://images.unsplash.com/photo-1605050852571-7bb180ca8d98?auto=format&fit=crop&w=1200&q=80');

  const annapurnaId = tour('annapurna-epic', 'Annapurna Epic', 'Annapurna',
    'A ten-day trail and enduro circuit around the Annapurna massif.',
    10, 4, 'Trail / Enduro', 280, 6400, 3800, 169000, 'Mar – May, Sep – Nov', 4, 10, 'https://images.unsplash.com/photo-1621527225138-b4832a1b3992?auto=format&fit=crop&w=1200&q=80');

  const kathmanduId = tour('kathmandu-valley-explorer', 'Kathmandu Valley Explorer', 'Kathmandu',
    'A three-day introduction to Nepal riding on the rim trails above the valley.',
    3, 1, 'XC / Trail', 65, 1200, 2100, 42000, 'Year-round', 2, 12, 'https://images.unsplash.com/photo-1562861894-0918c74b6448?auto=format&fit=crop&w=1200&q=80');

  const langtangId = tour('langtang-forest-flow', 'Langtang Forest Flow', 'Langtang',
    'Five days of flowing forest trail through the Langtang valley.',
    5, 3, 'Trail', 95, 3200, 3430, 78000, 'Oct – Apr', 2, 10, 'https://images.unsplash.com/photo-1760892472018-9e3bfe540e3b?auto=format&fit=crop&w=1200&q=80');

  const manasluId = tour('manaslu-wilderness-traverse', 'Manaslu Wilderness Traverse', 'Manaslu',
    'A twelve-day self-supported bikepacking expedition around the Manaslu circuit.',
    12, 5, 'Bikepacking', 240, 9100, 5106, 245000, 'Sep – Nov', 4, 8, 'https://images.unsplash.com/photo-1713860951944-19640488885f?auto=format&fit=crop&w=1200&q=80');

  const pokharaId = tour('pokhara-lakeside-flow', 'Pokhara Lakeside Flow Weekend', 'Pokhara',
    'A two-day flowing XC taster through the foothills above Pokhara.',
    2, 1, 'XC', 32, 600, 1740, 19000, 'Year-round', 2, 12, 'https://images.unsplash.com/photo-1617397116621-4a3938df7033?auto=format&fit=crop&w=1200&q=80');

  // --- Upper Mustang route days (with demo GPS waypoints) -------------------
  const mustangDays = [
    { d:1, title:'Kathmandu → Jomsom → Kagbeni', dist:18, gain:540, loss:180, high:2810, hrs:'3–4', terrain:'Jeep track, riverbed gravel', place:'Kagbeni', lat:28.8380, lng:83.7195 },
    { d:2, title:'Kagbeni → Chele via the windy canyon', dist:22, gain:970, loss:210, high:3050, hrs:'5–6', terrain:'Singletrack, canyon rim', place:'Chele', lat:28.9500, lng:83.8300 },
    { d:3, title:'Chele → Syangboche, over Taklam La', dist:19, gain:1250, loss:340, high:3630, hrs:'6', terrain:'Technical climb, alpine descent', place:'Syangboche', lat:29.0050, lng:83.8500 },
    { d:4, title:'Syangboche → Ghami, the red cliffs', dist:24, gain:820, loss:790, high:3800, hrs:'5', terrain:'Flow trail, gravel road', place:'Ghami', lat:29.0700, lng:83.8600 },
    { d:5, title:'Ghami → Charang, plateau riding', dist:20, gain:1850, loss:2100, high:3870, hrs:'6–7', terrain:'Rolling plateau, rocky descent', place:'Charang', lat:29.1300, lng:83.9300 },
    { d:6, title:'Charang → Lo Manthang, the walled city', dist:16, gain:670, loss:410, high:3840, hrs:'3–4', terrain:'Wide jeep track', place:'Lo Manthang', lat:29.1840, lng:83.9500 },
    { d:7, title:'Rest & acclimatisation, Lo Manthang', dist:8, gain:270, loss:270, high:4200, hrs:'2', terrain:'Short exploratory loop to a viewpoint', place:'Lo Manthang', lat:29.1840, lng:83.9500 },
    { d:8, title:'Lo Manthang → Yara, remote valley', dist:27, gain:870, loss:1120, high:3760, hrs:'6', terrain:'Remote singletrack, river crossings', place:'Yara', lat:29.1100, lng:83.8200 },
    { d:9, title:'Yara → Tange, the big descent', dist:31, gain:530, loss:1680, high:3600, hrs:'6–7', terrain:'Long technical descent', place:'Tange', lat:29.0200, lng:83.7400 },
    { d:10, title:'Tange → Jomsom → fly to Pokhara', dist:23, gain:230, loss:940, high:2900, hrs:'4', terrain:'Flow descent to the valley floor', place:'Jomsom', lat:28.7810, lng:83.7220 },
  ];
  const insertDay = (tourId, d) => run(
    `INSERT INTO tour_days (tour_id, day_number, title, distance_km, elevation_gain_m, elevation_loss_m, high_point_m, riding_hours, terrain, overnight_place, overnight_lat, overnight_lng)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [tourId, d.d, d.title, d.dist, d.gain, d.loss, d.high, d.hrs, d.terrain, d.place, d.lat, d.lng]);
  mustangDays.forEach(d => insertDay(mustangId, d));

  // --- Departures -------------------------------------------------------------
  const dep = (tourId, guideId, start, end, capacity, booked, status) =>
    run(`INSERT INTO departures (tour_id, guide_id, start_date, end_date, capacity, seats_booked, status) VALUES (?,?,?,?,?,?,?)`,
      [tourId, guideId, start, end, capacity, booked, status]).lastInsertRowid;

  const mustangDep = dep(mustangId, tashi, '2026-10-18', '2026-10-27', 10, 4, 'open');
  dep(annapurnaId, pemba, '2026-09-25', '2026-10-04', 10, 10, 'full');
  dep(kathmanduId, tashi, '2026-09-12', '2026-09-14', 12, 8, 'few_spaces');
  dep(langtangId, pemba, '2026-09-30', '2026-10-04', 10, 2, 'open');
  dep(manasluId, tashi, '2026-11-03', '2026-11-14', 8, 0, 'request_only');
  dep(pokharaId, pemba, '2026-09-19', '2026-09-20', 12, 2, 'open');

  // --- Reviews -----------------------------------------------------------------
  run(`INSERT INTO reviews (tour_id, rider_name, riding_score, guide_score, scenery_score, organization_score, accommodation_score, would_recommend, quote)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    [mustangId, 'Freya H.', 5, 5, 5, 4, 4, 1,
     'The Mustang descent on day nine is the best hour I\u2019ve had on a bike. The guide read the group perfectly at altitude.']);
  run(`INSERT INTO reviews (tour_id, rider_name, riding_score, guide_score, scenery_score, organization_score, accommodation_score, would_recommend, quote)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    [mustangId, 'Marcus L.', 4, 5, 5, 5, 4, 1,
     'First time riding above 3,000m. The rest day in Lo Manthang made a real difference before the big descent days.']);

  // --- Destinations (map pins, admin-manageable) -------------------------------
  const dest = (slug, name, region, desc, img, lat, lng, order) => run(
    `INSERT INTO destinations (slug, name, region, description, hero_image_url, lat, lng, sort_order) VALUES (?,?,?,?,?,?,?,?)`,
    [slug, name, region, desc, img, lat, lng, order]);
  dest('kathmandu', 'Kathmandu', 'Kathmandu Valley', 'The starting point for almost every trip — rim trails, temples, and the valley floor.', 'https://images.unsplash.com/photo-1562861894-0918c74b6448?auto=format&fit=crop&w=1000&q=80', 27.7172, 85.3240, 1);
  dest('pokhara', 'Pokhara', 'Pokhara', 'Lakeside foothills and the gateway to Annapurna.', 'https://images.unsplash.com/photo-1617397116621-4a3938df7033?auto=format&fit=crop&w=1000&q=80', 28.2096, 83.9856, 2);
  dest('annapurna', 'Annapurna', 'Annapurna Circuit', 'The classic circuit, ridden as trail and enduro.', 'https://images.unsplash.com/photo-1621527225138-b4832a1b3992?auto=format&fit=crop&w=1000&q=80', 28.5967, 83.8203, 3);
  dest('mustang', 'Mustang', 'Upper Mustang', "Nepal's former forbidden kingdom — high desert, canyons, the walled city of Lo Manthang.", 'https://images.unsplash.com/photo-1605050852571-7bb180ca8d98?auto=format&fit=crop&w=1000&q=80', 29.1840, 83.9500, 4);
  dest('langtang', 'Langtang', 'Langtang Valley', 'Forest singletrack close to Kathmandu.', 'https://images.unsplash.com/photo-1760892472018-9e3bfe540e3b?auto=format&fit=crop&w=1000&q=80', 28.2108, 85.5183, 5);
  dest('manaslu', 'Manaslu', 'Manaslu Circuit', 'A remote bikepacking expedition around the eighth-highest mountain on earth.', 'https://images.unsplash.com/photo-1713860951944-19640488885f?auto=format&fit=crop&w=1000&q=80', 28.5492, 84.5597, 6);

  // --- Gallery images -----------------------------------------------------------
  const gal = (url, caption, category, tourId, order) => run(
    `INSERT INTO gallery_images (image_url, caption, category, tour_id, sort_order) VALUES (?,?,?,?,?)`,
    [url, caption, category, tourId || null, order]);
  gal('https://images.unsplash.com/photo-1627044185459-09e6dbc39444?auto=format&fit=crop&w=900&q=80', 'Rocky descent, Upper Mustang', 'gallery', mustangId, 1);
  gal('https://images.unsplash.com/photo-1635349789519-1c8d453a2660?auto=format&fit=crop&w=900&q=80', 'Suspension bridge crossing', 'gallery', null, 2);
  gal('https://images.unsplash.com/photo-1718179634911-8551f8b0cccf?auto=format&fit=crop&w=1200&q=80', 'Passing through a mountain village', 'gallery', null, 3);
  gal('https://images.unsplash.com/photo-1652361561822-b2aa3f30416a?auto=format&fit=crop&w=900&q=80', 'Long climb, Annapurna', 'gallery', annapurnaId, 4);
  gal('https://images.unsplash.com/photo-1510312305653-8ed496efae75?auto=format&fit=crop&w=900&q=80', 'Camp at sunset', 'gallery', null, 5);
  gal('https://images.unsplash.com/photo-1734699762001-ea94ad09800c?auto=format&fit=crop&w=900&q=80', 'Canyon trail, Mustang', 'gallery', mustangId, 6);
  gal('https://images.unsplash.com/photo-1645520719499-6856445fe4ad?auto=format&fit=crop&w=1200&q=80', 'Group riding through a valley', 'gallery', null, 7);

  // --- Per-tour photo galleries (category='tour') --------------------------
  // Backs the "Gallery" section on each tour's own detail page (and, via the
  // same base-tour lookup, the equivalent section on a custom-trip page) —
  // see renderTourGallery() in main.js, GET /api/gallery?category=tour&tourId=.
  // Separate from the 'gallery' rows above (the homepage's general strip).
  gal('https://images.unsplash.com/photo-1605050852571-7bb180ca8d98?auto=format&fit=crop&w=1200&q=80', 'High desert above Lo Manthang', 'tour', mustangId, 1);
  gal('https://images.unsplash.com/photo-1761171498924-b209a53c189c?auto=format&fit=crop&w=1200&q=80', 'Dirt track through the high desert canyons', 'tour', mustangId, 2);
  gal('https://images.unsplash.com/photo-1755553267661-76c89e7abbc5?auto=format&fit=crop&w=1200&q=80', 'Canyon walls along the Mustang trail', 'tour', mustangId, 3);
  gal('https://images.unsplash.com/photo-1734699762001-ea94ad09800c?auto=format&fit=crop&w=1200&q=80', 'Canyon trail, Mustang', 'tour', mustangId, 4);
  gal('https://images.unsplash.com/photo-1627044185459-09e6dbc39444?auto=format&fit=crop&w=1200&q=80', 'Rocky descent, Upper Mustang', 'tour', mustangId, 5);

  gal('https://images.unsplash.com/photo-1621527225138-b4832a1b3992?auto=format&fit=crop&w=1200&q=80', 'The Annapurna range at dawn', 'tour', annapurnaId, 1);
  gal('https://images.unsplash.com/photo-1760892799189-542f1c3ecac7?auto=format&fit=crop&w=1200&q=80', 'Riding beneath the Annapurna massif', 'tour', annapurnaId, 2);
  gal('https://images.unsplash.com/photo-1483728642387-6c3bdd6c93e5?auto=format&fit=crop&w=1200&q=80', 'Sunrise over the Annapurna range from Poon Hill', 'tour', annapurnaId, 3);
  gal('https://images.unsplash.com/photo-1756639749216-7b84e1d1050a?auto=format&fit=crop&w=1200&q=80', 'Alpine singletrack, high above the valley', 'tour', annapurnaId, 4);
  gal('https://images.unsplash.com/photo-1652361561822-b2aa3f30416a?auto=format&fit=crop&w=1200&q=80', 'Long climb, Annapurna', 'tour', annapurnaId, 5);

  gal('https://images.unsplash.com/photo-1562861894-0918c74b6448?auto=format&fit=crop&w=1200&q=80', 'Hills above the Kathmandu Valley', 'tour', kathmanduId, 1);
  gal('https://images.unsplash.com/photo-1683171081498-f392d7385f0c?auto=format&fit=crop&w=1200&q=80', 'Terraced hillsides above the valley', 'tour', kathmanduId, 2);
  gal('https://images.unsplash.com/photo-1763809678352-0f9ca8adb331?auto=format&fit=crop&w=1200&q=80', 'Village trail through the terraces', 'tour', kathmanduId, 3);
  gal('https://images.unsplash.com/photo-1773393878467-e12c8f27e7fd?auto=format&fit=crop&w=1200&q=80', 'Morning mist over the valley terraces', 'tour', kathmanduId, 4);
  gal('https://images.unsplash.com/photo-1718179634911-8551f8b0cccf?auto=format&fit=crop&w=1200&q=80', 'Passing through a mountain village', 'tour', kathmanduId, 5);

  gal('https://images.unsplash.com/photo-1760892472018-9e3bfe540e3b?auto=format&fit=crop&w=1200&q=80', 'Forest singletrack, Langtang', 'tour', langtangId, 1);
  gal('https://images.unsplash.com/photo-1762513066458-7e8bfee2d7f1?auto=format&fit=crop&w=1200&q=80', 'Pine forest singletrack', 'tour', langtangId, 2);
  gal('https://images.unsplash.com/photo-1780840883415-6babdeaf9d70?auto=format&fit=crop&w=1200&q=80', 'Deep in the Langtang forest', 'tour', langtangId, 3);
  gal('https://images.unsplash.com/photo-1758648918664-d8f08a159726?auto=format&fit=crop&w=1200&q=80', 'Sunlight through the forest trail', 'tour', langtangId, 4);
  gal('https://images.unsplash.com/photo-1635349789519-1c8d453a2660?auto=format&fit=crop&w=1200&q=80', 'Suspension bridge crossing', 'tour', langtangId, 5);

  gal('https://images.unsplash.com/photo-1713860951944-19640488885f?auto=format&fit=crop&w=1200&q=80', 'Remote wilderness on the Manaslu circuit', 'tour', manasluId, 1);
  gal('https://images.unsplash.com/photo-1513614835783-51537729c8ba?auto=format&fit=crop&w=1200&q=80', 'Prayer flags at a high alpine lake', 'tour', manasluId, 2);
  gal('https://images.unsplash.com/photo-1696789738783-0f972304597e?auto=format&fit=crop&w=1200&q=80', 'Remote peaks along the circuit', 'tour', manasluId, 3);
  gal('https://images.unsplash.com/photo-1786352260444-20539d92fee0?auto=format&fit=crop&w=1200&q=80', 'High trail toward the Manaslu range', 'tour', manasluId, 4);
  gal('https://images.unsplash.com/photo-1510312305653-8ed496efae75?auto=format&fit=crop&w=1200&q=80', 'Camp at sunset', 'tour', manasluId, 5);

  gal('https://images.unsplash.com/photo-1617397116621-4a3938df7033?auto=format&fit=crop&w=1200&q=80', 'Phewa Lake, Pokhara', 'tour', pokharaId, 1);
  gal('https://images.unsplash.com/photo-1759434190960-87511b2a5e5c?auto=format&fit=crop&w=1200&q=80', 'Green hills above the lake', 'tour', pokharaId, 2);
  gal('https://images.unsplash.com/photo-1746912904600-b26dc1840c5c?auto=format&fit=crop&w=1200&q=80', 'Misty morning on the lake', 'tour', pokharaId, 3);
  gal('https://images.unsplash.com/photo-1645520719499-6856445fe4ad?auto=format&fit=crop&w=1200&q=80', 'Group riding through the valley', 'tour', pokharaId, 4);

  console.log('Seed complete:', {
    tours: get('SELECT COUNT(*) n FROM tours').n,
    tour_days: get('SELECT COUNT(*) n FROM tour_days').n,
    departures: get('SELECT COUNT(*) n FROM departures').n,
    guides: get('SELECT COUNT(*) n FROM guides').n,
    reviews: get('SELECT COUNT(*) n FROM reviews').n,
    destinations: get('SELECT COUNT(*) n FROM destinations').n,
    gallery_images: get('SELECT COUNT(*) n FROM gallery_images').n,
    mustangDepartureId: mustangDep,
    demoGuideLogin: { email: 'tashi@highroutemtb.demo', password: DEMO_GUIDE_PASSWORD },
  });
}

if (require.main === module) seed();
module.exports = { seed };
