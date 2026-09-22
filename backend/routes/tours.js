'use strict';
const { all, get } = require('../db');
const { ok, notFound, badRequest } = require('../lib/util');
const { PUBLIC_FIELDS: GUIDE_PUBLIC_FIELDS, toPublicGuide } = require('./guides');

/** Parses one of tours' *_json array columns, defaulting to [] for null/
 *  malformed values so a tour that's never had this field touched (or an
 *  old row from before the column existed) still returns a real array
 *  rather than throwing. */
function parseJsonArray(raw) {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

// `best_season` is free-text (e.g. "Sep – Nov", "Oct – Apr",
// "Mar – May, Sep – Nov", "Year-round") rather than a structured field, so
// season filtering expands each range into the actual months it spans
// (handling ranges that wrap the year end, like "Oct – Apr") rather than
// just substring-matching the two endpoint months. "Year-round" tours
// always match, whatever season is requested.
const MONTH_INDEX = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
const SEASON_MONTH_INDEXES = {
  spring: [2, 3, 4],
  summer: [5, 6, 7],
  autumn: [8, 9, 10],
  winter: [11, 0, 1],
};

/** Comma-separated list of whole numbers, e.g. "2,3" -> [2,3]. Returns null
 *  (rather than []) on empty/malformed input so callers can 400 on it. */
function parseIntCsv(raw) {
  const out = [];
  for (const token of String(raw).split(',').map(s => s.trim()).filter(Boolean)) {
    if (!/^\d+$/.test(token)) return null;
    out.push(Number(token));
  }
  return out.length ? out : null;
}

/** Comma-separated list of non-empty strings, e.g. "XC,Trail" -> ['XC','Trail']. */
function parseStrCsv(raw) {
  const out = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  return out.length ? out : null;
}

/** Comma-separated list of "lo-hi" integer range tokens, e.g.
 *  "1-3,8-14" -> [[1,3],[8,14]] — used by the duration and group-size
 *  bucket filters, which both let a rider select several ranges at once. */
function parseRangeCsv(raw) {
  const ranges = [];
  for (const token of String(raw).split(',').map(s => s.trim()).filter(Boolean)) {
    const m = /^(\d+)-(\d+)$/.exec(token);
    if (!m) return null;
    const lo = Number(m[1]), hi = Number(m[2]);
    if (lo > hi) return null;
    ranges.push([lo, hi]);
  }
  return ranges.length ? ranges : null;
}

/** Riding hours live per-day as free text ranges (tour_days.riding_hours,
 *  e.g. "3–4", "6"). Summarizes a tour's whole itinerary into one
 *  "lo–hi hrs/day" label for the catalogue card. Returns null for tours with
 *  no day-by-day breakdown entered yet (nothing to summarize). */
function summarizeRidingHours(dayHoursList) {
  let lo = Infinity, hi = -Infinity;
  for (const raw of dayHoursList) {
    if (!raw) continue;
    const nums = String(raw).match(/\d+(\.\d+)?/g);
    if (!nums) continue;
    for (const n of nums) {
      const v = Number(n);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (lo === Infinity) return null;
  return lo === hi ? `${lo} hrs/day` : `${lo}–${hi} hrs/day`;
}

/** Expands a free-text best_season value into the set of month indices
 *  (0=Jan..11=Dec) it covers, walking forward from the range's start month
 *  to its end month so a wraparound range like "Oct – Apr" correctly picks
 *  up Nov/Dec/Jan/Feb/Mar in between. Returns null for "Year-round" (or
 *  anything unparseable), which the caller treats as matching every season. */
function expandBestSeasonMonths(text) {
  if (!text) return null;
  if (/year[\s-]*round/i.test(text)) return null;
  const months = new Set();
  for (const segment of text.split(',')) {
    const tokens = segment.split(/[–—-]/).map(s => s.trim().slice(0, 3).toLowerCase()).filter(Boolean);
    const idxs = tokens.map(t => MONTH_INDEX[t]).filter(i => i !== undefined);
    if (!idxs.length) continue;
    let [start, end] = idxs.length === 1 ? [idxs[0], idxs[0]] : idxs;
    for (let i = start; ; i = (i + 1) % 12) {
      months.add(i);
      if (i === end) break;
    }
  }
  return months.size ? months : null;
}

function matchesSeason(bestSeasonText, requestedSeasons) {
  const covered = expandBestSeasonMonths(bestSeasonText);
  if (covered === null) return true; // Year-round or unparseable — don't hide it behind a filter
  return requestedSeasons.some(s => SEASON_MONTH_INDEXES[s].some(i => covered.has(i)));
}

function register(router) {
  // GET /api/tours — every filter is optional and they all combine with AND.
  // Multi-value filters (difficulty, style, destination, season, and the
  // bucketed duration/groupType) take a comma-separated list and OR within
  // themselves, e.g. difficulty=2,3&style=Trail,Enduro&destination=Mustang.
  //   difficulty=<1-5>[,...]
  //   style=<text>[,...]                     (substring match on riding_style)
  //   destination=<region>[,...]             (alias: region= — kept for back-compat)
  //   duration=<lo-hi day range>[,...]
  //   minDuration=<days> / maxDuration=<days>
  //   minBudget=<currency units> / maxBudget=<currency units>  (alias: maxPrice=)
  //   season=spring|summer|autumn|winter[,...]
  //   groupType=<lo-hi group-size range>[,...]
  //   maxAltitude=<metres>
  router.get('/api/tours', (req, res) => {
    const {
      difficulty, style, region, destination, duration, minDuration, maxDuration,
      minBudget, maxBudget, maxPrice, season, groupType, maxAltitude,
    } = req.query;

    let sql = 'SELECT * FROM tours WHERE 1=1';
    const params = [];

    if (difficulty) {
      const levels = parseIntCsv(difficulty);
      if (!levels || levels.some(l => l < 1 || l > 5)) {
        return badRequest(res, 'difficulty must be a comma-separated list of levels between 1 and 5');
      }
      sql += ` AND difficulty_level IN (${levels.map(() => '?').join(',')})`;
      params.push(...levels);
    }

    if (style) {
      const styles = parseStrCsv(style);
      if (!styles) return badRequest(res, 'style must be a non-empty comma-separated list');
      sql += ` AND (${styles.map(() => 'riding_style LIKE ?').join(' OR ')})`;
      params.push(...styles.map(s => '%' + s + '%'));
    }

    // "destination" is the public-facing name for this filter; `region` is
    // kept working too since it's the documented/pre-existing param name.
    const destinationRaw = destination || region;
    if (destinationRaw) {
      const values = parseStrCsv(destinationRaw);
      if (!values) return badRequest(res, 'destination must be a non-empty comma-separated list');
      sql += ` AND region IN (${values.map(() => '?').join(',')})`;
      params.push(...values);
    }

    if (duration) {
      const ranges = parseRangeCsv(duration);
      if (!ranges) return badRequest(res, 'duration must be a comma-separated list of lo-hi day ranges, e.g. 1-3,8-14');
      sql += ` AND (${ranges.map(() => 'duration_days BETWEEN ? AND ?').join(' OR ')})`;
      ranges.forEach(([lo, hi]) => params.push(lo, hi));
    }
    if (minDuration) {
      if (!/^\d+$/.test(minDuration)) return badRequest(res, 'minDuration must be a whole number of days');
      sql += ' AND duration_days >= ?'; params.push(Number(minDuration));
    }
    if (maxDuration) {
      if (!/^\d+$/.test(maxDuration)) return badRequest(res, 'maxDuration must be a whole number of days');
      sql += ' AND duration_days <= ?'; params.push(Number(maxDuration));
    }
    if (minDuration && maxDuration && Number(minDuration) > Number(maxDuration)) {
      return badRequest(res, 'minDuration cannot be greater than maxDuration');
    }

    // maxPrice is a legacy alias for maxBudget (documented in README before
    // the budget filter existed) — both are accepted, budget wins if both given.
    const minBudgetRaw = minBudget;
    const maxBudgetRaw = maxBudget || maxPrice;
    if (minBudgetRaw) {
      if (!/^\d+(\.\d+)?$/.test(minBudgetRaw)) return badRequest(res, 'minBudget must be a non-negative number');
      sql += ' AND price_from_cents >= ?'; params.push(Math.round(Number(minBudgetRaw) * 100));
    }
    if (maxBudgetRaw) {
      if (!/^\d+(\.\d+)?$/.test(maxBudgetRaw)) return badRequest(res, 'maxBudget must be a non-negative number');
      sql += ' AND price_from_cents <= ?'; params.push(Math.round(Number(maxBudgetRaw) * 100));
    }
    if (minBudgetRaw && maxBudgetRaw && Number(minBudgetRaw) > Number(maxBudgetRaw)) {
      return badRequest(res, 'minBudget cannot be greater than maxBudget');
    }

    let seasonList = null;
    if (season) {
      const seasons = parseStrCsv(season);
      if (!seasons) return badRequest(res, 'season must be a non-empty comma-separated list');
      seasonList = seasons.map(s => s.toLowerCase());
      const invalid = seasonList.filter(s => !SEASON_MONTH_INDEXES[s]);
      if (invalid.length) {
        return badRequest(res, `season must be one of ${Object.keys(SEASON_MONTH_INDEXES).join(', ')} (got: ${invalid.join(', ')})`);
      }
    }

    if (groupType) {
      const ranges = parseRangeCsv(groupType);
      if (!ranges) return badRequest(res, 'groupType must be a comma-separated list of lo-hi group-size ranges, e.g. 2-4,5-8');
      // A tour's [group_size_min, group_size_max] range "supports" a
      // requested bucket when the two ranges overlap.
      sql += ` AND (${ranges.map(() => 'group_size_min <= ? AND group_size_max >= ?').join(' OR ')})`;
      ranges.forEach(([lo, hi]) => params.push(hi, lo));
    }

    if (maxAltitude) {
      if (!/^\d+$/.test(maxAltitude)) return badRequest(res, 'maxAltitude must be a whole number of metres');
      sql += ' AND max_altitude_m <= ?'; params.push(Number(maxAltitude));
    }

    sql += ' ORDER BY duration_days ASC';
    let tours = all(sql, params);
    if (seasonList) tours = tours.filter(t => matchesSeason(t.best_season, seasonList));

    // Attach live departure/availability info and a riding-hours summary for
    // each tour. A tour can have departures that are all in the past or
    // cancelled (has_departures true, upcoming_departures empty) or none at
    // all ever scheduled (has_departures false) — the frontend tells these
    // apart to show accurate availability instead of a generic "no dates".
    const withExtras = tours.map(t => {
      // is_custom = 0: a private custom-trip departure (see schema.sql)
      // never counts toward this tour's public availability — it belongs to
      // one specific customer, not something a stranger browsing tours.html
      // could book.
      const upcomingDepartures = all(
        `SELECT id, start_date, end_date, capacity, seats_booked, status
         FROM departures WHERE tour_id = ? AND is_custom = 0 AND date(start_date) >= date('now') AND status != 'cancelled'
         ORDER BY start_date ASC`,
        [t.id]);
      const hasDepartures = get('SELECT COUNT(*) AS n FROM departures WHERE tour_id = ? AND is_custom = 0', [t.id]).n > 0;
      const dayHours = all('SELECT riding_hours FROM tour_days WHERE tour_id = ?', [t.id]).map(d => d.riding_hours);
      return {
        ...t,
        upcoming_departures: upcomingDepartures,
        next_departure: upcomingDepartures[0] || null,
        has_departures: hasDepartures,
        riding_hours_summary: summarizeRidingHours(dayHours),
      };
    });
    ok(res, { count: withExtras.length, tours: withExtras });
  });

  // GET /api/tours/:slug — the full tour-detail-page payload: itinerary
  // days (with whatever overnight_lat/lng the admin has actually entered —
  // never fabricated), every departure, reviews, this tour's gallery
  // images, the distinct set of guides who've ever led one of its
  // departures, and the structured inclusions/exclusions/equipment/safety/
  // cancellation fields (each defaulting to an empty array or null, never
  // placeholder copy, when the admin hasn't filled them in).
  router.get('/api/tours/:slug', (req, res) => {
    const tour = get('SELECT * FROM tours WHERE slug = ?', [req.params.slug]);
    if (!tour) return notFound(res, 'Tour not found');
    const days = all('SELECT * FROM tour_days WHERE tour_id = ? ORDER BY day_number ASC', [tour.id]);
    // is_custom = 0 everywhere below: a private custom-trip departure never
    // appears on the public tour page — see schema.sql's comment on it.
    const departures = all(
      `SELECT d.*, g.name AS guide_name FROM departures d LEFT JOIN guides g ON g.id = d.guide_id
       WHERE d.tour_id = ? AND d.is_custom = 0 ORDER BY d.start_date ASC`, [tour.id]);
    const reviews = all('SELECT * FROM reviews WHERE tour_id = ? ORDER BY created_at DESC', [tour.id]);
    const gallery = all(
      `SELECT * FROM gallery_images WHERE category = 'tour' AND tour_id = ? ORDER BY sort_order ASC, created_at DESC`,
      [tour.id]);
    const guideCols = GUIDE_PUBLIC_FIELDS.split(', ').map(f => 'g.' + f).join(', ');
    const guides = all(
      `SELECT DISTINCT ${guideCols}
       FROM guides g JOIN departures d ON d.guide_id = g.id WHERE d.tour_id = ? AND d.is_custom = 0`,
      [tour.id]).map(toPublicGuide);

    const {
      inclusions_json, exclusions_json, equipment_essential_json, equipment_recommended_json, ...tourFields
    } = tour;
    ok(res, {
      ...tourFields,
      inclusions: parseJsonArray(inclusions_json),
      exclusions: parseJsonArray(exclusions_json),
      equipment_essential: parseJsonArray(equipment_essential_json),
      equipment_recommended: parseJsonArray(equipment_recommended_json),
      days, departures, reviews, gallery, guides,
    });
  });
}

module.exports = { register };
