/* ===========================================================================
   MIGRATION 005 — the itinerary day gets the fields the brief lists.

   Brief section 8.5: each day of the itinerary must support day number,
   title, description, distance, duration, elevation gain and loss, altitude,
   activity metrics, accommodation, meals and important notes.

   tour_days already had everything up to and including the metrics, plus
   the overnight place. It had nowhere to put:

     description    what the day actually is, in a sentence or two — the
                    panel was building one out of the terrain field
     accommodation  where you sleep, as a type or a description ("village
                    guesthouse", "teahouse, shared rooms"). overnight_place
                    is WHERE; this is WHAT. Never a named property unless
                    the operator has confirmed it (section 8.7).
     meals          which meals are included that day
     notes          anything a traveller must know — an early start, a
                    permit check, a day with no road access

   All four are optional and nullable. Nothing is seeded: they describe the
   operator's actual trips, and filling them with plausible text would be
   exactly the invented accommodation and meal claims the brief forbids. A
   day with none of them renders as it always has.
   =========================================================================== */
'use strict';

module.exports = function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(tour_days)').all().map(c => c.name);
  const add = (col) => {
    if (!cols.includes(col)) db.exec(`ALTER TABLE tour_days ADD COLUMN ${col} TEXT`);
  };
  add('description');
  add('accommodation');
  add('meals');
  add('notes');
};
