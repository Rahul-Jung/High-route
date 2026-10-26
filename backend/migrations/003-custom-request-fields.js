'use strict';
/* ===========================================================================
   MIGRATION — the Private Trips enquiry fields

   The custom-request table was built for the mountain-bike "build your
   adventure" wizard: destination, duration bucket, riding style, experience,
   group size, budget. The brief's Private Trips page asks for more than
   that — which activity, a difficulty preference, accommodation preferences,
   special requirements and travel dates with a bit more precision than one
   preferred date.

   Those could all have gone into preferences_json, which already exists.
   They are columns instead because each one is a thing the team will filter
   and sort the CRM board by, and a JSON blob is where data goes to stop
   being queryable. `preferences_json` keeps doing what it is good at:
   holding the free-form checkbox list that has no fixed vocabulary.

   Additive with no defaults beyond NULL, so every existing request and the
   existing wizard keep working untouched.
   =========================================================================== */

module.exports = function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(custom_requests)').all().map(c => c.name);
  const add = (col, def) => {
    if (!cols.includes(col)) db.exec(`ALTER TABLE custom_requests ADD COLUMN ${col} ${def}`);
  };

  // Which activity the enquiry is for. No CHECK constraint, for the same
  // reason tours.activity has none: the valid set lives in activity_types.
  add('activity', 'TEXT');

  // 'relaxed' | 'active' | 'moderate' | 'challenging' | 'tough', matching the
  // five universal levels by label rather than by number — an enquirer is
  // choosing a word, and storing the word keeps the record readable.
  add('difficulty_pref', 'TEXT');

  // 'hotel' | 'lodge' | 'teahouse' | 'camping' | 'no-preference'
  add('accommodation_pref', 'TEXT');

  add('special_requirements', 'TEXT');

  // An enquirer usually knows the month before the day. preferred_date (which
  // already exists) stays for an exact date; these two carry a window.
  add('date_from', 'TEXT');
  add('date_to', 'TEXT');

  // How they would like to be reached, and on what number. The table had
  // only the account's email, so a request saying "please call me" had
  // nowhere to put the number.
  add('phone', 'TEXT');
  add('contact_preference', 'TEXT');

  // Where the enquiry came from — the Private Trips page, the build-adventure
  // wizard, or a specific adventure's "ask about a private departure" link.
  // Worth recording because the three arrive with very different amounts of
  // detail and the team triages them differently.
  add('source', 'TEXT');
};
