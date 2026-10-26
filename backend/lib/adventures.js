'use strict';
/* ===========================================================================
   THE UNIVERSAL ADVENTURE MODEL

   One table (`tours`), one detail template, one set of filters — whatever the
   activity. This file is the piece that makes that work, and it is the file
   you edit to add an activity.

   Three things live here:

   1. DIFFICULTY_LEVELS — the five universal levels, with what each one
      actually means. Shared by every activity so that "Moderate" means the
      same amount of commitment on a trek as on a ride.

   2. ACTIVITY_FIELDS — per activity, the attributes that only that activity
      has. Walking hours matter to a trek, rapid grade to a rafting trip, and
      neither to the other. These go into tours.activity_data_json, validated
      here on write, so adding trekking did not mean adding eighteen nullable
      columns of which sixteen are always NULL.

   3. DIFFICULTY_DIMENSIONS — per activity, which axes of difficulty are
      meaningful. A ride is scored on fitness, technical ability and
      altitude; a rafting trip on rapid grade, swimming and physical demand.
      The brief is explicit that these are not interchangeable, so they are
      declared per activity rather than assumed to be the same three.

   ---------------------------------------------------------------------------
   ADDING AN ACTIVITY (the whole procedure)

     1. Insert a row in `activity_types` (admin panel -> Activities), or flip
        an existing row's `enabled` to 1.
     2. Add an entry to ACTIVITY_FIELDS below describing its own fields.
     3. Add an entry to DIFFICULTY_DIMENSIONS saying how it is graded.

   That is all. No migration, no new table, no second detail page, no
   duplicated card component, no change to the filters or the finder — they
   all read `activity_types` and these maps. An activity with no entry here
   still works: it gets the universal fields and the three default
   dimensions, which is the correct fallback rather than a crash.
   =========================================================================== */

const { all, get } = require('../db');

/* ---------------------------------------------------------------------------
   THE FIVE UNIVERSAL LEVELS

   `meaning` is what a visitor reads. `commitment` is the sentence that makes
   the level concrete enough to self-assess against, which is the part most
   difficulty scales leave out and the part people actually need.
   --------------------------------------------------------------------------- */
const DIFFICULTY_LEVELS = [
  {
    level: 1,
    label: 'Relaxed',
    meaning: 'Low physical demand and accessible conditions.',
    commitment: 'Short active days with plenty of time, on easy ground and at low altitude. No previous experience assumed.',
  },
  {
    level: 2,
    label: 'Active',
    meaning: 'Some sustained activity; suitable for generally active travellers.',
    commitment: 'Half to most of the day active, a few hours at a time, with an easy way out. If you exercise occasionally you will be fine.',
  },
  {
    level: 3,
    label: 'Moderate',
    meaning: 'Regular activity and meaningful physical effort.',
    commitment: 'Full days, several in a row, with real climbing or distance. Assumes you are riding, walking or running regularly before you come.',
  },
  {
    level: 4,
    label: 'Challenging',
    meaning: 'Strong fitness and/or relevant technical experience.',
    commitment: 'Long days back to back, often above 3,000 m, on ground where skill matters. Assumes consistent training and previous experience of this kind of terrain.',
  },
  {
    level: 5,
    label: 'Tough',
    meaning: 'High sustained demand, technical difficulty, altitude, or remoteness.',
    commitment: 'Consecutive hard days, high passes, committing terrain and no quick way out. Assumes you have done something comparable before and know how you respond to altitude.',
  },
];

const difficultyLevel = n => DIFFICULTY_LEVELS.find(l => l.level === Number(n)) || null;

/* ---------------------------------------------------------------------------
   PER-ACTIVITY DIFFICULTY DIMENSIONS

   `key` is what gets stored. The first three keys map to the real columns
   difficulty_fitness / difficulty_technical / difficulty_altitude, because
   those three are filtered and sorted on; any further dimension an activity
   declares is stored inside activity_data_json under the same key.
   --------------------------------------------------------------------------- */
const DEFAULT_DIMENSIONS = [
  { key: 'fitness', label: 'Fitness', description: 'How much sustained physical effort the trip asks for, day after day.' },
  { key: 'technical', label: 'Technical', description: 'How much skill the terrain demands, and what a mistake costs.' },
  { key: 'altitude', label: 'Altitude', description: 'How high the trip goes and how much acclimatisation it needs.' },
];

const DIFFICULTY_DIMENSIONS = {
  'mountain-biking': [
    { key: 'fitness', label: 'Fitness', description: 'Consecutive days in the saddle with sustained climbing. The days add up faster than any one of them suggests.' },
    { key: 'technical', label: 'Technical', description: 'Trail difficulty and exposure. A 4 means loose, steep, consequential ground where you need to be comfortable already.' },
    { key: 'altitude', label: 'Altitude', description: 'Maximum height and how fast the trip gets there. Above 4,000 m this becomes the limiting factor, not fitness.' },
  ],
  trekking: [
    { key: 'fitness', label: 'Fitness', description: 'Walking hours per day and daily ascent, repeated for the length of the trip.' },
    { key: 'technical', label: 'Terrain', description: 'Ground conditions underfoot — stone staircases, moraine, snow on a pass. Not technical climbing, but not a path either.' },
    { key: 'altitude', label: 'Altitude', description: 'Maximum height and the acclimatisation profile. The single biggest reason people turn back.' },
  ],
  rafting: [
    { key: 'fitness', label: 'Physical demand', description: 'Hours paddling, portaging and setting up camp.' },
    { key: 'technical', label: 'Rapid grade', description: 'The international scale, I to VI. Grade IV and above assumes previous whitewater experience.' },
    { key: 'swimming', label: 'Swimming', description: 'How confident you need to be in moving water if you come out of the boat. Not optional on any river trip.' },
  ],
  'trail-running': [
    { key: 'fitness', label: 'Fitness', description: 'Daily distance and vertical, and how many days in a row of it.' },
    { key: 'technical', label: 'Technical', description: 'Running surface and exposure — how much of the day is on ground you have to look at.' },
    { key: 'altitude', label: 'Altitude', description: 'Maximum height. Running at altitude punishes a bad acclimatisation plan faster than walking does.' },
  ],
  'multi-activity': DEFAULT_DIMENSIONS,
};

const dimensionsFor = activity => DIFFICULTY_DIMENSIONS[activity] || DEFAULT_DIMENSIONS;

/* ---------------------------------------------------------------------------
   PER-ACTIVITY FIELDS

   type: 'number' | 'text' | 'longtext' | 'list' | 'select'
   Everything is optional — an adventure with none of these filled in renders
   its "at a glance" section with fewer rows rather than with blanks.
   --------------------------------------------------------------------------- */
const ACTIVITY_FIELDS = {
  'mountain-biking': [
    { key: 'riding_style', label: 'Riding style', type: 'select', options: ['XC', 'Trail', 'Enduro', 'Bikepacking', 'Downhill', 'Gravel', 'Mixed'], glance: true },
    { key: 'riding_km', label: 'Riding distance', type: 'number', unit: 'km', glance: true },
    { key: 'technical_level', label: 'Technical level', type: 'number', min: 1, max: 5, help: 'Trail difficulty on the 1-5 scale, shown on the detail page alongside the overall level.' },
    { key: 'terrain', label: 'Terrain', type: 'text', glance: true },
    { key: 'bike_requirements', label: 'Bike requirements', type: 'longtext', help: 'Travel bike, hardtail, full suspension, minimum travel — whatever this route genuinely needs.' },
    { key: 'bike_equipment', label: 'Bike equipment required', type: 'list' },
    { key: 'trail_notes', label: 'Trail notes', type: 'longtext' },
    { key: 'fitness_notes', label: 'Fitness requirements', type: 'longtext' },
  ],
  trekking: [
    { key: 'walking_hours_per_day', label: 'Walking hours per day', type: 'text', glance: true },
    { key: 'daily_elevation_gain_m', label: 'Typical daily ascent', type: 'number', unit: 'm', glance: true },
    { key: 'highest_altitude_m', label: 'Highest altitude', type: 'number', unit: 'm', glance: true },
    { key: 'terrain', label: 'Terrain', type: 'text', glance: true },
    { key: 'porter_support', label: 'Porter support', type: 'longtext', help: 'Whether porters carry, what weight limit applies, and how they are paid and insured.' },
    { key: 'support_team', label: 'Support team', type: 'longtext' },
    { key: 'accommodation_detail', label: 'Accommodation detail', type: 'longtext' },
    { key: 'fitness_notes', label: 'Fitness requirements', type: 'longtext' },
  ],
  rafting: [
    { key: 'rapid_grade', label: 'Rapid grade', type: 'select', options: ['I', 'II', 'III', 'III-IV', 'IV', 'IV-V', 'V'], glance: true },
    { key: 'river_days', label: 'Days on the river', type: 'number', unit: 'days', glance: true },
    { key: 'river_name', label: 'River', type: 'text', glance: true },
    { key: 'swimming_requirement', label: 'Swimming requirement', type: 'longtext', help: 'Stated plainly — this is a safety requirement, not a preference.' },
    { key: 'equipment_provided', label: 'Equipment provided', type: 'list' },
    { key: 'safety_requirements', label: 'Safety requirements', type: 'longtext' },
  ],
  'multi-activity': [
    { key: 'activities_included', label: 'Activities included', type: 'list', glance: true },
    { key: 'activity_split', label: 'How the days split', type: 'longtext' },
    { key: 'terrain', label: 'Terrain', type: 'text', glance: true },
    { key: 'fitness_notes', label: 'Fitness requirements', type: 'longtext' },
  ],
  'trail-running': [
    { key: 'daily_distance_km', label: 'Daily distance', type: 'number', unit: 'km', glance: true },
    { key: 'daily_vertical_m', label: 'Daily vertical', type: 'number', unit: 'm', glance: true },
    { key: 'highest_altitude_m', label: 'Highest altitude', type: 'number', unit: 'm', glance: true },
    { key: 'terrain', label: 'Terrain', type: 'text', glance: true },
    { key: 'support', label: 'Support provided', type: 'longtext' },
    { key: 'fitness_notes', label: 'Fitness requirements', type: 'longtext' },
  ],
};

const fieldsFor = activity => ACTIVITY_FIELDS[activity] || [];

/* --------------------------------------------------------------------------
   Enumerations shared with the admin panel and the public filters. Trip
   format and accommodation are small, stable sets that the brief names
   explicitly, so they live in code; activities live in the database because
   the brief wants new ones enabled without a deploy.
   -------------------------------------------------------------------------- */
const TRIP_FORMATS = [
  { key: 'small-group', label: 'Small Group', description: 'A scheduled departure with a capped group size. You join other travellers.' },
  { key: 'private', label: 'Private', description: 'The same itinerary, run for your group alone, on dates you choose.' },
  { key: 'custom', label: 'Custom', description: 'Built from scratch around what you want to do, how long you have and how hard you want it.' },
];

const ACCOMMODATION_TYPES = [
  { key: 'hotel', label: 'Hotel', description: 'Private room with a private bathroom, in a town.' },
  { key: 'lodge', label: 'Lodge', description: 'Village lodge. Private twin rooms, bathroom usually shared, hot water usually available.' },
  { key: 'teahouse', label: 'Teahouse', description: 'Trail teahouse. Simple twin or dormitory rooms, shared bathroom, no heating in the rooms.' },
  { key: 'camping', label: 'Camping', description: 'Tents, carried and pitched by the support team. Used where there is nothing else.' },
];

const DURATION_BANDS = [
  { key: 'under-7', label: 'Under 7 days', min: 1, max: 6 },
  { key: '7-10', label: '7–10 days', min: 7, max: 10 },
  { key: '11-14', label: '11–14 days', min: 11, max: 14 },
  { key: '15-plus', label: '15+ days', min: 15, max: 365 },
];

/** The finder's four difficulty answers, mapped onto the five levels. The
 *  finder asks a human question ("how challenging?") with four options; the
 *  model has five levels. Challenging and Tough are deliberately folded
 *  together under "Challenging" so that a visitor who picks the hardest
 *  option still sees everything hard, rather than only the level 5s. */
const FINDER_DIFFICULTY = {
  relaxed: [1, 2],
  moderate: [2, 3],
  challenging: [3, 4],
  tough: [4, 5],
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/* --------------------------------------------------------------------------
   Activity types, read from the database and cached for the life of a
   request batch. A tiny cache rather than a query per adventure: shaping a
   listing of twenty adventures would otherwise hit this table twenty times
   for a five-row answer.
   -------------------------------------------------------------------------- */
let activityCache = null;
let activityCacheAt = 0;
const ACTIVITY_CACHE_MS = 5000;

function activityTypes({ enabledOnly = false } = {}) {
  const now = Date.now();
  if (!activityCache || now - activityCacheAt > ACTIVITY_CACHE_MS) {
    activityCache = all('SELECT slug, name, plural_label, summary, icon, enabled, sort_order FROM activity_types ORDER BY sort_order, name');
    activityCacheAt = now;
  }
  return enabledOnly ? activityCache.filter(a => a.enabled === 1) : activityCache;
}

/** Called after any write to activity_types, so the admin panel's change is
 *  visible on the next request instead of up to five seconds later. */
function invalidateActivityCache() {
  activityCache = null;
}

function activityType(slug) {
  return activityTypes().find(a => a.slug === slug) || null;
}

/* --------------------------------------------------------------------------
   Parsing and shaping
   -------------------------------------------------------------------------- */

/** JSON.parse that cannot throw and always returns the shape asked for.
 *
 *  Every *_json column in this schema is written by our own code, but a
 *  database that has been edited by hand (or a column that predates its
 *  default) can still hold '' or NULL or a bare string. A tour page is not
 *  worth a 500 over a malformed optional field, so a bad value degrades to
 *  the empty case. */
function parseJson(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback;
    if (fallback && typeof fallback === 'object') {
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    }
    return parsed;
  } catch {
    return fallback;
  }
}

/** Turns a `tours` row into the adventure shape every page reads.
 *
 *  Single source of truth, in the brief's sense: the card, the listing, the
 *  detail page, the destination page, the finder results and the checkout
 *  summary are all built from this one function's output. A field added here
 *  appears everywhere; a field computed in a template appears in one place
 *  and is wrong in the others by next month.
 *
 *  @param row   a row from `tours`
 *  @param opts.full  include the long-form detail-page content. Listings pass
 *                    false, which keeps a twenty-card response small —
 *                    descriptions and FAQ arrays are several KB per
 *                    adventure and nothing on a card reads them.
 */
function shapeAdventure(row, { full = false } = {}) {
  if (!row) return null;

  const activity = row.activity || 'mountain-biking';
  const type = activityType(activity);
  const activityData = parseJson(row.activity_data_json, {});

  // The three stored dimensions, plus any further dimension this activity
  // declares (rafting's `swimming`), which lives in activity_data_json.
  const dims = dimensionsFor(activity).map(d => {
    const stored =
      d.key === 'fitness' ? row.difficulty_fitness
      : d.key === 'technical' ? row.difficulty_technical
      : d.key === 'altitude' ? row.difficulty_altitude
      : activityData['difficulty_' + d.key];
    const score = stored === null || stored === undefined || stored === '' ? null : Number(stored);
    return { ...d, score: Number.isFinite(score) ? score : null };
  });

  // A dimension set where every score equals the overall level is what the
  // migration's backfill produced, i.e. nobody has assessed them yet. Saying
  // so is more honest than presenting three identical bars as a judgement,
  // and it is what prompts an admin to go and set them.
  const assessed = dims.some(d => d.score !== null && d.score !== Number(row.difficulty_level));

  // The activity-specific fields, in declaration order, with their values and
  // only where a value exists. `glance` marks the ones the "at a glance"
  // block shows — which is how a trekking page shows walking hours where a
  // riding page shows riding style, from one template.
  const activityFields = fieldsFor(activity)
    .map(f => ({ ...f, value: activityData[f.key] ?? null }))
    .filter(f => f.value !== null && f.value !== '' && !(Array.isArray(f.value) && f.value.length === 0));

  const base = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    summary: row.summary,

    activity,
    activity_label: type ? type.name : activity,
    destination_slug: row.destination_slug || null,
    region: row.region,
    district: row.district || null,

    duration_days: row.duration_days,
    trip_format: row.trip_format || 'small-group',
    accommodation_type: row.accommodation_type || null,
    best_season: row.best_season || null,

    difficulty_level: row.difficulty_level,
    difficulty: difficultyLevel(row.difficulty_level),
    difficulty_dimensions: dims,
    difficulty_assessed: assessed,

    // Figures. Null rather than 0 where a trip genuinely has no such number:
    // a rafting trip has no elevation gain, and printing "+0 m" on its card
    // would read as a measurement rather than as an absence.
    distance_km: row.distance_km ?? null,
    elevation_gain_m: row.elevation_gain_m ?? null,
    elevation_loss_m: row.elevation_loss_m ?? null,
    max_altitude_m: row.max_altitude_m ?? null,

    price_from_cents: row.price_from_cents,
    deposit_cents: row.deposit_cents ?? null,
    currency: row.currency || 'EUR',

    group_size_min: row.group_size_min,
    group_size_max: row.group_size_max,

    image_url: row.image_url || null,
    published: row.published === undefined ? 1 : row.published,

    activity_fields: activityFields,
    activity_glance: activityFields.filter(f => f.glance),
  };

  if (!full) return base;

  return {
    ...base,
    description_full: row.description_full || null,
    highlights: parseJson(row.highlights_json, []),
    accommodation_notes: row.accommodation_notes || null,

    inclusions: parseJson(row.inclusions_json, []),
    exclusions: parseJson(row.exclusions_json, []),
    mandatory_charges: parseJson(row.mandatory_charges_json, []),
    optional_extras: parseJson(row.optional_extras_json, []),

    equipment_essential: parseJson(row.equipment_essential_json, []),
    equipment_recommended: parseJson(row.equipment_recommended_json, []),

    suitability: {
      fitness: row.suitability_fitness || null,
      technical: row.suitability_technical || null,
      altitude: row.suitability_altitude || null,
      experience: row.suitability_experience || null,
      daily: row.suitability_daily || null,
    },
    before_you_book: {
      insurance: row.booking_insurance || null,
      visa: row.booking_visa || null,
      health: row.booking_health || null,
      age: row.booking_age || null,
      equipment: parseJson(row.equipment_essential_json, []).length ? 'See the equipment list above.' : null,
      cancellation: row.cancellation_policy || null,
    },
    safety: {
      hazards: row.safety_hazards || null,
      preparation: row.safety_preparation || null,
      emergency: row.safety_emergency || null,
    },
    impact: parseJson(row.impact_json, {}),
    faqs: parseJson(row.faqs_json, []),
    activity_data: activityData,
    created_at: row.created_at,
    updated_at: row.updated_at || null,
  };
}

/* --------------------------------------------------------------------------
   Validation on write
   -------------------------------------------------------------------------- */

/** Validates an activity_data object against the activity's declared fields.
 *
 *  Returns { ok: true, value } or { ok: false, error }. Unknown keys are
 *  dropped rather than rejected: the admin panel posts the whole form, and a
 *  field that was removed from ACTIVITY_FIELDS in a later release should not
 *  make every save of an older adventure fail. */
function validateActivityData(activity, input) {
  if (input === null || input === undefined) return { ok: true, value: {} };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'activityData must be an object' };
  }
  const defs = fieldsFor(activity);
  const out = {};
  for (const def of defs) {
    const raw = input[def.key];
    if (raw === null || raw === undefined || raw === '') continue;
    if (def.type === 'number') {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: `${def.label} must be a number` };
      if (def.min !== undefined && n < def.min) return { ok: false, error: `${def.label} must be at least ${def.min}` };
      if (def.max !== undefined && n > def.max) return { ok: false, error: `${def.label} must be at most ${def.max}` };
      out[def.key] = n;
    } else if (def.type === 'list') {
      if (!Array.isArray(raw)) return { ok: false, error: `${def.label} must be a list` };
      const items = raw.map(x => String(x).trim()).filter(Boolean);
      if (items.length) out[def.key] = items;
    } else if (def.type === 'select') {
      const v = String(raw).trim();
      if (def.options && !def.options.includes(v)) {
        return { ok: false, error: `${def.label} must be one of: ${def.options.join(', ')}` };
      }
      out[def.key] = v;
    } else {
      const v = String(raw).trim();
      if (v.length > 4000) return { ok: false, error: `${def.label} is too long (4000 characters max)` };
      if (v) out[def.key] = v;
    }
  }
  // Any extra difficulty dimension this activity declares beyond the three
  // stored in columns (rafting's `swimming`) is carried here.
  for (const d of dimensionsFor(activity)) {
    if (['fitness', 'technical', 'altitude'].includes(d.key)) continue;
    const raw = input['difficulty_' + d.key];
    if (raw === null || raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 5) {
      return { ok: false, error: `${d.label} must be a whole number from 1 to 5` };
    }
    out['difficulty_' + d.key] = n;
  }
  return { ok: true, value: out };
}

/** Is this a known activity, and is it one the public site should show?
 *  Admin writes may use a disabled activity (that is how a category is
 *  prepared before launch); public reads may not. */
function isKnownActivity(slug) {
  return !!activityType(slug);
}

/** The `published AND activity is enabled` condition every public query
 *  needs, as a SQL fragment plus params. Centralised because getting it
 *  wrong in one place is how a disabled category leaks onto the site. */
function publicWhere(alias = 't') {
  const enabled = activityTypes({ enabledOnly: true }).map(a => a.slug);
  if (!enabled.length) return { sql: '1 = 0', params: [] };
  return {
    sql: `${alias}.published = 1 AND ${alias}.activity IN (${enabled.map(() => '?').join(',')})`,
    params: enabled,
  };
}

/** Does this adventure's best_season text cover the given month?
 *
 *  best_season is free text an admin types ("Sep – Nov", "Mar – May, Sep –
 *  Nov", "Year-round"), which is right for display and useless for
 *  filtering, so this parses it. Handles the three shapes that actually
 *  occur: year-round, a single range, and comma-separated ranges. Ranges
 *  that wrap the year end ("Oct – Apr") are handled by the wrap test.
 *
 *  An unparseable value returns true rather than false — a visitor filtering
 *  by month should see an adventure whose season nobody has typed properly
 *  rather than silently lose it. Showing one trip too many is a smaller
 *  failure than hiding one that was available.
 */
const MONTH_ABBR = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function seasonCoversMonth(bestSeason, month) {
  const m = Number(month);
  if (!Number.isInteger(m) || m < 1 || m > 12) return true;
  if (!bestSeason) return true;
  const text = String(bestSeason).toLowerCase();
  if (text.includes('year') || text.includes('all year')) return true;

  // Split on commas and the words "and"/"&" — "Mar – May, Sep – Nov".
  const parts = text.split(/,|\band\b|&/).map(s => s.trim()).filter(Boolean);
  let sawRange = false;
  for (const part of parts) {
    const found = [...part.matchAll(/([a-z]{3})[a-z]*/g)]
      .map(x => MONTH_ABBR[x[1]])
      .filter(Boolean);
    if (!found.length) continue;
    if (found.length === 1) {
      sawRange = true;
      if (found[0] === m) return true;
      continue;
    }
    sawRange = true;
    const [from, to] = [found[0], found[found.length - 1]];
    // A range whose end month is before its start wraps the year end.
    const inRange = from <= to ? m >= from && m <= to : m >= from || m <= to;
    if (inRange) return true;
  }
  return sawRange ? false : true;
}

function durationBand(days) {
  return DURATION_BANDS.find(b => days >= b.min && days <= b.max) || null;
}

module.exports = {
  DIFFICULTY_LEVELS,
  DIFFICULTY_DIMENSIONS,
  DEFAULT_DIMENSIONS,
  ACTIVITY_FIELDS,
  TRIP_FORMATS,
  ACCOMMODATION_TYPES,
  DURATION_BANDS,
  FINDER_DIFFICULTY,
  MONTHS,
  difficultyLevel,
  dimensionsFor,
  fieldsFor,
  activityTypes,
  activityType,
  invalidateActivityCache,
  isKnownActivity,
  publicWhere,
  parseJson,
  shapeAdventure,
  validateActivityData,
  seasonCoversMonth,
  durationBand,
};
