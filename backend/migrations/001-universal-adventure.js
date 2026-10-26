'use strict';
/* ===========================================================================
   MIGRATION — mountain-bike tours become universal adventures

   The site launched mountain-bike-only and the `tours` table was shaped
   around that: riding_style, distance_km and elevation_gain_m as NOT NULL
   columns, and no column anywhere saying what kind of activity a trip even
   was. Adding trekking by copying the table would have produced two tables,
   two detail templates and two of every query.

   What this does instead: every adventure keeps ONE row in `tours` carrying
   the universal fields (title, duration, difficulty, price, season, format,
   accommodation), and anything that only makes sense for one activity lives
   in activity_data_json, validated per activity by ACTIVITY_FIELDS in
   lib/adventures.js. A new activity is then a row in `activity_types` plus
   an entry in that map — no migration, no new table, no second detail page.

   Why activity_data_json rather than a column per activity-specific field:
   walking hours matter to a trek, rapid grade to a rafting trip, and neither
   to the other. Twenty nullable columns where eighteen are always NULL is a
   table nobody can read, and every new activity would mean another
   migration. The universal fields are real columns because every adventure
   has them and they get filtered and sorted on; the activity-specific ones
   are a validated JSON object because they are per-activity and only ever
   read as a complete set for one adventure at a time.

   Everything here is additive and idempotent — safe on every boot, and the
   six existing mountain-bike tours render exactly as they did before.
   =========================================================================== */

module.exports = function migrate(db) {
  const colsOf = table => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

  /* ---------------- tours ---------------- */
  {
    const cols = colsOf('tours');
    const add = (col, def) => {
      if (!cols.includes(col)) db.exec(`ALTER TABLE tours ADD COLUMN ${col} ${def}`);
    };

    // What kind of adventure this is. No CHECK constraint: the valid set
    // lives in the activity_types table so an admin can enable a new
    // category without a table rebuild, and writes are validated against
    // that table in lib/adventures.js instead.
    add('activity', "TEXT NOT NULL DEFAULT 'mountain-biking'");
    add('destination_slug', 'TEXT');
    add('description_full', 'TEXT');
    add('trip_format', "TEXT NOT NULL DEFAULT 'small-group'");
    add('accommodation_type', "TEXT NOT NULL DEFAULT 'lodge'");
    add('accommodation_notes', 'TEXT');

    // elevation_gain_m existed; loss did not, because the original tour
    // cards only ever quoted climbing. A descent-focused trip is sold on the
    // other number.
    add('elevation_loss_m', 'INTEGER');

    // Pricing the brief requires to be unambiguous.
    add('deposit_cents', 'INTEGER');
    add('mandatory_charges_json', "TEXT NOT NULL DEFAULT '[]'");
    add('optional_extras_json', "TEXT NOT NULL DEFAULT '[]'");

    // Universal difficulty framework (1-5) plus its activity dimensions.
    add('difficulty_fitness', 'INTEGER');
    add('difficulty_technical', 'INTEGER');
    add('difficulty_altitude', 'INTEGER');

    // Detail-page content.
    add('highlights_json', "TEXT NOT NULL DEFAULT '[]'");
    add('suitability_fitness', 'TEXT');
    add('suitability_technical', 'TEXT');
    add('suitability_altitude', 'TEXT');
    add('suitability_experience', 'TEXT');
    add('suitability_daily', 'TEXT');
    add('booking_insurance', 'TEXT');
    add('booking_visa', 'TEXT');
    add('booking_health', 'TEXT');
    add('booking_age', 'TEXT');
    add('faqs_json', "TEXT NOT NULL DEFAULT '[]'");

    // Per-activity and per-adventure extension points.
    add('activity_data_json', "TEXT NOT NULL DEFAULT '{}'");
    add('impact_json', "TEXT NOT NULL DEFAULT '{}'");

    add('published', 'INTEGER NOT NULL DEFAULT 1');
    add('updated_at', 'TEXT');

    // Backfill 1 — riding_style into activity_data_json.
    //
    // riding_style is the mountain-bike activity's own field, and it is NOT
    // NULL on the old table, so it cannot simply be dropped. Copy it to
    // where every other activity-specific field now lives, leaving the
    // column in place so the existing admin panel and API responses keep
    // working. Only touches rows still carrying the default '{}' — never
    // overwrites what an admin has since entered through the new editor.
    const needsActivityData = db
      .prepare(
        `SELECT id, riding_style, distance_km FROM tours
          WHERE activity_data_json = '{}' OR activity_data_json IS NULL OR activity_data_json = ''`
      )
      .all();
    const setActivityData = db.prepare('UPDATE tours SET activity_data_json = ? WHERE id = ?');
    for (const t of needsActivityData) {
      setActivityData.run(
        JSON.stringify({
          riding_style: t.riding_style || null,
          riding_km: t.distance_km == null ? null : Number(t.distance_km),
        }),
        t.id
      );
    }

    // Backfill 2 — the three difficulty dimensions.
    //
    // The old table had a single 1-5 difficulty_level, so the honest
    // conversion is to seed all three dimensions from it and let an admin
    // refine them, rather than inventing a spread (say, technical two below
    // fitness) that nobody actually assessed. A trip whose dimensions all
    // equal its overall level shows as "not yet assessed" in the admin
    // panel, which is the intended prompt to go and set them.
    db.exec(`UPDATE tours
                SET difficulty_fitness   = COALESCE(difficulty_fitness,   difficulty_level),
                    difficulty_technical = COALESCE(difficulty_technical, difficulty_level),
                    difficulty_altitude  = COALESCE(difficulty_altitude,  difficulty_level)`);

    // Backfill 3 — deposit, at 20% of the trip price rounded to whole
    // currency units, only where none has been set.
    //
    // This is a placeholder figure High Route has to confirm. It is flagged
    // as such in the admin panel's pricing section and in README section 7
    // rather than presented to travellers as settled policy.
    db.exec(`UPDATE tours
                SET deposit_cents = CAST(price_from_cents * 0.2 / 100 AS INTEGER) * 100
              WHERE deposit_cents IS NULL`);

    // Backfill 4 — link each tour to its destination.
    //
    // The tours each already name a region matching a seeded destination, so
    // this links them and lets destination pages list their adventures
    // without a second source of truth. LOWER() both sides because `region`
    // is a display label ("Mustang", "Kathmandu Valley").
    db.exec(`UPDATE tours SET destination_slug = (
                SELECT d.slug FROM destinations d
                 WHERE LOWER(d.slug) = LOWER(REPLACE(tours.region, ' ', '-'))
                    OR LOWER(d.name) = LOWER(tours.region)
                 LIMIT 1)
              WHERE destination_slug IS NULL`);
  }

  /* ---------------- destinations ---------------- */
  // A destination page needs more than a pin on the homepage map: an intro,
  // when to come, practical notes and its own FAQs.
  {
    const cols = colsOf('destinations');
    const add = (col, def) => {
      if (!cols.includes(col)) db.exec(`ALTER TABLE destinations ADD COLUMN ${col} ${def}`);
    };
    add('intro', 'TEXT');
    add('best_time', 'TEXT');
    add('practical_json', "TEXT NOT NULL DEFAULT '[]'");
    add('activities_json', "TEXT NOT NULL DEFAULT '[]'");
    add('related_json', "TEXT NOT NULL DEFAULT '[]'");
    add('elevation_range', 'TEXT');
    add('getting_there', 'TEXT');
    // A destination with no page content yet is hidden from the Destinations
    // index rather than shipped as a hero image above three empty sections.
    add('published', 'INTEGER NOT NULL DEFAULT 1');
  }

  /* ---------------- guides ---------------- */
  // Which activities each guide leads, so a trekking trip does not list a
  // guide whose entire record is mountain-bike experience.
  {
    const cols = colsOf('guides');
    if (!cols.includes('activities_json')) {
      db.exec("ALTER TABLE guides ADD COLUMN activities_json TEXT NOT NULL DEFAULT '[]'");
      // Every guide on the books today was hired to lead mountain-bike trips.
      db.exec(`UPDATE guides SET activities_json = '["mountain-biking"]' WHERE activities_json = '[]'`);
    }
  }
};
