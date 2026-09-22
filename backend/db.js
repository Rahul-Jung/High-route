'use strict';
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, 'data', 'highroute.db');
const DB_DIR = path.dirname(DB_PATH);
fs.mkdirSync(DB_DIR, { recursive: true });

// Hardening: the data directory (and the db files once they exist) should
// only be readable/writable by the account running the server, not "everyone
// on the box". chmod is a no-op on Windows filesystems that don't support
// POSIX permission bits, so this is best-effort and wrapped defensively.
try { fs.chmodSync(DB_DIR, 0o700); } catch { /* not supported on this filesystem */ }

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

for (const suffix of ['', '-wal', '-shm']) {
  try { fs.chmodSync(DB_PATH + suffix, 0o600); } catch { /* file may not exist yet, or chmod unsupported */ }
}

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Lightweight migration: CREATE TABLE IF NOT EXISTS (above) never adds a
// column to a table that already exists, so a highroute.db created before
// reviews.rider_id existed needs it added explicitly. Safe/idempotent to
// run on every boot — skips once the column is present.
const reviewCols = db.prepare("PRAGMA table_info(reviews)").all().map(c => c.name);
if (!reviewCols.includes('rider_id')) {
  db.exec('ALTER TABLE reviews ADD COLUMN rider_id INTEGER REFERENCES riders(id)');
}
const tourCols = db.prepare("PRAGMA table_info(tours)").all().map(c => c.name);
if (!tourCols.includes('district')) {
  db.exec('ALTER TABLE tours ADD COLUMN district TEXT');
}
const destCols = db.prepare("PRAGMA table_info(destinations)").all().map(c => c.name);
if (!destCols.includes('auto_created')) {
  db.exec('ALTER TABLE destinations ADD COLUMN auto_created INTEGER NOT NULL DEFAULT 0');
  // Backfill: a destination created by the district auto-pin feature before
  // this column existed always used one of these two description templates
  // (see ensureDestinationForDistrict in routes/admin.js) — retroactively
  // flag those as auto-created so they become eligible for cleanup, without
  // touching hand-authored destinations (seeded or admin-added), whose
  // descriptions never match this shape.
  db.exec(`UPDATE destinations SET auto_created = 1
           WHERE description LIKE '% district.'
              OR description LIKE 'New %— add its coordinates here to place it on the map.'`);
}
// Tour-detail-page content added for inclusions/exclusions/equipment/
// safety/cancellation — see schema.sql's comment on the tours table.
for (const [col, def] of [
  ['inclusions_json', "TEXT NOT NULL DEFAULT '[]'"], ['exclusions_json', "TEXT NOT NULL DEFAULT '[]'"],
  ['equipment_essential_json', "TEXT NOT NULL DEFAULT '[]'"], ['equipment_recommended_json', "TEXT NOT NULL DEFAULT '[]'"],
  ['safety_hazards', 'TEXT'], ['safety_preparation', 'TEXT'], ['safety_emergency', 'TEXT'], ['cancellation_policy', 'TEXT'],
]) {
  if (!tourCols.includes(col)) db.exec(`ALTER TABLE tours ADD COLUMN ${col} ${def}`);
}
const guideCols = db.prepare("PRAGMA table_info(guides)").all().map(c => c.name);
if (!guideCols.includes('qualifications_json')) {
  db.exec("ALTER TABLE guides ADD COLUMN qualifications_json TEXT NOT NULL DEFAULT '[]'");
}
// Checkout rework: promo codes / tax / refund bookkeeping on existing
// bookings rows, and country/special-requirements on existing riders rows.
// All additive with safe defaults so pre-existing bookings keep working.
const bookingCols = db.prepare("PRAGMA table_info(bookings)").all().map(c => c.name);
for (const [col, def] of [
  ['subtotal_cents', 'INTEGER NOT NULL DEFAULT 0'], ['promo_code_id', 'INTEGER REFERENCES promo_codes(id)'],
  ['discount_cents', 'INTEGER NOT NULL DEFAULT 0'], ['tax_cents', 'INTEGER NOT NULL DEFAULT 0'],
  ['refunded_cents', 'INTEGER NOT NULL DEFAULT 0'], ['refund_status', "TEXT NOT NULL DEFAULT 'none'"],
]) {
  if (!bookingCols.includes(col)) db.exec(`ALTER TABLE bookings ADD COLUMN ${col} ${def}`);
}
// Backfill: a pre-existing booking has no subtotal recorded — total_cents
// (its pre-discount, pre-tax price under the old single-price model) is the
// correct value to backfill subtotal_cents with, so its price breakdown
// still adds up correctly on an invoice generated after this upgrade.
db.exec('UPDATE bookings SET subtotal_cents = total_cents WHERE subtotal_cents = 0');
const bookingRiderCols = db.prepare("PRAGMA table_info(booking_riders)").all().map(c => c.name);
for (const col of ['country', 'special_requirements']) {
  if (!bookingRiderCols.includes(col)) db.exec(`ALTER TABLE booking_riders ADD COLUMN ${col} TEXT`);
}

// Custom tour proposal workflow: custom_proposals/custom_request_events/
// custom_request_payments/notifications are brand-new tables, created above
// by schema.sql's own CREATE TABLE IF NOT EXISTS. custom_requests itself
// pre-exists on any DB from before this feature, though, and needs two new
// columns plus an 'approved' status added to its CHECK constraint — SQLite
// can't ALTER a CHECK constraint in place, so this rebuilds the table (safe
// data-preserving pattern: rename, recreate with the new shape, copy rows,
// drop the old one) the first time it finds the old constraint.
const crTableDef = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='custom_requests'").get();
if (crTableDef && !crTableDef.sql.includes("'approved'")) {
  // Build the replacement under a new name and swap it in, rather than
  // renaming the live table out of the way — custom_proposals'/notifications'
  // FK clauses are just "REFERENCES custom_requests(...)" text that never
  // mentions custom_requests_new, so this sidesteps SQLite's rename-time FK
  // rewriting (which would otherwise repoint them at a table this migration
  // is about to drop). foreign_keys is off for the duration since it can't
  // be toggled inside a transaction and DROP/RENAME here briefly leaves no
  // table by either name in existence.
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE custom_requests_new (
        id                  INTEGER PRIMARY KEY,
        rider_id            INTEGER REFERENCES riders(id) ON DELETE SET NULL,
        tour_id             INTEGER REFERENCES tours(id) ON DELETE SET NULL,
        preferred_date      TEXT,
        name                TEXT,
        email               TEXT,
        destination         TEXT,
        duration_bucket     TEXT,
        riding_style        TEXT,
        experience          TEXT,
        group_size          TEXT,
        budget              TEXT,
        preferences_json    TEXT NOT NULL DEFAULT '[]',
        status              TEXT NOT NULL DEFAULT 'new'
                              CHECK (status IN ('new','contacted','proposal_sent','approved','deposit','confirmed','completed','declined','cancelled')),
        internal_notes      TEXT,
        active_proposal_id  INTEGER REFERENCES custom_proposals(id) ON DELETE SET NULL,
        amount_paid_cents   INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    db.exec(`
      INSERT INTO custom_requests_new (id, rider_id, name, email, destination, duration_bucket, riding_style,
                                        experience, group_size, budget, preferences_json, status, internal_notes,
                                        created_at, updated_at)
      SELECT id, rider_id, name, email, destination, duration_bucket, riding_style,
             experience, group_size, budget, preferences_json, status, internal_notes,
             created_at, updated_at
      FROM custom_requests`);
    db.exec('DROP TABLE custom_requests');
    db.exec('ALTER TABLE custom_requests_new RENAME TO custom_requests');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
// Separate, later migration: a DB that already has the 'approved' status
// (i.e. already went through the rebuild above in an earlier version of
// this feature) still needs deposit_paid_cents renamed to amount_paid_cents
// — it now tracks cumulative payment toward the full proposal price, not
// just the deposit, once balance payments were added — plus tour_id/
// preferred_date for the tour-dropdown + customer-date-picker request form.
// Plain ALTER TABLE (no CHECK constraint involved), so no rebuild needed.
{
  const crCols = db.prepare('PRAGMA table_info(custom_requests)').all().map(c => c.name);
  if (crCols.includes('deposit_paid_cents') && !crCols.includes('amount_paid_cents')) {
    db.exec('ALTER TABLE custom_requests RENAME COLUMN deposit_paid_cents TO amount_paid_cents');
  }
  if (!crCols.includes('tour_id')) db.exec('ALTER TABLE custom_requests ADD COLUMN tour_id INTEGER REFERENCES tours(id) ON DELETE SET NULL');
  if (!crCols.includes('preferred_date')) db.exec('ALTER TABLE custom_requests ADD COLUMN preferred_date TEXT');
}
// A proposal's own destination is now always picked from a tour dropdown
// too (see custom-request.html) — same additive ALTER TABLE ADD COLUMN
// pattern, since custom_proposals may already exist without it.
{
  const cpCols = db.prepare('PRAGMA table_info(custom_proposals)').all().map(c => c.name);
  if (!cpCols.includes('tour_id')) db.exec('ALTER TABLE custom_proposals ADD COLUMN tour_id INTEGER REFERENCES tours(id) ON DELETE SET NULL');
}
// Confirmed custom trips get a real departures + bookings row (see the
// booking_id comment on custom_requests in schema.sql) — additive columns
// on two more pre-existing tables.
{
  const depCols = db.prepare('PRAGMA table_info(departures)').all().map(c => c.name);
  if (!depCols.includes('is_custom')) db.exec('ALTER TABLE departures ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0');
  if (!depCols.includes('custom_request_id')) db.exec('ALTER TABLE departures ADD COLUMN custom_request_id INTEGER REFERENCES custom_requests(id) ON DELETE SET NULL');
}
{
  const crCols2 = db.prepare('PRAGMA table_info(custom_requests)').all().map(c => c.name);
  if (!crCols2.includes('booking_id')) db.exec('ALTER TABLE custom_requests ADD COLUMN booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL');
}

// One-time content fix: the original seed used random picsum.photos
// placeholders (no thematic control — a tour card could end up showing a
// water droplet macro shot or star trails instead of a trail/mountain-biking
// photo). This swaps each row's image for a real, correctly-themed one, but
// only where the column still holds the EXACT old placeholder URL this seed
// used to write — so an admin who has already uploaded their own photo via
// the admin panel is never touched. Safe to run on every boot; a no-op once
// every row has moved on from the placeholder.
{
  const swap = (table, col, keyCol, rows) => {
    for (const [key, oldUrl, newUrl] of rows) {
      run(`UPDATE ${table} SET ${col} = ? WHERE ${keyCol} = ? AND ${col} = ?`, [newUrl, key, oldUrl]);
    }
  };
  swap('guides', 'photo_url', 'email', [
    ['tashi@highroutemtb.demo', 'https://picsum.photos/seed/guide-tashi/400/500', 'https://images.unsplash.com/photo-1758244241019-4092edcdba35?auto=format&fit=crop&w=800&q=80'],
    ['pemba@highroutemtb.demo', 'https://picsum.photos/seed/guide-pemba/400/500', 'https://images.unsplash.com/photo-1673969694327-7f54454a0d86?auto=format&fit=crop&w=800&q=80'],
  ]);
  swap('tours', 'image_url', 'slug', [
    ['upper-mustang', 'https://picsum.photos/seed/mustang-ridge/640/500', 'https://images.unsplash.com/photo-1605050852571-7bb180ca8d98?auto=format&fit=crop&w=1200&q=80'],
    ['annapurna-epic', 'https://picsum.photos/seed/annapurna-trail/640/500', 'https://images.unsplash.com/photo-1621527225138-b4832a1b3992?auto=format&fit=crop&w=1200&q=80'],
    ['kathmandu-valley-explorer', 'https://picsum.photos/seed/kathmandu-hills/640/500', 'https://images.unsplash.com/photo-1562861894-0918c74b6448?auto=format&fit=crop&w=1200&q=80'],
    ['langtang-forest-flow', 'https://picsum.photos/seed/langtang-forest/640/500', 'https://images.unsplash.com/photo-1760892472018-9e3bfe540e3b?auto=format&fit=crop&w=1200&q=80'],
    ['manaslu-wilderness-traverse', 'https://picsum.photos/seed/manaslu-wild/640/500', 'https://images.unsplash.com/photo-1713860951944-19640488885f?auto=format&fit=crop&w=1200&q=80'],
    ['pokhara-lakeside-flow', 'https://picsum.photos/seed/pokhara-lake/640/500', 'https://images.unsplash.com/photo-1617397116621-4a3938df7033?auto=format&fit=crop&w=1200&q=80'],
  ]);
  swap('destinations', 'hero_image_url', 'slug', [
    ['kathmandu', 'https://picsum.photos/seed/dest-kathmandu/500/400', 'https://images.unsplash.com/photo-1562861894-0918c74b6448?auto=format&fit=crop&w=1000&q=80'],
    ['pokhara', 'https://picsum.photos/seed/dest-pokhara/500/400', 'https://images.unsplash.com/photo-1617397116621-4a3938df7033?auto=format&fit=crop&w=1000&q=80'],
    ['annapurna', 'https://picsum.photos/seed/dest-annapurna/500/400', 'https://images.unsplash.com/photo-1621527225138-b4832a1b3992?auto=format&fit=crop&w=1000&q=80'],
    ['mustang', 'https://picsum.photos/seed/dest-mustang/500/400', 'https://images.unsplash.com/photo-1605050852571-7bb180ca8d98?auto=format&fit=crop&w=1000&q=80'],
    ['langtang', 'https://picsum.photos/seed/dest-langtang/500/400', 'https://images.unsplash.com/photo-1760892472018-9e3bfe540e3b?auto=format&fit=crop&w=1000&q=80'],
    ['manaslu', 'https://picsum.photos/seed/dest-manaslu/500/400', 'https://images.unsplash.com/photo-1713860951944-19640488885f?auto=format&fit=crop&w=1000&q=80'],
  ]);
  // Gallery rows have no other unique business key admins would edit around,
  // so the old placeholder URL alone (globally unique per seeded row) is
  // guard enough.
  const galleryRows = [
    ['https://picsum.photos/seed/g1-descent/500/700', 'https://images.unsplash.com/photo-1627044185459-09e6dbc39444?auto=format&fit=crop&w=900&q=80'],
    ['https://picsum.photos/seed/g2-bridge/500/400', 'https://images.unsplash.com/photo-1635349789519-1c8d453a2660?auto=format&fit=crop&w=900&q=80'],
    ['https://picsum.photos/seed/g3-village/700/400', 'https://images.unsplash.com/photo-1718179634911-8551f8b0cccf?auto=format&fit=crop&w=1200&q=80'],
    ['https://picsum.photos/seed/g4-climb/500/400', 'https://images.unsplash.com/photo-1652361561822-b2aa3f30416a?auto=format&fit=crop&w=900&q=80'],
    ['https://picsum.photos/seed/g5-camp/500/400', 'https://images.unsplash.com/photo-1510312305653-8ed496efae75?auto=format&fit=crop&w=900&q=80'],
    ['https://picsum.photos/seed/g6-canyon/500/700', 'https://images.unsplash.com/photo-1734699762001-ea94ad09800c?auto=format&fit=crop&w=900&q=80'],
    ['https://picsum.photos/seed/g7-group/700/400', 'https://images.unsplash.com/photo-1645520719499-6856445fe4ad?auto=format&fit=crop&w=1200&q=80'],
  ];
  for (const [oldUrl, newUrl] of galleryRows) {
    run('UPDATE gallery_images SET image_url = ? WHERE image_url = ?', [newUrl, oldUrl]);
  }
}

// One-time content fix: the tour-detail page's own "Gallery" section (and
// the matching section on a custom-trip page, which reuses the same base
// tour) has always queried gallery_images WHERE category='tour' AND
// tour_id=<this tour> — but the original seed never actually wrote any rows
// in that shape, only 'gallery'-category ones for the homepage strip. So the
// section rendered as permanently empty for every tour. This seeds five
// real, tour-specific photos per tour, but only into a tour that doesn't
// already have any — an admin who has since added their own photos for a
// tour (via the admin Gallery tab's "Photos" link) already has a non-zero
// count and is left completely alone.
{
  const tourGalleryRows = {
    'upper-mustang': [
      ['https://images.unsplash.com/photo-1605050852571-7bb180ca8d98?auto=format&fit=crop&w=1200&q=80', 'High desert above Lo Manthang'],
      ['https://images.unsplash.com/photo-1761171498924-b209a53c189c?auto=format&fit=crop&w=1200&q=80', 'Dirt track through the high desert canyons'],
      ['https://images.unsplash.com/photo-1755553267661-76c89e7abbc5?auto=format&fit=crop&w=1200&q=80', 'Canyon walls along the Mustang trail'],
      ['https://images.unsplash.com/photo-1734699762001-ea94ad09800c?auto=format&fit=crop&w=1200&q=80', 'Canyon trail, Mustang'],
      ['https://images.unsplash.com/photo-1627044185459-09e6dbc39444?auto=format&fit=crop&w=1200&q=80', 'Rocky descent, Upper Mustang'],
    ],
    'annapurna-epic': [
      ['https://images.unsplash.com/photo-1621527225138-b4832a1b3992?auto=format&fit=crop&w=1200&q=80', 'The Annapurna range at dawn'],
      ['https://images.unsplash.com/photo-1760892799189-542f1c3ecac7?auto=format&fit=crop&w=1200&q=80', 'Riding beneath the Annapurna massif'],
      ['https://images.unsplash.com/photo-1483728642387-6c3bdd6c93e5?auto=format&fit=crop&w=1200&q=80', 'Sunrise over the Annapurna range from Poon Hill'],
      ['https://images.unsplash.com/photo-1756639749216-7b84e1d1050a?auto=format&fit=crop&w=1200&q=80', 'Alpine singletrack, high above the valley'],
      ['https://images.unsplash.com/photo-1652361561822-b2aa3f30416a?auto=format&fit=crop&w=1200&q=80', 'Long climb, Annapurna'],
    ],
    'kathmandu-valley-explorer': [
      ['https://images.unsplash.com/photo-1562861894-0918c74b6448?auto=format&fit=crop&w=1200&q=80', 'Hills above the Kathmandu Valley'],
      ['https://images.unsplash.com/photo-1683171081498-f392d7385f0c?auto=format&fit=crop&w=1200&q=80', 'Terraced hillsides above the valley'],
      ['https://images.unsplash.com/photo-1763809678352-0f9ca8adb331?auto=format&fit=crop&w=1200&q=80', 'Village trail through the terraces'],
      ['https://images.unsplash.com/photo-1773393878467-e12c8f27e7fd?auto=format&fit=crop&w=1200&q=80', 'Morning mist over the valley terraces'],
      ['https://images.unsplash.com/photo-1718179634911-8551f8b0cccf?auto=format&fit=crop&w=1200&q=80', 'Passing through a mountain village'],
    ],
    'langtang-forest-flow': [
      ['https://images.unsplash.com/photo-1760892472018-9e3bfe540e3b?auto=format&fit=crop&w=1200&q=80', 'Forest singletrack, Langtang'],
      ['https://images.unsplash.com/photo-1762513066458-7e8bfee2d7f1?auto=format&fit=crop&w=1200&q=80', 'Pine forest singletrack'],
      ['https://images.unsplash.com/photo-1780840883415-6babdeaf9d70?auto=format&fit=crop&w=1200&q=80', 'Deep in the Langtang forest'],
      ['https://images.unsplash.com/photo-1758648918664-d8f08a159726?auto=format&fit=crop&w=1200&q=80', 'Sunlight through the forest trail'],
      ['https://images.unsplash.com/photo-1635349789519-1c8d453a2660?auto=format&fit=crop&w=1200&q=80', 'Suspension bridge crossing'],
    ],
    'manaslu-wilderness-traverse': [
      ['https://images.unsplash.com/photo-1713860951944-19640488885f?auto=format&fit=crop&w=1200&q=80', 'Remote wilderness on the Manaslu circuit'],
      ['https://images.unsplash.com/photo-1513614835783-51537729c8ba?auto=format&fit=crop&w=1200&q=80', 'Prayer flags at a high alpine lake'],
      ['https://images.unsplash.com/photo-1696789738783-0f972304597e?auto=format&fit=crop&w=1200&q=80', 'Remote peaks along the circuit'],
      ['https://images.unsplash.com/photo-1786352260444-20539d92fee0?auto=format&fit=crop&w=1200&q=80', 'High trail toward the Manaslu range'],
      ['https://images.unsplash.com/photo-1510312305653-8ed496efae75?auto=format&fit=crop&w=1200&q=80', 'Camp at sunset'],
    ],
    'pokhara-lakeside-flow': [
      ['https://images.unsplash.com/photo-1617397116621-4a3938df7033?auto=format&fit=crop&w=1200&q=80', 'Phewa Lake, Pokhara'],
      ['https://images.unsplash.com/photo-1759434190960-87511b2a5e5c?auto=format&fit=crop&w=1200&q=80', 'Green hills above the lake'],
      ['https://images.unsplash.com/photo-1746912904600-b26dc1840c5c?auto=format&fit=crop&w=1200&q=80', 'Misty morning on the lake'],
      ['https://images.unsplash.com/photo-1645520719499-6856445fe4ad?auto=format&fit=crop&w=1200&q=80', 'Group riding through the valley'],
    ],
  };
  for (const [slug, photos] of Object.entries(tourGalleryRows)) {
    const tour = get('SELECT id FROM tours WHERE slug = ?', [slug]);
    if (!tour) continue; // tour renamed/removed by an admin — nothing to attach photos to
    const existing = get(`SELECT COUNT(*) n FROM gallery_images WHERE tour_id = ? AND category = 'tour'`, [tour.id]).n;
    if (existing > 0) continue;
    photos.forEach(([url, caption], i) => {
      run(`INSERT INTO gallery_images (image_url, caption, category, tour_id, sort_order) VALUES (?,?,?,?,?)`,
        [url, caption, 'tour', tour.id, i + 1]);
    });
  }
}

// --- tiny query helpers on top of node:sqlite's prepared statements ---
function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}
function get(sql, params = []) {
  return db.prepare(sql).get(...params);
}
function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

/** Runs fn() inside a SQLite transaction, committing on success and rolling
 *  back if fn() throws (including a plain JS error from bad input deep in a
 *  multi-step write, not just a SQL failure). Every statement in this app
 *  runs synchronously with no `await` in between (node:sqlite is
 *  synchronous, and this server is single-process/single-threaded), so a
 *  transaction here isn't guarding against another request interleaving —
 *  it's guarding against a crash or thrown error midway through a multi-row
 *  write (e.g. a booking + its riders + its addon line items) leaving
 *  half-written, inconsistent rows behind. Use for any write that touches
 *  more than one table and must succeed or fail as a unit. */
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { db, all, get, run, transaction, DB_PATH };
