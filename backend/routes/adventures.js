'use strict';
/* ===========================================================================
   THE UNIVERSAL ADVENTURE API

   One listing endpoint, one detail endpoint, whatever the activity. These
   are what every public page reads — the homepage's featured cards, the
   adventures listing, the search page, a destination page's trip list, the
   Adventure Finder's results and the When to Visit recommendations all come
   through here, shaped by lib/adventures.js's shapeAdventure().

   /api/tours is kept exactly as it was and still serves the mountain-bike
   tour pages. It is not deprecated and it is not a wrapper: it answers a
   narrower question (the MTB catalogue, with riding-specific filters) and
   the booking flow is built on it. What it is not is the thing a trekking
   trip can be listed through, which is why this file exists.

   Filtering lives in SQL where the column exists, and in JS where the value
   is free text an admin typed (best_season). Everything that can be a WHERE
   clause is one, so a filtered listing does not read the whole table.
   =========================================================================== */
const { all, get, run } = require('../db');
const { ok, created, notFound, badRequest } = require('../lib/util');
const { requireAdmin } = require('../lib/auth');
const {
  DIFFICULTY_LEVELS, TRIP_FORMATS, ACCOMMODATION_TYPES, DURATION_BANDS,
  FINDER_DIFFICULTY, MONTHS, ACTIVITY_FIELDS,
  activityTypes, isKnownActivity, publicWhere, shapeAdventure,
  seasonCoversMonth, dimensionsFor, difficultyLevel,
} = require('../lib/adventures');

/** Comma-separated list of non-empty trimmed strings, or null. */
function csv(raw) {
  if (raw === undefined || raw === null) return null;
  const out = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  return out.length ? out : null;
}

/** Comma-separated list of whole numbers, or null if any token isn't one. */
function intCsv(raw) {
  const parts = csv(raw);
  if (!parts) return null;
  const out = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    out.push(Number(p));
  }
  return out;
}

const SORTS = {
  // "Featured" is not a column and deliberately is not random either: the
  // order is price descending, which puts the flagship expeditions first and
  // is stable between page loads. A `featured` flag an admin controls would
  // be better and is the obvious next step; inventing a scoring formula here
  // would just be an opinion dressed as data.
  featured: 'price_from_cents DESC, duration_days DESC',
  'price-asc': 'price_from_cents ASC',
  'price-desc': 'price_from_cents DESC',
  'duration-asc': 'duration_days ASC',
  'duration-desc': 'duration_days DESC',
  'difficulty-asc': 'difficulty_level ASC, duration_days ASC',
  'difficulty-desc': 'difficulty_level DESC, duration_days DESC',
  name: 'name ASC',
};

function register(router) {
  /* =====================================================================
     GET /api/activities
     The adventure categories. ?all=1 (admin) includes disabled ones.
     ===================================================================== */
  router.get('/api/activities', (req, res) => {
    const includeAll = req.query.all === '1';
    const rows = activityTypes({ enabledOnly: !includeAll });
    const { sql, params } = publicWhere('t');
    // Counts are of PUBLIC adventures, so a category reads 0 when everything
    // in it is unpublished — which is the number a visitor would see.
    const counts = Object.fromEntries(
      all(`SELECT t.activity a, COUNT(*) n FROM tours t WHERE ${sql} GROUP BY t.activity`, params)
        .map(r => [r.a, r.n])
    );
    return ok(res, {
      activities: rows.map(a => ({
        slug: a.slug,
        name: a.name,
        plural_label: a.plural_label || a.name,
        summary: a.summary,
        icon: a.icon,
        enabled: a.enabled === 1,
        adventure_count: counts[a.slug] || 0,
        difficulty_dimensions: dimensionsFor(a.slug),
        fields: ACTIVITY_FIELDS[a.slug] || [],
      })),
    });
  });

  /* =====================================================================
     GET /api/meta/filters

     Everything the filter UI, the finder and the difficulty guide need to
     render themselves, in one request. The point is that the frontend has
     no hardcoded list of activities, difficulty levels, trip formats,
     accommodation types, destinations or duration bands — enable a new
     activity in the admin panel and it appears in the filters without a
     frontend change. The brief's "single source of truth" applied to the
     vocabulary as well as to the data.
     ===================================================================== */
  router.get('/api/meta/filters', (req, res) => {
    const { sql, params } = publicWhere('t');
    const rows = all(`SELECT t.* FROM tours t WHERE ${sql}`, params);
    const seen = new Set();
    const destinations = [];
    for (const d of all('SELECT slug, name, region FROM destinations WHERE published = 1 ORDER BY sort_order, name')) {
      const count = rows.filter(r => r.destination_slug === d.slug).length;
      destinations.push({ slug: d.slug, name: d.name, region: d.region, adventure_count: count });
      seen.add(d.slug);
    }
    // A tour whose destination_slug points at nothing (or at an unpublished
    // destination) still has to be filterable, so its region is offered as
    // a plain region option. Without this an adventure can be invisible to
    // every destination filter and reachable only by clearing them.
    const orphanRegions = [...new Set(rows.filter(r => !seen.has(r.destination_slug)).map(r => r.region).filter(Boolean))];

    return ok(res, {
      activities: activityTypes({ enabledOnly: true }).map(a => ({
        slug: a.slug, name: a.name, plural_label: a.plural_label || a.name,
        adventure_count: rows.filter(r => r.activity === a.slug).length,
      })),
      difficulty_levels: DIFFICULTY_LEVELS.map(l => ({
        ...l, adventure_count: rows.filter(r => r.difficulty_level === l.level).length,
      })),
      duration_bands: DURATION_BANDS.map(b => ({
        ...b, adventure_count: rows.filter(r => r.duration_days >= b.min && r.duration_days <= b.max).length,
      })),
      trip_formats: TRIP_FORMATS.map(f => ({
        ...f, adventure_count: rows.filter(r => r.trip_format === f.key).length,
      })),
      accommodation_types: ACCOMMODATION_TYPES.map(a => ({
        ...a, adventure_count: rows.filter(r => r.accommodation_type === a.key).length,
      })),
      destinations,
      regions: orphanRegions,
      months: MONTHS.map((name, i) => ({
        month: i + 1, name,
        adventure_count: rows.filter(r => seasonCoversMonth(r.best_season, i + 1)).length,
      })),
      // Real bounds from real rows, so the price slider cannot be set to a
      // range that matches nothing.
      price: rows.length
        ? {
            min_cents: Math.min(...rows.map(r => r.price_from_cents)),
            max_cents: Math.max(...rows.map(r => r.price_from_cents)),
            currency: rows[0].currency || 'EUR',
          }
        : null,
      sorts: Object.keys(SORTS),
      total: rows.length,
    });
  });

  /* =====================================================================
     GET /api/adventures

     Filters, all optional, all combining with AND; multi-value ones take a
     comma-separated list and OR within themselves.

       activity=mountain-biking[,trekking]
       destination=<slug>[,...]      region=<text>[,...]
       difficulty=<1-5>[,...]
       duration=<band key>[,...]     minDuration= / maxDuration=
       format=small-group[,private,custom]
       accommodation=hotel[,lodge,teahouse,camping]
       month=<1-12>                  (reads best_season, see seasonCoversMonth)
       minPrice= / maxPrice=         (currency units, not cents)
       q=<text>                      (name, summary, region)
       sort=<one of SORTS>           limit= / offset=
     ===================================================================== */
  router.get('/api/adventures', (req, res) => {
    const q = req.query;
    const pub = publicWhere('t');
    let sql = `SELECT t.* FROM tours t WHERE ${pub.sql}`;
    const params = [...pub.params];

    if (q.activity) {
      const list = csv(q.activity);
      const unknown = list.filter(a => !isKnownActivity(a));
      if (unknown.length) return badRequest(res, `Unknown activity: ${unknown.join(', ')}`);
      sql += ` AND t.activity IN (${list.map(() => '?').join(',')})`;
      params.push(...list);
    }

    if (q.destination) {
      const list = csv(q.destination);
      sql += ` AND t.destination_slug IN (${list.map(() => '?').join(',')})`;
      params.push(...list);
    }
    if (q.region) {
      const list = csv(q.region);
      sql += ` AND t.region IN (${list.map(() => '?').join(',')})`;
      params.push(...list);
    }

    if (q.difficulty) {
      const levels = intCsv(q.difficulty);
      if (!levels || levels.some(l => l < 1 || l > 5)) {
        return badRequest(res, 'difficulty must be a comma-separated list of levels from 1 to 5');
      }
      sql += ` AND t.difficulty_level IN (${levels.map(() => '?').join(',')})`;
      params.push(...levels);
    }

    if (q.duration) {
      const keys = csv(q.duration);
      const bands = keys.map(k => DURATION_BANDS.find(b => b.key === k));
      if (bands.some(b => !b)) {
        return badRequest(res, `duration must be a comma-separated list of: ${DURATION_BANDS.map(b => b.key).join(', ')}`);
      }
      sql += ` AND (${bands.map(() => 't.duration_days BETWEEN ? AND ?').join(' OR ')})`;
      bands.forEach(b => params.push(b.min, b.max));
    }
    for (const [key, op] of [['minDuration', '>='], ['maxDuration', '<=']]) {
      if (!q[key]) continue;
      if (!/^\d+$/.test(q[key])) return badRequest(res, `${key} must be a whole number of days`);
      sql += ` AND t.duration_days ${op} ?`;
      params.push(Number(q[key]));
    }

    if (q.format) {
      const list = csv(q.format);
      const bad = list.filter(f => !TRIP_FORMATS.some(t => t.key === f));
      if (bad.length) return badRequest(res, `format must be one of: ${TRIP_FORMATS.map(t => t.key).join(', ')}`);
      sql += ` AND t.trip_format IN (${list.map(() => '?').join(',')})`;
      params.push(...list);
    }

    if (q.accommodation) {
      const list = csv(q.accommodation);
      const bad = list.filter(a => !ACCOMMODATION_TYPES.some(t => t.key === a));
      if (bad.length) return badRequest(res, `accommodation must be one of: ${ACCOMMODATION_TYPES.map(t => t.key).join(', ')}`);
      sql += ` AND t.accommodation_type IN (${list.map(() => '?').join(',')})`;
      params.push(...list);
    }

    for (const [key, op] of [['minPrice', '>='], ['maxPrice', '<=']]) {
      if (!q[key]) continue;
      if (!/^\d+(\.\d+)?$/.test(q[key])) return badRequest(res, `${key} must be a non-negative number`);
      sql += ` AND t.price_from_cents ${op} ?`;
      params.push(Math.round(Number(q[key]) * 100));
    }
    if (q.minPrice && q.maxPrice && Number(q.minPrice) > Number(q.maxPrice)) {
      return badRequest(res, 'minPrice cannot be greater than maxPrice');
    }

    if (q.maxAltitude) {
      if (!/^\d+$/.test(q.maxAltitude)) return badRequest(res, 'maxAltitude must be a whole number of metres');
      sql += ' AND (t.max_altitude_m IS NULL OR t.max_altitude_m <= ?)';
      params.push(Number(q.maxAltitude));
    }

    if (q.q) {
      const term = '%' + String(q.q).trim() + '%';
      if (term.length > 202) return badRequest(res, 'Search term is too long');
      sql += ' AND (t.name LIKE ? OR t.summary LIKE ? OR t.region LIKE ? OR t.description_full LIKE ?)';
      params.push(term, term, term, term);
    }

    const sort = q.sort || 'featured';
    if (!SORTS[sort]) return badRequest(res, `sort must be one of: ${Object.keys(SORTS).join(', ')}`);
    sql += ' ORDER BY ' + SORTS[sort];

    let rows = all(sql, params);

    // Month filtering happens here rather than in SQL because best_season is
    // free text ("Mar – May, Sep – Nov") that an admin types for display.
    // Parsing it in SQL is not realistic; parsing it in JS after the other
    // filters have already cut the set down is cheap.
    let month = null;
    if (q.month) {
      if (!/^\d{1,2}$/.test(q.month) || Number(q.month) < 1 || Number(q.month) > 12) {
        return badRequest(res, 'month must be a number from 1 to 12');
      }
      month = Number(q.month);
      rows = rows.filter(r => seasonCoversMonth(r.best_season, month));
    }

    const total = rows.length;
    const limit = q.limit ? Number(q.limit) : null;
    const offset = q.offset ? Number(q.offset) : 0;
    if (q.limit && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
      return badRequest(res, 'limit must be a whole number from 1 to 100');
    }
    if (q.offset && (!Number.isInteger(offset) || offset < 0)) {
      return badRequest(res, 'offset must be a non-negative whole number');
    }
    const page = limit ? rows.slice(offset, offset + limit) : rows.slice(offset);

    return ok(res, {
      adventures: page.map(r => shapeAdventure(r)),
      total,
      returned: page.length,
      offset,
      // Echoed back so the UI can show active filter chips and a result
      // count from the same response it rendered the cards from, instead of
      // re-deriving the filter state and risking the two disagreeing.
      filters: {
        activity: csv(q.activity), destination: csv(q.destination), region: csv(q.region),
        difficulty: intCsv(q.difficulty), duration: csv(q.duration), format: csv(q.format),
        accommodation: csv(q.accommodation), month,
        minPrice: q.minPrice ? Number(q.minPrice) : null,
        maxPrice: q.maxPrice ? Number(q.maxPrice) : null,
        q: q.q || null, sort,
      },
    });
  });

  /* =====================================================================
     GET /api/adventures/:slug — the full detail payload.

     Departures, guides, gallery and reviews are joined on, so the detail
     page is one request. The itinerary comes from tour_days; route
     waypoints stay on their own endpoint (see routes/waypoints.js) because
     a snapped leg's geometry is several KB and nothing on this page draws it.
     ===================================================================== */
  router.get('/api/adventures/:slug', (req, res) => {
    const pub = publicWhere('t');
    const row = get(`SELECT t.* FROM tours t WHERE t.slug = ? AND ${pub.sql}`, [req.params.slug, ...pub.params]);
    if (!row) return notFound(res, 'No such adventure');

    const adventure = shapeAdventure(row, { full: true });

    const days = all(
      `SELECT day_number, title, distance_km, elevation_gain_m, elevation_loss_m,
              high_point_m, riding_hours, terrain, overnight_place,
              description, accommodation, meals, notes
         FROM tour_days WHERE tour_id = ? ORDER BY day_number`,
      [row.id]
    );

    // is_custom = 0: a private custom-trip departure is a reservation for one
    // group and never appears on a public page (see schema.sql's comment).
    // Past dates are excluded here — a dates-and-prices section listing last
    // March is worse than listing nothing.
    const departures = all(
      `SELECT d.id, d.start_date, d.end_date, d.capacity, d.seats_booked, d.status,
              (d.capacity - d.seats_booked) AS seats_available,
              g.name AS guide_name
         FROM departures d
         LEFT JOIN guides g ON g.id = d.guide_id
        WHERE d.tour_id = ? AND d.is_custom = 0 AND date(d.start_date) >= date('now')
        ORDER BY d.start_date`,
      [row.id]
    );

    // Reviews are scored across five dimensions rather than one star rating,
    // so `rating` below is the mean of whichever dimensions the rider
    // actually filled in — not a column, and not an average over nulls
    // treated as zeros.
    const reviews = all(
      `SELECT id, rider_name, riding_score, guide_score, scenery_score,
              organization_score, accommodation_score, would_recommend, quote, created_at
         FROM reviews WHERE tour_id = ? ORDER BY created_at DESC LIMIT 12`,
      [row.id]
    ).map(r => {
      const scores = [r.riding_score, r.guide_score, r.scenery_score, r.organization_score, r.accommodation_score]
        .filter(s => Number.isFinite(s));
      return {
        ...r,
        rating: scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
      };
    });

    const gallery = all(
      `SELECT image_url, caption FROM gallery_images
        WHERE tour_id = ? AND category = 'tour' ORDER BY sort_order, id`,
      [row.id]
    );

    // Guides who lead this activity. A guide with no activities recorded is
    // included rather than hidden: an empty list means "nobody has filled
     // this in yet", not "leads nothing", and dropping the whole guides
    // section over a missing field would be the worse failure.
    const guides = all(
      `SELECT id, name, role, years_experience, languages, specialties, rating,
              trips_led, bio, photo_url, qualifications_json, activities_json
         FROM guides ORDER BY years_experience DESC`
    ).filter(g => {
      try {
        const acts = JSON.parse(g.activities_json || '[]');
        return !Array.isArray(acts) || acts.length === 0 || acts.includes(adventure.activity);
      } catch { return true; }
    }).map(g => {
      let quals = [];
      try { quals = JSON.parse(g.qualifications_json || '[]'); } catch { quals = []; }
      return {
        id: g.id, name: g.name, role: g.role, years_experience: g.years_experience,
        languages: g.languages, specialties: g.specialties, rating: g.rating,
        trips_led: g.trips_led, bio: g.bio, photo_url: g.photo_url,
        // Only verified qualifications are ever published. An admin can
        // record a claimed one without it appearing here until it is checked.
        qualifications: Array.isArray(quals) ? quals.filter(q => q && q.verified).map(q => q.title) : [],
      };
    });

    const destination = adventure.destination_slug
      ? get('SELECT slug, name, region, intro, hero_image_url FROM destinations WHERE slug = ? AND published = 1',
          [adventure.destination_slug])
      : null;

    // Site-wide FAQs that apply to this adventure, merged with the ones
    // written for it specifically. The adventure's own come first.
    const siteFaqs = all(
      `SELECT question, answer, category FROM faqs
        WHERE published = 1 AND (activity IS NULL OR activity = ?)
          AND (destination_slug IS NULL OR destination_slug = ?)
        ORDER BY category, sort_order`,
      [adventure.activity, adventure.destination_slug]
    );

    // Only reviews that actually carry a score count toward the average, and
    // if none do there is no average — an empty state, not a 0.0 or a NaN.
    const scored = reviews.filter(r => r.rating !== null);
    const ratings = scored.length
      ? {
          average: Math.round((scored.reduce((s, r) => s + r.rating, 0) / scored.length) * 10) / 10,
          count: scored.length,
          would_recommend: reviews.filter(r => r.would_recommend === 1).length,
          total_reviews: reviews.length,
        }
      : null;

    return ok(res, {
      ...adventure,
      days,
      departures,
      // Availability is never asserted beyond what the departures table
      // actually holds. No departures means "no dates currently open", which
      // is what the page says — not an invented date, and not "sold out".
      has_open_departures: departures.some(d => d.status === 'open' && d.seats_available > 0),
      reviews,
      ratings,
      gallery,
      guides,
      destination,
      site_faqs: siteFaqs,
      cancellation_rules: all('SELECT min_days_before_departure, refund_percent FROM cancellation_rules ORDER BY min_days_before_departure DESC'),
    });
  });

  /* =====================================================================
     GET /api/finder — the Adventure Finder's four answers, resolved to
     adventures.

       what=mountain-bike|trek|multi|surprise
       challenge=relaxed|moderate|challenging|tough
       time=under-7|7-10|11-14|15-plus
       month=1-12

     Anonymous, stateless and stores nothing. Every answer is optional so a
     partially answered finder still returns something useful, and the
     response reports which answers it had to relax in order to find
     anything — because "no exact matches, here is the nearest thing"
     is more use to a visitor than an empty page.
     ===================================================================== */
  const FINDER_ACTIVITY = {
    'mountain-bike': ['mountain-biking'],
    trek: ['trekking'],
    multi: ['multi-activity'],
    surprise: null, // no activity filter
  };

  router.get('/api/finder', (req, res) => {
    const { what, challenge, time, month } = req.query;

    if (what && !(what in FINDER_ACTIVITY)) {
      return badRequest(res, `what must be one of: ${Object.keys(FINDER_ACTIVITY).join(', ')}`);
    }
    if (challenge && !(challenge in FINDER_DIFFICULTY)) {
      return badRequest(res, `challenge must be one of: ${Object.keys(FINDER_DIFFICULTY).join(', ')}`);
    }
    if (time && !DURATION_BANDS.some(b => b.key === time)) {
      return badRequest(res, `time must be one of: ${DURATION_BANDS.map(b => b.key).join(', ')}`);
    }
    let monthNum = null;
    if (month) {
      if (!/^\d{1,2}$/.test(month) || Number(month) < 1 || Number(month) > 12) {
        return badRequest(res, 'month must be a number from 1 to 12');
      }
      monthNum = Number(month);
    }

    const pub = publicWhere('t');
    const rows = all(`SELECT t.* FROM tours t WHERE ${pub.sql}`, pub.params);

    const activities = what ? FINDER_ACTIVITY[what] : null;
    const levels = challenge ? FINDER_DIFFICULTY[challenge] : null;
    const band = time ? DURATION_BANDS.find(b => b.key === time) : null;

    const tests = [
      { name: 'activity', applies: !!activities, fn: r => activities.includes(r.activity) },
      { name: 'challenge', applies: !!levels, fn: r => levels.includes(r.difficulty_level) },
      { name: 'time', applies: !!band, fn: r => r.duration_days >= band.min && r.duration_days <= band.max },
      { name: 'month', applies: monthNum !== null, fn: r => seasonCoversMonth(r.best_season, monthNum) },
    ].filter(t => t.applies);

    const matching = rows.filter(r => tests.every(t => t.fn(r)));

    // Nothing matched everything. Rather than an empty result, relax one
    // answer at a time and report which — in a deliberate order, dropping
    // the least important answer first. Month is relaxed before duration,
    // duration before difficulty, and the activity is never dropped: someone
    // who asked for a trek does not want a bike trip, and pretending
    // otherwise is worse than saying there isn't one.
    const RELAX_ORDER = ['month', 'time', 'challenge'];
    let results = matching;
    const relaxed = [];
    if (!results.length) {
      const live = [...tests];
      for (const name of RELAX_ORDER) {
        const i = live.findIndex(t => t.name === name);
        if (i === -1) continue;
        live.splice(i, 1);
        relaxed.push(name);
        results = rows.filter(r => live.every(t => t.fn(r)));
        if (results.length) break;
      }
    }

    // Best fit first: closest to the requested difficulty, then price.
    const target = levels ? levels[levels.length - 1] : null;
    results = [...results].sort((a, b) => {
      if (target !== null) {
        const da = Math.abs(a.difficulty_level - target);
        const dbb = Math.abs(b.difficulty_level - target);
        if (da !== dbb) return da - dbb;
      }
      return a.price_from_cents - b.price_from_cents;
    });

    return ok(res, {
      adventures: results.map(r => shapeAdventure(r)),
      total: results.length,
      exact: relaxed.length === 0,
      relaxed,
      answers: { what: what || null, challenge: challenge || null, time: time || null, month: monthNum },
      // The questions themselves, so the finder UI is built from the model
      // rather than from a hardcoded copy of it that drifts.
      questions: [
        {
          key: 'what', question: 'What do you want to do?',
          options: [
            { key: 'mountain-bike', label: 'Mountain Bike' },
            { key: 'trek', label: 'Trek' },
            { key: 'multi', label: 'Multi-adventure' },
            { key: 'surprise', label: 'Surprise me' },
          ],
        },
        {
          key: 'challenge', question: 'How challenging?',
          options: Object.keys(FINDER_DIFFICULTY).map(k => ({
            key: k,
            label: k.charAt(0).toUpperCase() + k.slice(1),
            levels: FINDER_DIFFICULTY[k],
            meaning: (difficultyLevel(FINDER_DIFFICULTY[k][FINDER_DIFFICULTY[k].length - 1]) || {}).meaning || null,
          })),
        },
        {
          key: 'time', question: 'How much time?',
          options: DURATION_BANDS.map(b => ({ key: b.key, label: b.label })),
        },
        {
          key: 'month', question: 'When are you coming?',
          options: MONTHS.map((name, i) => ({ key: String(i + 1), label: name })),
        },
      ],
    });
  });

  /* =====================================================================
     POST /api/finder/save — the optional email capture under the results.

     The finder works without this and asks for nothing. This endpoint
     exists so that the "email me these" form is real rather than a dead
     input: it stores the answers against an address.

     It does NOT send an email, and the response says so in words the UI
     shows verbatim. No outbound mail is configured on this deployment (see
     lib/email.js), and a success message claiming an email is on its way
     would be exactly the fake confirmation the brief rules out.
     ===================================================================== */
  router.post('/api/finder/save', (req, res) => {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email) || email.length > 254) {
      return badRequest(res, 'Enter a valid email address');
    }
    const answers = b.answers && typeof b.answers === 'object' ? b.answers : {};
    const resultCount = Number.isInteger(b.resultCount) ? b.resultCount : null;

    run(
      `INSERT INTO finder_leads (email, activity, difficulty, duration, month, result_count, email_status)
       VALUES (?,?,?,?,?,?,'stored')`,
      [
        email,
        answers.what ? String(answers.what).slice(0, 40) : null,
        answers.challenge ? String(answers.challenge).slice(0, 40) : null,
        answers.time ? String(answers.time).slice(0, 40) : null,
        answers.month ? String(answers.month).slice(0, 40) : null,
        resultCount,
      ]
    );

    return created(res, {
      saved: true,
      email_sent: false,
      message: 'Saved. No email has been sent — outbound mail is not connected on this deployment, '
        + 'so your recommendations are stored against your address and the High Route team can pick them up. '
        + 'Keep the link to this page if you want to come back to the results.',
    });
  });

  /* =====================================================================
     Admin: activity types. This is how a new adventure category is enabled
     without a deploy.
     ===================================================================== */
  const { invalidateActivityCache } = require('../lib/adventures');

  router.get('/api/admin/activities', requireAdmin((req, res) => {
    const rows = all('SELECT * FROM activity_types ORDER BY sort_order, name');
    const counts = Object.fromEntries(
      all('SELECT activity a, COUNT(*) n FROM tours GROUP BY activity').map(r => [r.a, r.n])
    );
    return ok(res, {
      activities: rows.map(a => ({
        ...a,
        enabled: a.enabled === 1,
        adventure_count: counts[a.slug] || 0,
        // Whether lib/adventures.js has field definitions for this activity.
        // An activity enabled without them still works — it gets the
        // universal fields and the three default dimensions — but the admin
        // panel flags it so nobody wonders where the trekking fields went.
        has_field_definitions: !!ACTIVITY_FIELDS[a.slug],
        fields: ACTIVITY_FIELDS[a.slug] || [],
        difficulty_dimensions: dimensionsFor(a.slug),
      })),
    });
  }));

  router.post('/api/admin/activities', requireAdmin((req, res) => {
    const b = req.body || {};
    const slug = String(b.slug || '').trim().toLowerCase();
    const name = String(b.name || '').trim();
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) return badRequest(res, 'slug must be 2-40 lowercase letters, numbers or hyphens');
    if (!name) return badRequest(res, 'name is required');
    if (get('SELECT id FROM activity_types WHERE slug = ?', [slug])) {
      return badRequest(res, 'An activity with that slug already exists');
    }
    const info = run(
      `INSERT INTO activity_types (slug, name, plural_label, summary, icon, enabled, sort_order)
       VALUES (?,?,?,?,?,?,?)`,
      [slug, name, String(b.pluralLabel || name).trim() || name, b.summary ? String(b.summary).trim() : null,
       b.icon ? String(b.icon).trim() : null, b.enabled ? 1 : 0,
       Number.isInteger(b.sortOrder) ? b.sortOrder : 99]
    );
    invalidateActivityCache();
    return created(res, {
      activity: get('SELECT * FROM activity_types WHERE id = ?', [info.lastInsertRowid]),
      note: ACTIVITY_FIELDS[slug]
        ? null
        : 'This activity has no activity-specific field definitions yet. It works — adventures in it get the '
          + 'universal fields and the three default difficulty dimensions — but to give it its own fields '
          + '(walking hours, rapid grade and so on) add an entry for it to ACTIVITY_FIELDS in backend/lib/adventures.js.',
    });
  }));

  router.patch('/api/admin/activities/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM activity_types WHERE id = ?', [req.params.id]);
    if (!row) return notFound(res, 'No such activity');
    const b = req.body || {};
    const sets = [];
    const params = [];
    const text = (field, col, max = 200) => {
      if (b[field] === undefined) return null;
      const v = b[field] === null ? null : String(b[field]).trim().slice(0, max);
      sets.push(`${col} = ?`);
      params.push(v || null);
      return null;
    };
    text('name', 'name');
    text('pluralLabel', 'plural_label');
    text('summary', 'summary', 400);
    text('icon', 'icon', 40);
    if (b.enabled !== undefined) { sets.push('enabled = ?'); params.push(b.enabled ? 1 : 0); }
    if (b.sortOrder !== undefined) {
      if (!Number.isInteger(b.sortOrder)) return badRequest(res, 'sortOrder must be a whole number');
      sets.push('sort_order = ?'); params.push(b.sortOrder);
    }
    if (!sets.length) return badRequest(res, 'Nothing to update');

    // Disabling an activity hides every adventure in it from the public
    // site at a stroke, so say how many rather than letting an admin find
    // out from the listing.
    const affected = b.enabled === false || b.enabled === 0
      ? get('SELECT COUNT(*) n FROM tours WHERE activity = ? AND published = 1', [row.slug]).n
      : 0;

    params.push(row.id);
    run(`UPDATE activity_types SET ${sets.join(', ')} WHERE id = ?`, params);
    invalidateActivityCache();
    return ok(res, {
      activity: get('SELECT * FROM activity_types WHERE id = ?', [row.id]),
      hidden_adventures: affected,
      note: affected ? `${affected} published adventure(s) in this category are now hidden from the public site.` : null,
    });
  }));

  router.delete('/api/admin/activities/:id', requireAdmin((req, res) => {
    const row = get('SELECT * FROM activity_types WHERE id = ?', [req.params.id]);
    if (!row) return notFound(res, 'No such activity');
    const inUse = get('SELECT COUNT(*) n FROM tours WHERE activity = ?', [row.slug]).n;
    // Deleting a category that adventures are filed under would orphan them:
    // they would keep an `activity` value no longer in activity_types, which
    // publicWhere() excludes, so they would vanish from the site with no
    // obvious cause. Refuse and say what to do instead.
    if (inUse) {
      return badRequest(res, `${inUse} adventure(s) still use this activity. Move them to another activity first, `
        + 'or disable this one instead of deleting it — disabling keeps the data and hides the category.');
    }
    run('DELETE FROM activity_types WHERE id = ?', [row.id]);
    invalidateActivityCache();
    return ok(res, { deleted: true });
  }));

  /* =====================================================================
     Admin: the Adventure Finder's saved leads. Read-only — these are
     people's email addresses, and the panel needs to show them, not edit them.
     ===================================================================== */
  router.get('/api/admin/finder-leads', requireAdmin((req, res) => ok(res, {
    leads: all('SELECT * FROM finder_leads ORDER BY created_at DESC LIMIT 200'),
    total: get('SELECT COUNT(*) n FROM finder_leads').n,
  })));
}

module.exports = { register };
