'use strict';

// All 77 districts of Nepal, each with an approximate lat/lng for its
// headquarters town — used to auto-pin a tour's district on the homepage
// map. Hand-compiled for this demo, NOT survey-accurate (same disclaimer as
// every other hand-placed coordinate in this app; see README "GPS & safety
// disclaimer").
//
// `places` lists the specific towns/areas an admin might type instead of
// the formal district name (old spellings, sub-regions, famous landmarks).
// A place with no lat/lng of its own inherits the district's coordinates;
// a handful of well-known places that sit meaningfully far from their
// district HQ (e.g. Dharan vs. Sunsari's HQ Inaruwa, or Everest/Khumbu vs.
// Solukhumbu's HQ Salleri) get their own so the pin lands somewhere
// recognisable — whatever specific place the admin named is what shows up
// on the map, not just the parent district's name.
const NEPAL_DISTRICTS = [
  // Koshi Province
  { key: 'Bhojpur', lat: 27.1725, lng: 87.0498, places: [] },
  { key: 'Dhankuta', lat: 26.9847, lng: 87.3395, places: [] },
  { key: 'Ilam', lat: 26.9089, lng: 87.9280, places: [] },
  { key: 'Jhapa', lat: 26.5439, lng: 88.0839, places: [{ name: 'Bhadrapur' }, { name: 'Birtamod', lat: 26.6431, lng: 87.9203 }] },
  { key: 'Khotang', lat: 27.0430, lng: 86.8110, places: [{ name: 'Diktel' }] },
  { key: 'Morang', lat: 26.4525, lng: 87.2718, places: [{ name: 'Biratnagar' }] },
  { key: 'Okhaldhunga', lat: 27.3167, lng: 86.5000, places: [] },
  { key: 'Panchthar', lat: 27.1500, lng: 87.7500, places: [{ name: 'Phidim' }] },
  { key: 'Sankhuwasabha', lat: 27.3167, lng: 87.2167, places: [{ name: 'Khandbari' }, { name: 'Makalu', lat: 27.8900, lng: 87.0900 }] },
  { key: 'Solukhumbu', lat: 27.5667, lng: 86.5833, places: [
      { name: 'Salleri' },
      { name: 'Everest', lat: 27.9881, lng: 86.9250 },
      { name: 'Khumbu', lat: 27.9881, lng: 86.9250 },
      { name: 'Namche', lat: 27.8069, lng: 86.7140 },
    ] },
  { key: 'Sunsari', lat: 26.5964, lng: 87.1470, places: [
      { name: 'Inaruwa' },
      { name: 'Dharan', lat: 26.8065, lng: 87.2846 },
    ] },
  { key: 'Taplejung', lat: 27.3500, lng: 87.6667, places: [{ name: 'Kanchenjunga', lat: 27.7167, lng: 88.1500 }] },
  { key: 'Terhathum', lat: 27.1167, lng: 87.5500, places: [{ name: 'Myanglung' }] },
  { key: 'Udayapur', lat: 26.8500, lng: 86.7333, places: [{ name: 'Gaighat' }] },
  // Madhesh Province
  { key: 'Bara', lat: 27.0333, lng: 85.0000, places: [{ name: 'Kalaiya' }] },
  { key: 'Dhanusha', lat: 26.7288, lng: 85.9266, places: [{ name: 'Janakpur' }] },
  { key: 'Mahottari', lat: 26.6500, lng: 85.8000, places: [{ name: 'Jaleshwar' }] },
  { key: 'Parsa', lat: 27.0000, lng: 84.8800, places: [{ name: 'Birgunj' }] },
  { key: 'Rautahat', lat: 26.8333, lng: 85.2667, places: [{ name: 'Gaur' }] },
  { key: 'Saptari', lat: 26.5333, lng: 86.7500, places: [{ name: 'Rajbiraj' }] },
  { key: 'Sarlahi', lat: 26.8667, lng: 85.5667, places: [{ name: 'Malangwa' }] },
  { key: 'Siraha', lat: 26.6500, lng: 86.2000, places: [] },
  // Bagmati Province
  { key: 'Bhaktapur', lat: 27.6710, lng: 85.4298, places: [] },
  { key: 'Chitwan', lat: 27.6766, lng: 84.4330, places: [{ name: 'Bharatpur' }] },
  { key: 'Dhading', lat: 27.8667, lng: 84.9000, places: [{ name: 'Dhading Besi' }] },
  { key: 'Dolakha', lat: 27.6667, lng: 86.0500, places: [{ name: 'Charikot' }] },
  { key: 'Kathmandu', lat: 27.7172, lng: 85.3240, places: [{ name: 'Kathmandu Valley' }] },
  { key: 'Kavrepalanchok', lat: 27.6200, lng: 85.5500, places: [{ name: 'Kavre' }, { name: 'Dhulikhel' }] },
  { key: 'Lalitpur', lat: 27.6588, lng: 85.3247, places: [{ name: 'Patan' }] },
  { key: 'Makwanpur', lat: 27.4287, lng: 85.0322, places: [{ name: 'Hetauda' }] },
  { key: 'Nuwakot', lat: 27.9167, lng: 85.1667, places: [{ name: 'Bidur' }] },
  { key: 'Ramechhap', lat: 27.3333, lng: 86.0833, places: [{ name: 'Manthali' }] },
  { key: 'Rasuwa', lat: 28.1000, lng: 85.2833, places: [
      { name: 'Dhunche' },
      { name: 'Gosaikunda' },
      { name: 'Langtang', lat: 28.2108, lng: 85.5183 },
    ] },
  { key: 'Sindhuli', lat: 27.2500, lng: 85.9667, places: [{ name: 'Kamalamai' }] },
  { key: 'Sindhupalchok', lat: 27.8333, lng: 85.6833, places: [{ name: 'Chautara' }] },
  // Gandaki Province
  { key: 'Baglung', lat: 28.2667, lng: 83.5833, places: [] },
  { key: 'Gorkha', lat: 28.0000, lng: 84.6280, places: [{ name: 'Manaslu', lat: 28.5492, lng: 84.5597 }] },
  { key: 'Kaski', lat: 28.2096, lng: 83.9856, places: [{ name: 'Pokhara' }] },
  { key: 'Lamjung', lat: 28.2333, lng: 84.3667, places: [{ name: 'Besisahar' }] },
  { key: 'Manang', lat: 28.5500, lng: 84.2333, places: [{ name: 'Chame' }, { name: 'Annapurna', lat: 28.5967, lng: 83.8203 }] },
  { key: 'Mustang', lat: 29.1840, lng: 83.9500, places: [
      { name: 'Upper Mustang' },
      { name: 'Lo Manthang' },
      { name: 'Jomsom', lat: 28.7810, lng: 83.7220 },
      { name: 'Lower Mustang', lat: 28.7810, lng: 83.7220 },
    ] },
  { key: 'Myagdi', lat: 28.3333, lng: 83.5833, places: [{ name: 'Beni' }, { name: 'Dhaulagiri', lat: 28.6980, lng: 83.4870 }] },
  { key: 'Nawalpur', lat: 27.6333, lng: 84.0833, places: [{ name: 'Nawalparasi East' }, { name: 'Kawasoti' }] },
  { key: 'Parbat', lat: 28.2167, lng: 83.6833, places: [{ name: 'Kusma' }] },
  { key: 'Syangja', lat: 28.1000, lng: 83.8833, places: [] },
  { key: 'Tanahun', lat: 27.9500, lng: 84.2667, places: [{ name: 'Tanahu' }, { name: 'Damauli' }] },
  // Lumbini Province
  { key: 'Arghakhanchi', lat: 27.9500, lng: 83.1333, places: [{ name: 'Sandhikharka' }] },
  { key: 'Banke', lat: 28.0500, lng: 81.6167, places: [{ name: 'Nepalgunj' }] },
  { key: 'Bardiya', lat: 28.2000, lng: 81.3333, places: [{ name: 'Gulariya' }] },
  { key: 'Dang', lat: 28.0333, lng: 82.4833, places: [{ name: 'Ghorahi' }] },
  { key: 'Eastern Rukum', lat: 28.6167, lng: 82.3667, places: [{ name: 'Rukum East' }, { name: 'Rukumkot' }] },
  { key: 'Gulmi', lat: 28.0667, lng: 83.2333, places: [{ name: 'Tamghas' }] },
  { key: 'Kapilvastu', lat: 27.5667, lng: 83.0500, places: [{ name: 'Taulihawa' }] },
  { key: 'Parasi', lat: 27.5667, lng: 83.6500, places: [{ name: 'Nawalparasi' }, { name: 'Nawalparasi West' }, { name: 'Ramgram' }] },
  { key: 'Palpa', lat: 27.8667, lng: 83.5500, places: [{ name: 'Tansen' }] },
  { key: 'Pyuthan', lat: 28.1000, lng: 82.8667, places: [] },
  { key: 'Rolpa', lat: 28.3167, lng: 82.6333, places: [{ name: 'Liwang' }] },
  { key: 'Rupandehi', lat: 27.5040, lng: 83.4485, places: [{ name: 'Bhairahawa' }, { name: 'Siddharthanagar' }, { name: 'Lumbini', lat: 27.4833, lng: 83.2757 }] },
  // Karnali Province
  { key: 'Dailekh', lat: 28.8500, lng: 81.7167, places: [] },
  { key: 'Dolpa', lat: 28.9333, lng: 82.9000, places: [{ name: 'Dolpo' }, { name: 'Dunai' }, { name: 'Upper Dolpo' }, { name: 'Shey Phoksundo', lat: 29.1900, lng: 82.9200 }] },
  { key: 'Humla', lat: 30.0300, lng: 81.8200, places: [{ name: 'Simikot' }] },
  { key: 'Jajarkot', lat: 28.7000, lng: 82.2000, places: [{ name: 'Khalanga' }] },
  { key: 'Jumla', lat: 29.2747, lng: 82.1838, places: [] },
  { key: 'Kalikot', lat: 29.1333, lng: 81.6333, places: [{ name: 'Manma' }] },
  { key: 'Mugu', lat: 29.5330, lng: 82.0850, places: [{ name: 'Gamgadhi' }, { name: 'Rara' }] },
  { key: 'Salyan', lat: 28.3833, lng: 82.1667, places: [] },
  { key: 'Surkhet', lat: 28.6000, lng: 81.6167, places: [{ name: 'Birendranagar' }] },
  { key: 'Western Rukum', lat: 28.6333, lng: 82.1500, places: [{ name: 'Rukum West' }, { name: 'Rukum' }, { name: 'Musikot' }] },
  // Sudurpashchim Province
  { key: 'Achham', lat: 29.2167, lng: 81.3000, places: [{ name: 'Mangalsen' }] },
  { key: 'Baitadi', lat: 29.4667, lng: 80.4667, places: [] },
  { key: 'Bajhang', lat: 29.5500, lng: 81.2000, places: [{ name: 'Chainpur' }] },
  { key: 'Bajura', lat: 29.5333, lng: 81.4500, places: [{ name: 'Martadi' }] },
  { key: 'Dadeldhura', lat: 29.3000, lng: 80.5833, places: [] },
  { key: 'Darchula', lat: 29.8500, lng: 80.5500, places: [] },
  { key: 'Doti', lat: 29.2667, lng: 80.9333, places: [{ name: 'Dipayal' }] },
  { key: 'Kailali', lat: 28.6833, lng: 80.6000, places: [{ name: 'Dhangadhi' }] },
  { key: 'Kanchanpur', lat: 28.9333, lng: 80.1667, places: [{ name: 'Bhimdatta' }, { name: 'Mahendranagar' }] },
];

function slugify(text) {
  return String(text).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalize(text) {
  return String(text).toLowerCase().trim().replace(/\s+district$/, '').replace(/\s+/g, ' ');
}

/** Standard edit-distance DP — how many single-character insert/delete/swap
 *  operations turn `a` into `b`. Used to tolerate a misspelled district or
 *  place name (e.g. "Mustan", "Katmandu", "Dhoran") without needing exact
 *  spelling. */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const row = new Array(n + 1);
  for (let j = 0; j <= n; j++) row[j] = j;
  for (let i = 1; i <= m; i++) {
    let prevDiag = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = a[i - 1] === b[j - 1]
        ? prevDiag
        : 1 + Math.min(prevDiag, row[j], row[j - 1]);
      prevDiag = tmp;
    }
  }
  return row[n];
}

// Every district name and every named place under it, flattened into one
// lookup list — each candidate carries its own display name and
// coordinates (falling back to its district's when the place doesn't have
// its own), so whichever one an admin actually typed is what gets shown
// and pinned, not just the parent district's name.
const CANDIDATES = NEPAL_DISTRICTS.flatMap(d => [
  { match: d.key.toLowerCase(), district: d.key, name: d.key, lat: d.lat, lng: d.lng },
  ...d.places.map(p => ({
    match: p.name.toLowerCase(), district: d.key, name: p.name,
    lat: p.lat ?? d.lat, lng: p.lng ?? d.lng,
  })),
]);

/** Best-effort match of a free-text district/place name (whatever an admin
 *  typed into the tour form, typos included) against the gazetteer above.
 *  Tries an exact match first (district name or any of its known places);
 *  if nothing matches exactly, falls back to whichever known name is
 *  "closest" by edit distance, accepting it only if the typo is small
 *  relative to the name's length (roughly up to ~30%, minimum 1 character)
 *  — enough to catch a dropped/swapped letter without matching wildly
 *  different names. Returns { district, name, lat, lng } — `name` is
 *  whatever specific place matched (which is what the map pin should be
 *  labelled), `district` is its parent district (for reference/dedup).
 *  Returns null if nothing close enough is found. */
function resolveDistrict(input) {
  if (!input) return null;
  const norm = normalize(input);

  const exact = CANDIDATES.find(c => c.match === norm);
  if (exact) return exact;

  let best = null;
  let bestDistance = Infinity;
  for (const c of CANDIDATES) {
    const dist = levenshtein(norm, c.match);
    if (dist < bestDistance) { bestDistance = dist; best = c; }
  }
  if (!best) return null;
  const threshold = Math.max(1, Math.floor(norm.length * 0.3));
  return bestDistance <= threshold ? best : null;
}

module.exports = { NEPAL_DISTRICTS, resolveDistrict, slugify, levenshtein };
